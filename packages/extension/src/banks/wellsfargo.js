import { autoLogin, enterTextedCode, withDebugger, jitter } from "../login.js";
import { getSyncPlan, refreshLastTxDates, toLocalDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncWellsFargo(settings, accountMappings, accountKey, options = {}) {
    console.log("Wells Fargo: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await refreshLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, lastTxDates, accountMappings[accountKey]);
    if (!plan) {
        console.warn("WF: no sync start date configured, skipping.");
        return;
    }
    const { endDate: today } = plan;
    const [y, m, d] = today.split("-").map(Number);
    const maxStart = new Date(Date.UTC(y, m - 1 - 25, d)).toISOString().slice(0, 10);
    const startDate = plan.startDate < maxStart ? maxStart : plan.startDate;
    console.log(`WF sync: ${startDate} → ${today}`);
    reportProgress(options, 15, "Waiting for Wells Fargo");

    const mapped = accountMappings[accountKey];
    if (!mapped) return;

    const tab = await openTabBackground("https://www.wellsfargo.com/");

    const wfAccountId = accountKey.slice("wf-".length);

    let transactions = [];
    let wfBalance = null;

    try {
        let wfData;
        try {
            wfData = await pollForWFData(tab.id, wfAccountId, (t, msg) => {
                reportProgress(options, 15 + Math.round(t * 35), msg ?? "Logging in…");
            });
            console.log("WF account ID:", wfData.accountId);
        } catch (err) {
            console.error("WF: login failed, giving up.");
            return;
        }
        wfBalance = wfData.balance;

        reportProgress(options, 55, "Fetching transactions");
        const listRes = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_WF_TRANSACTIONS",
            reqUrl: wfData.reqUrl,
        }).catch(() => null);
        if (!listRes || listRes.error) {
            console.error("WF fetch failed:", listRes?.error ?? "no response");
            return;
        }
        const { transactions: base, additionalDetailsUrl } = mapWFTransactions(listRes.data, startDate, today);

        const detailIds = base.filter(t => t.showAdditionalData).map(t => t.id);
        let categories = {};
        if (additionalDetailsUrl && detailIds.length) {
            const BATCH = 10;
            for (let i = 0; i < detailIds.length; i += BATCH) {
                const batch = detailIds.slice(i, i + BATCH);
                const done = Math.min(i + BATCH, detailIds.length);
                console.log(`WF: fetching categories ${i + 1}–${done} of ${detailIds.length}`);
                reportProgress(options, 70 + Math.round((done / detailIds.length) * 10),
                    `Fetching categories (${done}/${detailIds.length})`);
                const res = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_WF_CATEGORIES",
                    additionalDetailsUrl,
                    transactionIds: batch,
                }).catch(() => null);
                Object.assign(categories, res?.categories || {});
            }
        }

        // Key dedup off referenceNumber: WF's `id` is a per-session UUID that
        // changes between syncs, so `wf-${id}` re-imports the same transaction
        // every time. referenceNumber is the stable bank reference (unique and
        // present on every row, and shared across an auth→post transition).
        // `id` is still used in-session for the category detail lookup above.
        transactions = base.map(t => ({
            date: t.date,
            amount: t.amount,
            payee_name: t.payee_name,
            category: categories[t.id] || undefined,
            imported_id: t.referenceNumber ? `wf-${t.referenceNumber}` : (t.id != null ? `wf-${t.id}` : undefined),
        }));
    } finally {
        chrome.tabs.remove(tab.id);
    }

    try {
        const isFirstSync = !lastSyncDates[accountKey];
        let result = {};
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`WF: importing ${transactions.length} transactions.`);
            (result = await importTransactions("WF", settings, mapped, transactions, accountKey,
                (frac, msg) => reportProgress(options, 80 + Math.round(frac * 20), msg)));
        } else {
            console.log("WF: no new transactions.");
        }
        if (wfBalance != null) {
            await logBalanceDrift("WF", accountKey, options.appBalances?.[accountKey], result.byApp, -wfBalance);
            await applyActualStartingBalance("WF", settings, mapped, { mappingKey: accountKey, bankBalance: -wfBalance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "wf-starting-balance" });
        }
        await updateLastSyncStats(accountKey, transactions);
        if (result.failures?.length) throw new Error(result.failures.join("; "));
        await updateLastSyncDate(accountKey, today);

        reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
    } catch (err) {
        console.error("WF import failed:", err.message);
    }
}

