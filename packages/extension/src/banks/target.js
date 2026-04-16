import { isoDate, offsetDate, alreadySyncedToday, openTabBackground, waitForTabClose, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, updateLastSyncDate } from "../utils.js";
import { sendToHost } from "../host.js";

export async function syncTarget(settings, accountMappings, retried = false) {
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates["target-credit"] || syncFromDate;

    if (!startDate) {
        console.warn("Target: no sync start date configured, skipping.");
        return;
    }

    if (alreadySyncedToday(lastSyncDates, "target-credit")) {
        console.log("Target: already synced today, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);
    console.log(`Target sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings["target-credit"];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://mytargetcirclecard.target.com/account/transaction-history");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let targetData;
    try {
        targetData = await pollForTargetData(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        if (retried) {
            console.error("Target: login failed after retry, giving up.");
            return;
        }
        const tab2 = await openTabBackground("https://mytargetcirclecard.target.com/account/transaction-history");
        chrome.tabs.update(tab2.id, { active: true });
        chrome.windows.update(tab2.windowId, { focused: true });
        console.log("Target: waiting for login...");
        await waitForTabClose(tab2.id);
        await syncTarget(settings, accountMappings, true);
        return;
    }

    let transactions;
    try {
        const result = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_TARGET_TRANSACTIONS",
            csrfToken: targetData.csrfToken,
            bankId: targetData.bankId,
            startDate,
            endDate: today,
        });
        if (result.error) throw new Error(result.error);
        transactions = parseTargetTransactions(result.data);
    } catch (err) {
        console.error("Target fetch failed:", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    chrome.tabs.remove(tab.id);

    try {
        if (transactions.length > 0) {
            console.log(`Target: importing ${transactions.length} transactions.`);
            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
        } else {
            console.log("Target: no new transactions.");
        }
    } catch (err) {
        console.error("Target import failed:", err.message);
    }

    await updateLastSyncDate("target-credit", today);
}

function pollForTargetData(tabId) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Target data"));
                return;
            }

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === "complete" && tab.url?.includes("mytargetcirclecard.target.com/home")) {
                    chrome.tabs.update(tabId, { url: "https://mytargetcirclecard.target.com/account/transaction-history" });
                    return;
                }

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

                if (bankId && csrfToken) {
                    clearInterval(interval);
                    resolve({ bankId, csrfToken });
                } else if (bankId && !csrfToken) {
                    // Try fetching CSRF from page source
                    const csrfResult = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => fetch(location.href, { credentials: "include" })
                            .then(r => r.text())
                            .then(t => t.match(/ecs-csrf-value[^>]*value="([^"]+)"/)?.[ 1]),
                    });
                    const csrfFromSource = csrfResult?.[0]?.result;
                    if (bankId && csrfFromSource) {
                        clearInterval(interval);
                        resolve({ bankId, csrfToken: csrfFromSource });
                    }
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function parseTargetTransactions(data) {
    const transactions = data?.transactionList || data?.transactions || [];

    return transactions.filter(tx => {
        if (tx.transactionId === "0") return false;
        if (tx.transactionAmount === 0) return false;
        return true;
    }).map(tx => {
        const isCredit = tx.transactionCode?.display === "Credit" || tx.transactionCode?.display === "Payment";
        const amount = Math.round(tx.transactionAmount * 100) * (isCredit ? 1 : -1);

        return {
            date: tx.transactionDate,
            amount,
            payee_name: tx.description?.trim(),
            notes: tx.transactionCode?.display,
            imported_id: `target-${tx.transactionId}`,
        };
    });
}
