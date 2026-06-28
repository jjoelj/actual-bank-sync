import { getSyncPlan, seedLastTxDates, pacificDate, toLocalDate, openTabBackground, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, getDateChunks, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncBilt(settings, accountMappings, accountKey, options = {}) {
    console.log("Bilt: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await seedLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, lastTxDates, accountMappings[accountKey]);
    if (!plan) {
        console.warn("Bilt: no sync start date configured, skipping.");
        return;
    }
    const { startDate, endDate: today } = plan;
    const fetchEnd = pacificDate(new Date());

    console.log(`Bilt sync: ${startDate} → ${fetchEnd}`);
    reportProgress(options, 15, "Waiting for Bilt");

    const mapped = accountMappings[accountKey];
    if (!mapped) return;

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
                transactions.push(...mapBiltTransactions(fetchResult.transactions));
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

    const isFirstSync = !lastSyncDates[accountKey];
    let result = {};
    try {
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`Bilt: importing ${transactions.length} transactions.`);
            (result = await importTransactions("Bilt", settings, mapped, transactions, accountKey,
                (frac, msg) => reportProgress(options, 80 + Math.round(frac * 20), msg)));
        } else {
            console.log("Bilt: no new transactions.");
        }
        await updateLastSyncStats(accountKey, transactions, result.byApp);
        if (result.failures?.length) throw new Error(result.failures.join("; "));
        if (currentBalance != null) {
            await logBalanceDrift("Bilt", accountKey, options.appBalances?.[accountKey], result.byApp, -currentBalance);
            await applyActualStartingBalance("Bilt", settings, mapped, { mappingKey: accountKey, bankBalance: -currentBalance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "bilt-starting-balance" });
        }
        // Only mark the account synced when every mapped app imported cleanly,
        // so a failed app is retried by the next sync.
        await updateLastSyncDate(accountKey, today);
    } catch (err) {
        console.error("Bilt import failed:", err.message);
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
                removeGuard();
                reject(new Error("Timed out waiting for Bilt data"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const response = await chrome.tabs.sendMessage(tabId, { type: "GET_BILT_DATA" });
                if (response?.accessToken && response?.cardId) {
                    clearInterval(interval);
                    removeGuard();
                    resolve(response);
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

function mapBiltTransactions(rawTransactions) {
    const transactions = [];

    for (const tx of rawTransactions || []) {
        const date = toLocalDate(tx.updatedAt);
        const amountNum = parseFloat(tx.amount?.amount);
        if (!date || Number.isNaN(amountNum)) continue;

        const payee = tx.description || tx.merchant?.name || "Unknown";
        const payeeName = typeof payee === "string" ? payee.trim() : "Unknown";
        const amount = Math.round(amountNum * 100) * -1;

        transactions.push({
            date,
            amount,
            payee_name: payeeName,
            category: tx.merchant?.category || tx.displayCategory || undefined,
            imported_id: tx.id != null ? `bilt-${tx.id}` : `bilt-${date}-${amount}-${payeeName}`,
        });
    }

    return transactions;
}