const WF_STATE_LABELS = {
    "click-card": "Selecting account…",
    "load-transactions": "Loading transactions…",
};

function installWFInterceptor() {
    if (window._wfIntercepted) return;
    window._wfIntercepted = true;

    const isTxnUrl = (url) => typeof url === "string" && url.includes("/transactions/fetch");

    const _fetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
            if (isTxnUrl(url)) window._wfReqUrl = url;
        } catch {}
        return _fetch.apply(this, args);
    };

    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try { if (isTxnUrl(url)) window._wfReqUrl = url; } catch {}
        return _open.call(this, method, url, ...rest);
    };
}

// The where-to-text list (Work/Mobile/Home, WF texts as soon as one is
// pressed), then the code box.
const WF_CODE = {
    from: /wells\s*fargo/i,
    sendButton: '[class*="AuthMethodList__listItemButton"]',
    sendButtonText: /mobile/i,
    codeBox: "#otp",
};

function pollForWFData(tabId, wfAccountId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let wfState = "click-card";
        let wfBalance = null;
        let interceptorReady = false;
        let lastClickTime = 0;
        let busy = false;   // autoLogin takes seconds; don't let ticks overlap it
        let loginAttempted = false;
        let codeAttempted = false;
        let loginAt = 0;
        let shownToUser = false;

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            const elapsed = Date.now() - start;
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99), WF_STATE_LABELS[wfState]);
            try {
                const tab = await chrome.tabs.get(tabId);
                console.log("WF state:", wfState, "url:", tab.url);

                const onWFPage = tab.url?.includes("wellsfargo.com") && (
                    tab.url.includes("accountsummary") ||
                    tab.url.includes("accountdetails")
                );
                if (!onWFPage) {
                    dataPageStart = null;
                    // Signing in: type the saved login once on the homepage box.
                    // WF then asks where to text a code; the code is read off
                    // Google Messages and entered once. If that fails (or the
                    // code screen is still up after), the window comes up for
                    // the user. Also comes up 20s after the last submit, or
                    // after 15s if no password field showed.
                    if (!shownToUser && tab.status === "complete" && tab.url?.includes("wellsfargo.com")) {
                        const [probe] = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => ({
                                password: !!document.querySelector("#password"),
                                codeScreen: !!document.querySelector('[class*="AuthMethodList__"], #otp'),
                            }),
                        });
                        const { password, codeScreen } = probe?.result || {};
                        if (password && !loginAttempted) {
                            loginAttempted = true;   // one auto-login per sync; a bad password falls to the user
                            loginAt = await autoLogin(tabId, "wellsfargo") ? Date.now() : 0;
                        }
                        if (codeScreen && !codeAttempted) {
                            codeAttempted = true;
                            if (await enterTextedCode(tabId, "WF", WF_CODE)) {
                                loginAt = Date.now();
                                return;
                            }
                        }
                        const giveUp = codeScreen
                            || (loginAttempted ? Date.now() - loginAt > 20000 : Date.now() - start > 15000);
                        if (giveUp) {
                            shownToUser = true;
                            console.log(codeScreen ? "WF: code required; waiting for you to enter it..." : "WF: waiting for login...");
                            chrome.tabs.update(tabId, { active: true });
                            chrome.windows.update(tab.windowId, { state: "normal", focused: true });
                        }
                    }
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    removeGuard();
                    reject(new Error("Timed out waiting for WF data"));
                    return;
                }

                if (tab.status !== "complete") return;

                if (wfState === "click-card") {
                    if (tab.url?.includes("accountdetails")) {
                        wfState = "load-transactions";
                    } else if (tab.url?.includes("accountsummary") && Date.now() - lastClickTime > 5000) {
                        lastClickTime = Date.now();
                        const result = await chrome.scripting.executeScript({
                            target: { tabId },
                            world: "MAIN",
                            args: [wfAccountId],
                            func: (accountId) => {
                                const summary = window._wfPayload?.applicationData?.accountSummary;
                                if (!summary) return null;
                                const account = summary.accounts?.find(a => a.accountId === accountId && a.type === "credit")
                                    ?? summary.accounts?.find(a => a.type === "credit");
                                if (!account) return null;
                                const productName = account.accountProfile?.accountProductName;
                                const btn = document.querySelector(`[data-testid="${productName}-title"]`)?.closest("button");
                                if (!btn) return null;
                                btn.click();
                                const outstanding = account.balance?.find(b => b.type === "OUTSTANDING");
                                return { balance: outstanding != null ? Math.round(outstanding.amount * 100) : null };
                            },
                        });
                        const payload = result?.[0]?.result;
                        if (payload) {
                            wfBalance = payload.balance;
                        }
                    }

                } else if (wfState === "load-transactions" && tab.url?.includes("accountdetails")) {
                    if (!interceptorReady) {
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            world: "MAIN",
                            injectImmediately: true,
                            func: installWFInterceptor,
                        });
                        interceptorReady = true;
                    }

                    // A minimized, unfocused page never sends the transactions
                    // request; with focus emulated (debugger attached) it does.
                    // Not found within 10s → the next tick clicks again.
                    const readReqUrl = async () => (await chrome.scripting.executeScript({
                        target: { tabId },
                        world: "MAIN",
                        func: () => window._wfReqUrl ?? null,
                    }))?.[0]?.result;
                    const reqUrl = await withDebugger(tabId, async () => {
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            world: "MAIN",
                            func: () => {
                                window._wfReqUrl = null;
                                document.getElementById("filter-ALL")?.click();
                            },
                        });
                        for (const deadline = Date.now() + 10000; Date.now() < deadline; await jitter(250, 250)) {
                            const url = await readReqUrl();
                            if (url) return url;
                        }
                        return null;
                    }).catch(() => readReqUrl());
                    if (reqUrl) {
                        clearInterval(interval);
                        removeGuard();
                        resolve({ accountId: wfAccountId, balance: wfBalance, reqUrl });
                    }
                }
            } catch {
                // Tab not ready yet
            } finally {
                busy = false;
            }
        }, POLL_INTERVAL_MS);

        const removeGuard = onTabClose(tabId, () => {
            clearInterval(interval);
            reject(new Error("Browser window closed"));
        });
    });
}

