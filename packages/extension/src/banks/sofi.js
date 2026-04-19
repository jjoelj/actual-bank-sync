import { getDateChunks, getSyncPlan, parseCsvLine, openTabBackground, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncCount, updateLastSyncMetrics } from "../utils.js";
import { sendToHost } from '../host.js';

export async function syncSoFi(settings, accountMappings, options = {}) {
    console.log("SoFi: starting");
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);

    // Check if all mapped SoFi accounts have already been synced today
    const sofiKeys = Object.keys(accountMappings).filter(k => k.startsWith("sofi-"));
    const plans = Object.fromEntries(sofiKeys.map(k => [k, getSyncPlan(lastSyncDates, syncFromDate, k, options)]));
    const allSyncedToday = sofiKeys.length > 0 && sofiKeys.every(k => !plans[k]?.shouldSync);

    if (allSyncedToday) {
        console.log("SoFi: all accounts already synced today, skipping.");
        return;
    }

    // Open SoFi tab in background, wait for Apollo state
    const activeKeys = sofiKeys.filter(k => plans[k]?.shouldSync);
    const tab = await openTabBackground("https://www.sofi.com/my/banking/accounts/");
    activeKeys.forEach(k => reportProgress(options, k, 15, "Opening SoFi…"));

    let apolloState;
    try {
        apolloState = await pollForApolloState(tab.id, (t) => {
            activeKeys.forEach(k => reportProgress(options, k, 15 + Math.round(t * 30), "Logging in…"));
        });
    } catch (err) {
        console.error("SoFi: login failed, giving up.", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    // Extract accounts from Apollo state
    const sofiAccounts = extractSoFiAccounts(apolloState);

    if (sofiAccounts.length === 0) {
        console.warn("SoFi: no accounts found in Apollo state.");
        chrome.tabs.remove(tab.id);
        return;
    }

    activeKeys.forEach(k => reportProgress(options, k, 47, "Getting account data…"));

    // Get CSRF token from content script
    let csrfToken;
    try {
        csrfToken = await getCsrfFromTab(tab.id);
    } catch (err) {
        console.error("SoFi: failed to get CSRF token:", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    chrome.tabs.remove(tab.id);

    // For each SoFi account that has a mapping, fetch and import
    for (const account of sofiAccounts) {
        const mappingKey = `sofi-${account.id}`;
        const actualAccountId = accountMappings[mappingKey];
        if (!actualAccountId) continue;
        const plan = plans[mappingKey];
        if (!plan) {
            console.warn(`SoFi ${account.id}: no sync start date configured, skipping.`);
            continue;
        }
        if (!plan.shouldSync) {
            console.log(`SoFi ${account.id}: already synced today, skipping.`);
            continue;
        }
        const { startDate, endDate: today, isForced } = plan;

        console.log(`SoFi ${account.id} sync: ${startDate} → ${today}`);

        try {
            reportProgress(options, mappingKey, 55, "Fetching transactions");
            const transactions = await fetchSoFiTransactions(
                account.id,
                csrfToken,
                startDate,
                today
            );

            if (!isForced) await updateLastSyncDate(mappingKey, today);
            await updateLastSyncCount(mappingKey, transactions.length);
            await updateLastSyncMetrics(mappingKey, transactions);

            if (transactions.length === 0) {
                reportProgress(options, mappingKey, 100, "No new transactions");
                console.log(`SoFi ${account.id}: no new transactions.`);
                continue;
            }

            reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
            console.log(`SoFi ${account.id}: importing ${transactions.length} transactions.`);

            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
            reportProgress(options, mappingKey, 100, `Imported ${transactions.length}`);
        } catch (err) {
            console.error(`SoFi account ${account.id} failed:`, err.message);
        }
    }

    const creditKey = "sofi-credit";
    const creditActualId = accountMappings[creditKey];
    scope: if (creditActualId) {
        const creditPlan = getSyncPlan(lastSyncDates, syncFromDate, creditKey, options);
        if (!creditPlan) {
            console.warn(`SoFi Credit: no sync start date configured, skipping.`);
            break scope
        }
        if (!creditPlan.shouldSync) {
            console.log(`SoFi Credit: already synced today, skipping.`);
            break scope
        }
        const { startDate, endDate: today, isForced } = creditPlan;

        console.log(`SoFi Credit sync: ${startDate} → ${today}`);

        try {
            reportProgress(options, creditKey, 55, "Fetching transactions");
            const transactions = await fetchSoFiCreditTransactions(startDate, today);
            if (transactions.length > 0) {
                reportProgress(options, creditKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`SoFi credit: importing ${transactions.length} transactions.`);
                await sendToHost("importTransactions", {
                    settings,
                    accountId: creditActualId,
                    transactions,
                });
            } else {
                console.log("SoFi credit: no new transactions.");
            }
            await updateLastSyncCount(creditKey, transactions.length);
            await updateLastSyncMetrics(creditKey, transactions);
            if (!isForced) await updateLastSyncDate(creditKey, today);
            reportProgress(options, creditKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error("SoFi credit failed:", err.message);
        }
    }

}

async function fetchSoFiCreditTransactions(startDate, endDate) {
    const chunks = getDateChunks(startDate, endDate, 89);
    const allTransactions = [];

    for (const [chunkStart, chunkEnd] of chunks) {
        const startISO = new Date(chunkStart).toISOString().replace(/T.*/, "T06:00:00.000Z");
        const endISO = new Date(chunkEnd).toISOString().replace(/T.*/, "T05:00:00.000Z");

        const url = `https://www.sofi.com/credit-card-servicing/api/public/v1/transactions/export?startDate=${startISO}&endDate=${endISO}`;
        console.log("SoFi Credit: fetching", url);
        const response = await fetch(url, {
            headers: { accept: "text/csv" },
            credentials: "include",
        });

        if (!response.ok) {
            const text = await response.text();
            if (text.includes("No transactions found")) return [];
            throw new Error(`SoFi credit export failed: ${response.status}`);
        }

        const csv = await response.text();
        allTransactions.push(...parseSoFiCreditCsv(csv));
    }

    return allTransactions;
}

function parseSoFiCreditCsv(csv) {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    const transactions = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        // Transaction Date,Post Date,Description,Category,Type,Amount
        const [, postDate, description, category, type, amountStr] = cols;

        if (!amountStr) continue;

        // Flip sign: sales are positive in CSV but should be negative in Actual (expense)
        const amount = Math.round(parseFloat(amountStr) * 100) * -1;
        if (!postDate || !postDate.trim()) continue;
        const date = postDate.trim();
        const importedId = `sofi-credit-${date}-${amountStr.trim()}-${description.trim()}`;

        transactions.push({
            date,
            amount,
            payee_name: description.trim(),
            notes: `${type.trim()} · ${category.trim()}`,
            imported_id: importedId,
        });
    }

    return transactions;
}

function pollForApolloState(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let shownToUser = false;

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Apollo state"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const tab = await chrome.tabs.get(tabId);

                // If redirected away from banking page, show tab to user and keep waiting
                if (tab.url && !tab.url.includes("sofi.com/my/banking")) {
                    if (!shownToUser) {
                        shownToUser = true;
                        chrome.tabs.update(tabId, { active: true });
                        chrome.windows.update(tab.windowId, { focused: true });
                        console.log("SoFi: waiting for login...");
                    }
                    return;
                }

                if (tab.status !== "complete") return;

                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        const script = Array.from(document.querySelectorAll("script")).find(s =>
                            s.textContent.includes("APOLLO_STATE")
                        );
                        if (!script) return null;
                        const match = script.textContent.match(/window\.APOLLO_STATE\s*=\s*(\{[\s\S]*\})/);
                        if (!match) return null;
                        try { return JSON.parse(match[1]); } catch { return null; }
                    },
                });

                const apolloState = results?.[0]?.result;
                if (apolloState && Object.keys(apolloState).some(k =>
                    k.startsWith("CheckingAccount") || k.startsWith("SavingsAccount")
                )) {
                    clearInterval(interval);
                    resolve(apolloState);
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function getCsrfFromTab(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: "GET_CSRF_TOKEN" }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (response?.error) {
                reject(new Error(response.error));
            } else {
                resolve(response.csrfToken);
            }
        });
    });
}

