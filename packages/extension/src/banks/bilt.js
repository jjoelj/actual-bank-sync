import { getSyncPlan, pacificDate, openTabBackground, parseCsvLine, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, getDateChunks, applyStartingBalance } from "../utils.js";

export async function syncBilt(settings, accountMappings, accountKey, options = {}) {
    console.log("Bilt: starting");
    const { lastSyncDates = {}, syncFromDate, startingBalances = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "startingBalances"]);
    const isFirstSync = !lastSyncDates[accountKey] || startingBalances[accountKey] === undefined;
    let plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, options);
    if (!plan) {
        console.warn("Bilt: no sync start date configured, skipping.");
        return;
    }
    if (isFirstSync) plan = { ...plan, shouldSync: true, startDate: syncFromDate ?? plan.startDate };
    if (!plan.shouldSync) {
        console.log("Bilt: already synced today, skipping.");
        return;
    }
    const { startDate, endDate: today } = plan;
    const fetchEnd = pacificDate(new Date());

    console.log(`Bilt sync: ${startDate} → ${fetchEnd}`);
    reportProgress(options, 15, "Waiting for Bilt");

    const actualAccountId = accountMappings[accountKey];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://www.bilt.com/wallet");

    let transactions = [];
    let currentBalance = null;

    try {
        let biltData;
        try {
            biltData = await pollForBiltData(tab.id, (t) => {
                reportProgress(options, 15 + Math.round(t * 35), "Logging in…");
            });
        } catch (err) {
            console.error("Bilt: login failed, giving up.");
            return;
        }

        try {
            reportProgress(options, 55, "Fetching transactions");
            const chunks = getDateChunks(startDate, fetchEnd, 180);
            for (const [chunkStart, chunkEnd] of chunks) {
                const fetchResult = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_BILT_TRANSACTIONS",
                    cardId: biltData.cardId,
                    startDate: chunkStart,
                    endDate: chunkEnd,
                    accessToken: biltData.accessToken,
                });
                if (fetchResult.error) throw new Error(fetchResult.error);
                transactions.push(...parseBiltCsv(fetchResult.data));
            }
        } catch (err) {
            console.error("Bilt fetch failed:", err.message);
            return;
        }

        const balResult = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_BILT_BALANCE",
            cardId: biltData.cardId,
            accessToken: biltData.accessToken,
        });
        if (balResult.error) {
            console.warn("Bilt: failed to fetch balance:", balResult.error);
        } else {
            currentBalance = balResult.balance;
        }
    } finally {
        chrome.tabs.remove(tab.id);
    }

    if (transactions.length > 0) {
        reportProgress(options, 80, `Importing ${transactions.length} transactions`);
        console.log(`Bilt: importing ${transactions.length} transactions.`);
        await importTransactions("Bilt", settings, actualAccountId, transactions);
    } else {
        console.log("Bilt: no new transactions.");
    }
    await updateLastSyncStats(accountKey, transactions);
    await updateLastSyncDate(accountKey, today);

    if (currentBalance != null) {
        await applyStartingBalance("Bilt", accountKey, { settings, accountId: actualAccountId, transactions, accountBalance: -currentBalance, isFirstSync, startDate, importedId: "bilt-starting-balance" });
    }

    reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
}


function pollForBiltData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Bilt data"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const response = await chrome.tabs.sendMessage(tabId, { type: "GET_BILT_DATA" });
                if (response?.accessToken && response?.cardId) {
                    clearInterval(interval);
                    resolve(response);
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function parseBiltCsv(csv) {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    const transactions = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        // Transaction Date,Posted Date,Description,Amount,Card Last 4,Name on Card,Raw Merchant Name
        const [txDate, postedDate, description, amountStr] = cols;

        if (!amountStr || !txDate) continue;

        const amount = Math.round(parseFloat(amountStr) * 100) * -1;
        if (!postedDate || !postedDate.trim()) continue;
        const date = postedDate.trim();
        const importedId = `bilt-${date}-${amountStr.trim()}-${description.trim()}`;

        transactions.push({
            date,
            amount,
            payee_name: description.trim(),
            imported_id: importedId,
        });
    }

    return transactions;
}
