import { isoDate, offsetDate, alreadySyncedToday, openTabBackground, parseCsvLine, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from "../utils.js";
import { sendToHost } from '../host.js'
import { updateLastSyncDate } from '../utils.js'

export async function syncBilt(settings, accountMappings, retried = false) {
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates["bilt-credit"] || syncFromDate;

    if (!startDate) {
        console.warn("SoFi: no sync start date configured, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);

    if (alreadySyncedToday(lastSyncDates, "bilt-credit")) {
        console.log("Bilt: already synced today, skipping.");
        return;
    }

    console.log(`Bilt sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings["bilt-credit"];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://www.bilt.com/wallet");

    let biltData;
    try {
        biltData = await pollForBiltData(tab.id);
    } catch (err) {
        if (retried) {
            console.error("Bilt: login failed after retry, giving up.");
            return;
        }
        await syncBilt(settings, accountMappings, true);
        return;
    }

    let csvData;
    try {
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
        console.log(`Bilt: importing ${transactions.length} transactions.`);
        await sendToHost("importTransactions", {
            settings,
            accountId: actualAccountId,
            transactions,
        });
    } else {
        console.log("Bilt: no new transactions.");
    }

    await updateLastSyncDate("bilt-credit", today);
}

function pollForBiltData(tabId) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Bilt data"));
                return;
            }

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
