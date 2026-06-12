import { getSyncPlan, seedLastTxDates, toLocalDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncWellsFargo(settings, accountMappings, accountKey, options = {}) {
    console.log("Wells Fargo: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await seedLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
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
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

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
            reportProgress(options, 70, `Fetching ${detailIds.length} categories`);
            const res = await chrome.tabs.sendMessage(tab.id, {
                type: "FETCH_WF_CATEGORIES",
                additionalDetailsUrl,
                transactionIds: detailIds,
            }).catch(() => null);
            categories = res?.categories || {};
        }

        transactions = base.map(t => ({
            date: t.date,
            amount: t.amount,
            payee_name: t.payee_name,
            category: categories[t.id] || undefined,
            imported_id: t.id != null ? `wf-${t.id}` : undefined,
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
            logBalanceDrift("WF", options.appBalances?.[accountKey], result.byApp, -wfBalance);
            await applyActualStartingBalance("WF", settings, mapped, { bankBalance: -wfBalance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "wf-starting-balance" });
        }
        await updateLastSyncStats(accountKey, transactions);

        reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
    } catch (err) {
        console.error("WF import failed:", err.message);
    }

    await updateLastSyncDate(accountKey, today);
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

function pollForWFData(tabId, wfAccountId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let wfState = "click-card";
        let wfBalance = null;
        let interceptorReady = false;

        const interval = setInterval(async () => {
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

                if (wfState === "click-card" && tab.url?.includes("accountsummary")) {
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
                        wfState = "load-transactions";
                    }

                } else if (wfState === "load-transactions" && tab.url?.includes("accountdetails")) {
                    if (!interceptorReady) {
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            world: "MAIN",
                            injectImmediately: true,
                            func: installWFInterceptor,
                        });
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            world: "MAIN",
                            func: () => {
                                window._wfReqUrl = null;
                                document.getElementById("filter-ALL")?.click();
                            },
                        });
                        interceptorReady = true;
                    }

                    const result = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: "MAIN",
                        func: () => window._wfReqUrl ?? null,
                    });
                    const reqUrl = result?.[0]?.result;
                    if (reqUrl) {
                        clearInterval(interval);
                        removeGuard();
                        resolve({ accountId: wfAccountId, balance: wfBalance, reqUrl });
                    }
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

export async function getWellsFargoAccountsForPopup() {
    const tab = await openTabBackground("https://www.wellsfargo.com/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

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
        if (seen.has(tx.id)) continue;
        seen.add(tx.id);

        const date = toLocalDate(tx.postDate);
        if (!date || date < startDate || date > endDate) continue;

        const raw = Number(tx.transactionAmount);
        if (Number.isNaN(raw)) continue;

        const sign = String(tx.debitCreditType).toUpperCase() === "CREDIT" ? 1 : -1;
        transactions.push({
            id: tx.id,
            showAdditionalData: tx.showAdditionalData,
            date,
            amount: Math.round(raw * 100) * sign,
            payee_name: (tx.transactionDescription || "").trim(),
        });
    }

    return { transactions, additionalDetailsUrl };
}
