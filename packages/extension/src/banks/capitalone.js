import { isoDate, offsetDate, alreadySyncedToday, openTabBackground, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../utils.js";
import { sendToHost } from "../host.js";
import { updateLastSyncDate } from "../utils.js"

export async function syncCapitalOne(settings, accountMappings, accountKey) {
    console.log("Capital One: starting");
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates[accountKey] || syncFromDate;

    if (!startDate) {
        console.warn("Capital One: no sync start date configured, skipping.");
        return;
    }

    if (alreadySyncedToday(lastSyncDates, accountKey)) {
        console.log("Capital One: already synced today, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);
    console.log(`Capital One sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings[accountKey];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://myaccounts.capitalone.com/accountSummary");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    let accountId;
    try {
        accountId = await pollForCapitalOneData(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        console.error("Capital One: login failed, giving up.");
        return;
    }

    chrome.tabs.remove(tab.id);

    try {
        const transactions = await fetchCapitalOneTransactions(accountId, startDate, today);
        if (transactions.length > 0) {
            console.log(`Capital One: importing ${transactions.length} transactions.`);
            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
        } else {
            console.log("Capital One: no new transactions.");
        }
    } catch (err) {
        console.error("Capital One failed:", err.message);
    }

    await updateLastSyncDate(accountKey, today);
}

function pollForCapitalOneData(tabId) {
    return new Promise((resolve, reject) => {
        let dataPageStart = null;

        const interval = setInterval(async () => {
            try {
                const tab = await chrome.tabs.get(tabId);

                if (!tab.url?.includes("myaccounts.capitalone.com")) {
                    dataPageStart = null;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    reject(new Error("Timed out waiting for Capital One data"));
                    return;
                }

                const result = await chrome.tabs.sendMessage(tabId, { type: "GET_CAPITALONE_DATA" });
                if (result?.accountId) {
                    clearInterval(interval);
                    resolve(result.accountId);
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

async function fetchCapitalOneTransactions(accountId, startDate, endDate) {
    const encodedId = encodeURIComponent(encodeURIComponent(accountId));
    const url = `https://myaccounts.capitalone.com/web-api/protected/17463/credit-cards/accounts/${encodedId}/transactions/download?fromTransactionDate=${startDate}&toTransactionDate=${endDate}&documentFormatType=application/csv&acceptLanguage=en-US&X-User-Action=ease.downloadTransactions`;
    console.log("Capital One: fetching", url);
    const response = await fetch(url, {
        headers: {
            accept: "application/json;v=1",
            "accept-language": "en-US",
            "x-user-action": "ease.downloadTransactions",
            "x-ui-routing-id": "Card/REFID/DownloadTransactions",
        },
        credentials: "include",
    });

    if (!response.ok) throw new Error(`Capital One export failed: ${response.status}`);

    const csv = await response.text();
    return parseCapitalOneCsv(csv);
}

function parseCapitalOneCsv(csv) {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    const transactions = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        // Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
        const [, postedDate, , description, category, debit, credit] = cols;

        if (!postedDate || !postedDate.trim()) continue;
        const date = postedDate.trim();
        let amount;

        if (debit && debit.trim()) {
            amount = Math.round(parseFloat(debit.trim()) * 100) * -1;
        } else if (credit && credit.trim()) {
            amount = Math.round(parseFloat(credit.trim()) * 100);
        } else {
            continue;
        }

        transactions.push({
            date,
            amount,
            payee_name: description.trim(),
            notes: category.trim(),
            imported_id: `capitalone-${date}-${amount}-${category.trim()}`,
        });
    }

    return transactions;
}
