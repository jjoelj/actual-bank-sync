import { getSyncPlan, seedLastTxDates, pacificDate, toLocalDate, getDateChunks, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncFidelity(settings, accountMappings, accountKey, options = {}) {
    console.log("Fidelity: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await seedLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
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
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let fidelityData;
    let rawTransactions;

    try {
        try {
            fidelityData = await pollForFidelityData(tab.id, (t, msg) => {
                reportProgress(options, 15 + Math.round(t * 35), msg ?? "Logging in…");
            });
        } catch (err) {
            console.error("Fidelity: login failed, giving up.");
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
        chrome.tabs.remove(tab.id);
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

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            const elapsed = Date.now() - start;
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99), FIDELITY_STATE_LABELS[fidelityState]);
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
                        chrome.tabs.onCreated.addListener(function createdListener() {
                            chrome.tabs.onCreated.removeListener(createdListener);
                            fidelityState = "await-redirect";
                        });
                        chrome.tabs.onUpdated.addListener(function ssoListener(updatedTabId, changeInfo) {
                            if (!changeInfo.url?.includes("fidelityrewards.com")) return;
                            chrome.tabs.onUpdated.removeListener(ssoListener);
                            fidelityState = "get-data";
                            const url = changeInfo.url;
                            chrome.tabs.update(trackingTabId, { url });
                            if (updatedTabId !== trackingTabId) chrome.tabs.remove(updatedTabId);
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