function extractSoFiAccounts(apolloState) {
    const accounts = [];

    for (const key of Object.keys(apolloState)) {
        const match = key.match(/^(Checking|Savings)Account:\{"id":"(\d+)"}$/);
        if (match) {
            accounts.push({ type: match[1], id: match[2] });
        }
    }

    return accounts;
}

async function fetchSoFiTransactions(accountId, csrfToken, startDate, endDate) {
    const url =
        `https://www.sofi.com/money-transactions-hist-service/api/public/v1/accounts/transactions/export/${accountId}` +
        `?startDate=${startDate}&endDate=${endDate}`;
    console.log("SoFi: fetching", url);
    const response = await fetch(url, {
        headers: {
            accept: "text/csv",
            "csrf-token": csrfToken,
        },
        credentials: "include",
    });

    if (!response.ok) {
        throw new Error(`SoFi export failed: ${response.status}`);
    }

    const csv = await response.text();
    return parseSoFiCsv(csv, accountId);
}

function parseSoFiCsv(csv, accountId) {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    const transactions = [];

    // Skip header row (index 0)
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        // Date,Description,Type,Amount,Current balance,Status
        const [date, description, type, amountStr, , status] = cols;

        if (status?.trim() !== "Posted") continue;

        const amount = Math.round(parseFloat(amountStr) * 100);
        const importedId = `sofi-${date}-${amountStr}-${description}`;

        transactions.push({
            date: date.trim(),
            amount,
            payee_name: description?.trim(),
            notes: type?.trim(),
            imported_id: importedId,
        });
    }

    return transactions;
}

export async function getSoFiAccountsForPopup() {
    const tab = await openTabBackground("https://www.sofi.com/my/banking/accounts/");

    let apolloState;
    try {
        apolloState = await pollForApolloState(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        throw new Error("Timed out waiting for SoFi login");
    }

    chrome.tabs.remove(tab.id);
    return extractSoFiAccounts(apolloState);
}