export async function getWellsFargoAccountsForPopup() {
    const tab = await openTabBackground("https://www.wellsfargo.com/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { state: "normal", focused: true });

    try {
        return await pollForWFAccounts(tab.id);
    } catch (err) {
        throw new Error("Timed out waiting for Wells Fargo login");
    } finally {
        chrome.tabs.remove(tab.id);
    }
}

function pollForWFAccounts(tabId) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                removeGuard();
                reject(new Error("Timed out waiting for Wells Fargo accounts"));
                return;
            }

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status !== "complete") return;
                if (!tab.url?.includes("accountsummary")) return;

                const result = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: "MAIN",
                    func: () => {
                        const summary = window._wfPayload?.applicationData?.accountSummary;
                        if (!summary) return null;
                        return (summary.accounts ?? [])
                            .filter(a => a.type === "credit")
                            .map(a => ({
                                id: a.accountId,
                                name: a.accountProfile?.accountProductName ?? "Credit Card",
                                lastFour: a.maskedNumber?.replace(/\.\.\./g, ""),
                            }));
                    },
                });

                const accounts = result?.[0]?.result;
                if (accounts?.length > 0) {
                    clearInterval(interval);
                    removeGuard();
                    resolve(accounts);
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);

        const removeGuard = onTabClose(tabId, () => {
            clearInterval(interval);
            reject(new Error("Browser window closed"));
        });
    });
}

function mapWFTransactions(listResponse, startDate, endDate) {
    const data = listResponse?.transactions?.transactionData ?? listResponse?.transactionData;
    const rows = data?.transactions || [];
    const additionalDetailsUrl = data?.additionalDetailsUrl || null;

    const seen = new Set();
    const transactions = [];
    for (const tx of rows) {
        // Dedup within the response on referenceNumber (the stable key) so an
        // auth + posted pair sharing one reference collapses to a single row.
        const dedupKey = tx.referenceNumber ?? tx.id;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const date = toLocalDate(tx.postDate);
        if (!date || date < startDate || date > endDate) continue;

        const raw = Number(tx.transactionAmount);
        if (Number.isNaN(raw)) continue;

        const sign = String(tx.debitCreditType).toUpperCase() === "CREDIT" ? 1 : -1;
        transactions.push({
            id: tx.id,
            referenceNumber: tx.referenceNumber,
            showAdditionalData: tx.showAdditionalData,
            date,
            amount: Math.round(raw * 100) * sign,
            payee_name: (tx.transactionDescription || "").trim(),
        });
    }

    return { transactions, additionalDetailsUrl };
}
