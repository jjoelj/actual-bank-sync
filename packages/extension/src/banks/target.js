import { getSyncPlan, seedLastTxDates, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncTarget(settings, accountMappings, accountKey, options = {}) {
    console.log("Target: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await seedLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, lastTxDates, accountMappings[accountKey]);
    if (!plan) {
        console.warn("Target: no sync start date configured, skipping.");
        return;
    }
    const { startDate, endDate: today } = plan;
    console.log(`Target sync: ${startDate} → ${today}`);
    reportProgress(options, 15, "Waiting for Target");

    const mapped = accountMappings[accountKey];
    if (!mapped) return;

    const tab = await openTabBackground("https://mytargetcirclecard.target.com/account/transaction-history");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let transactions;
    let balance = null;

    try {
        let targetData;
        try {
            targetData = await pollForTargetData(tab.id, (t) => {
                reportProgress(options, 15 + Math.round(t * 35), "Logging in…");
            });
        } catch (err) {
            console.error("Target: login failed, giving up.");
            return;
        }

        try {
            reportProgress(options, 55, "Fetching transactions");
            const result = await chrome.tabs.sendMessage(tab.id, {
                type: "FETCH_TARGET_TRANSACTIONS",
                csrfToken: targetData.csrfToken,
                bankId: targetData.bankId,
                startDate,
                endDate: today,
            });
            if (result.error) throw new Error(result.error);
            transactions = parseTargetTransactions(result.data);

            const balanceResult = await chrome.tabs.sendMessage(tab.id, {
                type: "FETCH_TARGET_BALANCE",
                csrfToken: targetData.csrfToken,
                bankId: targetData.bankId,
            });
            if (balanceResult.error) {
                console.warn("Target: failed to get balance:", balanceResult.error);
            } else {
                balance = balanceResult.balance;
            }
        } catch (err) {
            console.error("Target fetch failed:", err.message);
            return;
        }
    } finally {
        chrome.tabs.remove(tab.id);
    }

    const isFirstSync = !lastSyncDates[accountKey];
    let result = {};
    try {
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`Target: importing ${transactions.length} transactions.`);
            (result = await importTransactions("Target", settings, mapped, transactions, accountKey,
                (frac, msg) => reportProgress(options, 80 + Math.round(frac * 20), msg)));
        } else {
            console.log("Target: no new transactions.");
        }
        await updateLastSyncStats(accountKey, transactions);
        if (result.failures?.length) throw new Error(result.failures.join("; "));
        if (balance != null) {
            await logBalanceDrift("Target", accountKey, options.appBalances?.[accountKey], result.byApp, -balance);
            await applyActualStartingBalance("Target", settings, mapped, { mappingKey: accountKey, bankBalance: -balance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "target-starting-balance" });
        }

        await updateLastSyncDate(accountKey, today);

    } catch (err) {
        console.error("Target import failed:", err.message);
    }

    reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
}

function pollForTargetData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let busy = false;
        let pendingAction = false;

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            const elapsed = Date.now() - start;
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));
            try {
                const tab = await chrome.tabs.get(tabId);

                if (!tab.url?.includes("mytargetcirclecard.target.com")) {
                    dataPageStart = null;
                    pendingAction = false;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    removeGuard();
                    reject(new Error("Timed out waiting for Target data"));
                    return;
                }

                if (tab.status !== "complete") {
                    pendingAction = false;
                    return;
                }
                if (pendingAction) return;

                const result = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: "MAIN",
                    func: () => {
                        const bankId = window.GLOBAL_VARIABLES?.bankId;
                        const csrfInput = document.querySelector('input[name="ecs-csrf-value"]');
                        return { bankId, csrfToken: csrfInput?.value };
                    },
                });

                const { bankId, csrfToken } = result?.[0]?.result || {};

                if (!bankId) return;

                if (tab.url?.includes("mytargetcirclecard.target.com/home")) {
                    pendingAction = true;
                    chrome.tabs.update(tabId, { url: "https://mytargetcirclecard.target.com/account/transaction-history" });
                    return;
                }

                if (bankId && csrfToken) {
                    clearInterval(interval);
                    removeGuard();
                    resolve({ bankId, csrfToken });
                } else if (bankId && !csrfToken) {
                    const csrfResult = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => fetch(location.href, { credentials: "include" })
                            .then(r => r.text())
                            .then(t => t.match(/ecs-csrf-value[^>]*value="([^"]+)"/)?.[ 1]),
                    });
                    const csrfFromSource = csrfResult?.[0]?.result;
                    if (bankId && csrfFromSource) {
                        clearInterval(interval);
                        removeGuard();
                        resolve({ bankId, csrfToken: csrfFromSource });
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

function parseTargetTransactions(data) {
    const transactions = data?.transactionList || data?.transactions || [];

    return transactions.filter(tx => {
        if (tx.transactionId === "0") return false;
        if (tx.transactionAmount === 0) return false;
        return true;
    }).map(tx => {
        const amount = Math.round(tx.transactionAmount * 100) * -1;

        const cardMasked = tx.transactedPresentationInstrumentIdentifier?.maskedValue
            || tx.transactionAccountNumber?.maskedValue;
        const cardLast4 = cardMasked?.slice(-4);

        return {
            date: tx.transactionDate,
            amount,
            payee_name: tx.description?.trim(),
            notes: cardLast4 ? `**${cardLast4}` : undefined,
            imported_id: tx.transactionId ? `target-${tx.transactionId}` : undefined,
        };
    });
}
