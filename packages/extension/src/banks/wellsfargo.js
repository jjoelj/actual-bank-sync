import { getSyncPlan, openTabBackground, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, applyStartingBalance } from "../utils.js";

export async function syncWellsFargo(settings, accountMappings, accountKey, options = {}) {
    console.log("Wells Fargo: starting");
    const { lastSyncDates = {}, syncFromDate, startingBalances = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "startingBalances"]);
    const isFirstSync = !lastSyncDates[accountKey] || startingBalances[accountKey] === undefined;
    let plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, options);
    if (!plan) {
        console.warn("WF: no sync start date configured, skipping.");
        return;
    }
    if (isFirstSync) plan = { ...plan, shouldSync: true, startDate: syncFromDate ?? plan.startDate };
    if (!plan.shouldSync) {
        console.log("WF: already synced today, skipping.");
        return;
    }
    const { endDate: today } = plan;
    const [y, m, d] = today.split("-").map(Number);
    const maxStart = new Date(Date.UTC(y, m - 1 - 25, d)).toISOString().slice(0, 10);
    const startDate = plan.startDate < maxStart ? maxStart : plan.startDate;
    console.log(`WF sync: ${startDate} → ${today}`);
    reportProgress(options, 15, "Waiting for Wells Fargo");

    const actualAccountId = accountMappings[accountKey];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://www.wellsfargo.com/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    const wfAccountId = accountKey.slice("wf-".length);

    let wfData;
    let csvData;

    try {
        try {
            wfData = await pollForWFData(tab.id, wfAccountId, (t, msg) => {
                reportProgress(options, 15 + Math.round(t * 35), msg ?? "Logging in…");
            });
            console.log("WF account ID:", wfData.accountId);
        } catch (err) {
            console.error("WF: login failed, giving up.");
            return;
        }

        // Format dates as MM/DD/YYYY for WF
        const fromDate = formatWFDate(startDate);
        const toDate = formatWFDate(today);

        try {
            reportProgress(options, 55, "Fetching transactions");
            const result = await chrome.tabs.sendMessage(tab.id, {
                type: "FETCH_WF_TRANSACTIONS",
                accountId: wfData.accountId,
                xatoken: wfData.xatoken,
                startDate: fromDate,
                endDate: toDate,
            });
            if (result.error) throw new Error(result.error);
            csvData = result.data;
        } catch (err) {
            console.error("WF fetch failed:", err.message);
            return;
        }
    } finally {
        chrome.tabs.remove(tab.id);
    }

    try {
        const transactions = parseWFCsv(csvData);
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`WF: importing ${transactions.length} transactions.`);
            await importTransactions("WF", settings, actualAccountId, transactions);
        } else {
            console.log("WF: no new transactions.");
        }
        await updateLastSyncStats(accountKey, transactions);

        if (wfData.balance != null) {
            try {
                await applyStartingBalance("WF", accountKey, { settings, accountId: actualAccountId, transactions, accountBalance: -wfData.balance, isFirstSync, startDate, importedId: "wf-starting-balance" });
            } catch (err) {
                console.warn("WF: failed to verify starting balance:", err.message);
            }
        }

        reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
    } catch (err) {
        console.error("WF import failed:", err.message);
    }

    await updateLastSyncDate(accountKey, today);
}

const WF_STATE_LABELS = {
    "click-card": "Selecting account…",
    "click-download": "Navigating to download…",
    "get-data": "Downloading transactions…",
};

function pollForWFData(tabId, wfAccountId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let wfState = "click-card";
        let wfBalance = null;
        let clickedDownload = false;

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99), WF_STATE_LABELS[wfState]);
            try {
                const tab = await chrome.tabs.get(tabId);
                console.log("WF state:", wfState, "url:", tab.url);

                const onWFPage = tab.url?.includes("wellsfargo.com") && (
                    tab.url.includes("accountsummary") ||
                    tab.url.includes("accountdetails") ||
                    tab.url.includes("download-accountactivity")
                );
                if (!onWFPage) {
                    dataPageStart = null;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
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
                        wfState = "click-download";
                    }

                } else if (wfState === "click-download" && tab.url?.includes("accountdetails")) {
                    if (!clickedDownload) {
                        const clicked = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const btn = document.querySelector('[data-testid="download-account-activity-link"]');
                                if (btn) { btn.click(); return true; }
                                return false;
                            },
                        });
                        if (clicked?.[0]?.result) {
                            clickedDownload = true;
                            wfState = "get-data";
                        }
                    }

                } else if (wfState === "get-data" && tab.url?.includes("download-accountactivity")) {
                    const urlObj = new URL(tab.url);
                    const xatoken = urlObj.searchParams.get("_xa");
                    const accountId = urlObj.searchParams.get("accountId") ?? wfAccountId;
                    if (xatoken && accountId) {
                        clearInterval(interval);
                        resolve({ accountId, xatoken, balance: wfBalance });
                    }
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
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
                    resolve(accounts);
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function formatWFDate(isoStr) {
    const [year, month, day] = isoStr.split("-");
    return `${month}/${day}/${year}`;
}

function parseWFCsv(csv) {
    const lines = csv.trim().split("\n");
    const transactions = [];

    for (const line of lines) {
        const cols = parseCsvLine(line);
        // "DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"
        const date = cols[0]?.replace(/"/g, "").trim();
        const description = cols[1]?.replace(/"/g, "").trim();
        const amountStr = cols[2]?.replace(/"/g, "").trim();

        if (!date || !amountStr || date === "DATE") continue;

        const raw = parseFloat(amountStr);
        if (isNaN(raw)) continue;
        // WF: positive = payment/credit, negative = charge
        const amount = Math.round(raw * 100);

        transactions.push({
            date: formatISODate(date),
            amount,
            payee_name: description,
            imported_id: `wf-${date}-${amountStr}-${description}`,
        });
    }

    return transactions;
}

function formatISODate(mmddyyyy) {
    const [month, day, year] = mmddyyyy.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
