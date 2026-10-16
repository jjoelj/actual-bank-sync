import { autoLogin } from "../login.js";
import { getSyncPlan, refreshLastTxDates, pacificDate, toLocalDate, getDateChunks, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncFidelity(settings, accountMappings, accountKey, options = {}) {
    console.log("Fidelity: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await refreshLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, lastTxDates, accountMappings[accountKey]);
    if (!plan) {
        console.warn("Fidelity: no sync start date configured, skipping.");
        return;
    }
    const { startDate, endDate: today } = plan;
    const todayStr = pacificDate(new Date());
    console.log(`Fidelity sync: ${startDate} → ${todayStr}`);
    reportProgress(options, 15, "Waiting for Fidelity");

    const mapped = accountMappings[accountKey];
    if (!mapped) return;

    const tab = await openTabBackground("https://digital.fidelity.com/ftgw/digital/portfolio/summary");

    let fidelityData;
    let rawTransactions;

    try {
        try {
            fidelityData = await pollForFidelityData(tab.id, (t, msg) => {
                reportProgress(options, 15 + Math.round(t * 35), msg ?? "Logging in…");
            });
        } catch (err) {
            console.warn("Fidelity: login failed, giving up.");
            return;
        }

        try {
            reportProgress(options, 55, "Fetching transactions");
            const chunks = getDateChunks(startDate, todayStr, 90);
            const seen = new Set();
            rawTransactions = [];
            for (const [chunkStart, chunkEnd] of chunks) {
                const result = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_FIDELITY_TRANSACTIONS",
                    accessToken: fidelityData.accessToken,
                    accountToken: fidelityData.accountToken,
                    startDate: chunkStart,
                    endDate: chunkEnd,
                });
                if (result.error) throw new Error(result.error);
                for (const tx of result.transactions) {
                    const key = tx.transactionUniqueId || `${tx.transactionDateTime}|${tx.transactionAmount}|${tx.description}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    rawTransactions.push(tx);
                }
            }
        } catch (err) {
            console.error("Fidelity fetch failed:", err.message);
            return;
        }
    } finally {
        chrome.tabs.remove(tab.id).catch(() => {});   // may already be closed
    }

    let currentBalance = null;
    try {
        currentBalance = await fetchFidelityBalance(fidelityData.accessToken, fidelityData.accountToken);
    } catch (err) {
        console.warn("Fidelity: failed to fetch balance:", err.message);
    }

    const transactions = mapFidelityTransactions(rawTransactions);
    const isFirstSync = !lastSyncDates[accountKey];
    let result = {};

    try {
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`Fidelity: importing ${transactions.length} transactions.`);
            (result = await importTransactions("Fidelity", settings, mapped, transactions, accountKey,
                (frac, msg) => reportProgress(options, 80 + Math.round(frac * 20), msg)));
        } else {
            console.log("Fidelity: no new transactions.");
        }
        await updateLastSyncStats(accountKey, transactions);
        if (result.failures?.length) throw new Error(result.failures.join("; "));
        if (currentBalance != null) {
            await logBalanceDrift("Fidelity", accountKey, options.appBalances?.[accountKey], result.byApp, -currentBalance);
            await applyActualStartingBalance("Fidelity", settings, mapped, { mappingKey: accountKey, bankBalance: -currentBalance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "fidelity-starting-balance" });
        }

            await updateLastSyncDate(accountKey, today);
    } catch (err) {
        console.error("Fidelity import failed:", err.message);
    }

    reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
}

async function fetchFidelityBalance(accessToken, accountToken) {
    const response = await fetch("https://api.usbank.com/partner-services/graphql/v1", {
        method: "POST",
        headers: {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            aftokenvalue: "null",
            "application-id": "RPCAD",
            authorization: `Bearer ${accessToken}`,
            "client-application": "RPCWEB",
            "content-type": "application/json",
            customergroupid: "ELAN",
            customerpartnerid: "fid",
            customerpartnerloc: "24193",
            routingkey: "",
        },
        body: JSON.stringify({
            query: `query accounts($accountInput: AccountInput) {
  accounts(accountInput: $accountInput) {
    ... on CreditAccount { balances { currentBalance } }
  }
}`,
            variables: {
                accountInput: {
                    accountTokens: [accountToken],
                    identifierType: "ACCOUNTTOKEN",
                },
            },
        }),
    });
    if (!response.ok) throw new Error(`Fidelity balance failed: ${response.status}`);
    const json = await response.json();
    const balance = json?.data?.accounts?.[0]?.balances?.currentBalance;
    if (balance == null) throw new Error("currentBalance not found");
    return Math.round(balance * 100);
}

const FIDELITY_STATE_LABELS = {
    "click-card": "Selecting card…",
    "click-download": "Downloading transactions…",
    "await-redirect": "Awaiting SSO redirect…",
    "get-data": "Loading transaction data…",
};

function pollForFidelityData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let trackingTabId = tabId;
        let listenerRegistered = false;
        let fidelityState = "click-card";
        let busy = false;
        let lastClickTime = 0;
        let loginAttempted = false;
        let loginAt = 0;
        let shownToUser = false;
        let status = null;   // sign-in steps; the state labels take over after
        // Progress moves by step, never back; waiting on the user doesn't advance it.
        let progress = 0;
        const say = (msg, frac) => {
            status = msg;
            if (frac != null) progress = Math.max(progress, frac);
            onTick?.(progress, msg);
        };

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            onTick?.(progress, status ?? FIDELITY_STATE_LABELS[fidelityState]);
            try {
                const tab = await chrome.tabs.get(trackingTabId);
                console.log("fidelity state:", fidelityState, "url:", tab.url, "status:", tab.status);

                const onFidelityPage = tab.url?.includes("digital.fidelity.com") || tab.url?.includes("login.fidelityrewards.com");
                if (!onFidelityPage) {
                    dataPageStart = null;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    removeGuard();
                    reject(new Error("Timed out waiting for Fidelity data"));
                    return;
                }

                if (tab.status !== "complete") return;

                // Sign-in (and any MFA step) lives under /prgw/: type the saved
                // login once; come to the front 20s after that submit, or after
                // 15s there if no password field ever showed.
                if (tab.url?.includes("digital.fidelity.com/prgw/")) {
                    status ??= "Signing in…";
                    if (!loginAttempted) {
                        const [probe] = await chrome.scripting.executeScript({
                            target: { tabId: trackingTabId },
                            func: () => !!document.querySelector("#dom-pswd-input"),
                        });
                        if (probe?.result) {
                            loginAttempted = true;   // one auto-login per sync; a bad password falls to the user
                            say("Signing in with saved login…", 0.3);
                            loginAt = await autoLogin(trackingTabId, "fidelity") ? Date.now() : 0;
                        }
                    }
                    const giveUp = loginAttempted ? Date.now() - loginAt > 20000 : Date.now() - dataPageStart > 15000;
                    if (!shownToUser && giveUp) {
                        shownToUser = true;
                        say("Sign in in the Fidelity window");
                        console.log("Fidelity: waiting for login...");
                        chrome.tabs.update(trackingTabId, { active: true });
                        chrome.windows.update(tab.windowId, { state: "normal", focused: true });
                    }
                    return;
                }
                status = null;   // signed in
                progress = Math.max(progress, 0.5);

                if (fidelityState === "click-card" && tab.url?.includes("digital.fidelity.com")) {
                    if (/#\d{4}/.test(tab.url)) {
                        fidelityState = "click-download";
                        lastClickTime = 0;
                    } else if (Date.now() - lastClickTime > 5000) {
                        lastClickTime = Date.now();
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const link = Array.from(document.querySelectorAll("a[id]"))
                                    .find(a => /^\d{4}$/.test(a.id));
                                link?.click();
                            },
                        });
                    }
                } else if ((fidelityState === "click-download" || fidelityState === "await-redirect") && tab.url?.includes("digital.fidelity.com")) {
                    if (fidelityState === "await-redirect") return;
                    if (!listenerRegistered) {
                        listenerRegistered = true;
                        // "Download transactions" opens the rewards hand-off in a
                        // new tab, which Edge shows. Pull it into the sync window
                        // and re-minimize: only its URL is needed (ssoListener).
                        // ponytail: it can still flash for a moment; stopping the
                        // new tab altogether means rewriting Fidelity's link.
                        chrome.tabs.onCreated.addListener(async function createdListener(newTab) {
                            if (newTab.openerTabId !== trackingTabId) return;   // not ours (e.g. a tab you opened)
                            chrome.tabs.onCreated.removeListener(createdListener);
                            fidelityState = "await-redirect";
                            try {
                                const { windowId } = await chrome.tabs.get(trackingTabId);
                                if (newTab.windowId !== windowId) await chrome.tabs.move(newTab.id, { windowId, index: -1 });
                                await chrome.windows.update(windowId, { state: "minimized" });
                            } catch (err) {
                                console.warn("Fidelity: couldn't hide the hand-off tab:", err.message);
                            }
                        });
                        chrome.tabs.onUpdated.addListener(function ssoListener(updatedTabId, changeInfo) {
                            if (!changeInfo.url?.includes("fidelityrewards.com")) return;
                            // The hand-off can pass through newSSO with an empty
                            // token (ssoToken=&ssoPayload={}) before the real one;
                            // following that leaves the page blank.
                            if (changeInfo.url.includes("/newSSO") && !/[?&]ssoToken=[^&]/.test(changeInfo.url)) return;
                            chrome.tabs.onUpdated.removeListener(ssoListener);
                            fidelityState = "get-data";
                            const url = changeInfo.url;
                            chrome.tabs.update(trackingTabId, { url });
                            if (updatedTabId !== trackingTabId) chrome.tabs.remove(updatedTabId).catch(() => {});   // may already be closed
                        });
                    }

                    if (Date.now() - lastClickTime > 5000) {
                        lastClickTime = Date.now();
                        await chrome.scripting.executeScript({
                                target: { tabId: trackingTabId },
                                world: "MAIN",
                                func: () => {
                                    const link = Array.from(document.querySelectorAll("a"))
                                        .find(l => l.textContent.includes("Download transactions") && l.closest(".dwnld-btn-desktop"));
                                    link?.scrollIntoView();
                                    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                                },
                            });
                    }
                } else if (fidelityState === "get-data" && tab.url?.includes("login.fidelityrewards.com/digital/servicing")) {
                    const result = await chrome.tabs.sendMessage(tabId, { type: "GET_FIDELITY_DATA" });
                    if (result?.accessToken && result?.accountToken) {
                        clearInterval(interval);
                        removeGuard();
                        resolve(result);
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

function mapFidelityTransactions(rawTransactions) {
    const mapped = [];

    for (const tx of rawTransactions || []) {
        if (tx.pendingFlag || tx.transactionStatus === "PENDING") continue;

        const date = toLocalDate(tx.transactionDateTime || tx.effectiveDate || tx.postedDateTime);
        const rawAmount = parseFloat(tx.transactionAmount);
        if (!date || Number.isNaN(rawAmount)) continue;

        const sign = String(tx.debitCredit).toUpperCase() === "CREDIT" ? 1 : -1;
        const amount = Math.round(rawAmount * 100) * sign;
        const payee_name = tx.description || tx.merchantDetails?.name || "Unknown";
        const category = tx.enrichedDetails?.category || undefined;

        mapped.push({ date, amount, payee_name, category, fp: `${date}|${amount}|${payee_name}`, hasCategory: Boolean(category) });
    }

    // ELAN returns an enriched (categorized) and a non-enriched copy of each
    // transaction with different IDs; drop the non-enriched twin when a
    // categorized one exists, keeping genuinely uncategorized rows.
    const categorizedFps = new Set(mapped.filter(t => t.hasCategory).map(t => t.fp));
    return mapped
        .filter(t => t.hasCategory || !categorizedFps.has(t.fp))
        .map(({ date, amount, payee_name, category }) => ({ date, amount, payee_name, category, imported_id: `fidelity-${date}-${amount}-${payee_name}` }));
}
