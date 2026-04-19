import { getSyncPlan, openTabBackground, parseCsvLine, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncCount, updateLastSyncMetrics } from "../utils.js";
import { sendToHost } from '../host.js';

export async function syncBilt(settings, accountMappings, accountKey, options = {}) {
    console.log("Bilt: starting");
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, options);
    if (!plan) {
        console.warn("Bilt: no sync start date configured, skipping.");
        return;
    }
    if (!plan.shouldSync) {
        console.log("Bilt: already synced today, skipping.");
        return;
    }
    const { startDate, endDate: today, isForced } = plan;

    console.log(`Bilt sync: ${startDate} → ${today}`);
    reportProgress(options, 15, "Waiting for Bilt");

    const actualAccountId = accountMappings[accountKey];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://www.bilt.com/wallet");

    let biltData;
    try {
        biltData = await pollForBiltData(tab.id, (t) => {
            reportProgress(options, 15 + Math.round(t * 35), "Logging in…");
        });
    } catch (err) {
        console.error("Bilt: login failed, giving up.");
        return;
    }

    let csvData;
    try {
        reportProgress(options, 55, "Fetching transactions");
        const fetchResult = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_BILT_TRANSACTIONS",
            cardId: biltData.cardId,
            startDate,
            endDate: today,
            accessToken: biltData.accessToken,
        });
        if (fetchResult.error) throw new Error(fetchResult.error);
        csvData = fetchResult.data;
    } catch (err) {
        console.error("Bilt fetch failed:", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    chrome.tabs.remove(tab.id);

    const transactions = parseBiltCsv(csvData);
    if (transactions.length > 0) {
        reportProgress(options, 80, `Importing ${transactions.length} transactions`);
        console.log(`Bilt: importing ${transactions.length} transactions.`);
        await sendToHost("importTransactions", {
            settings,
            accountId: actualAccountId,
            transactions,
        });
    } else {
        console.log("Bilt: no new transactions.");
    }
    await updateLastSyncCount(accountKey, transactions.length);
    await updateLastSyncMetrics(accountKey, transactions);
    reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
    if (!isForced) await updateLastSyncDate(accountKey, today);
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
