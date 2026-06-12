import { getSyncPlan, seedLastTxDates, pacificDate, openTabBackground, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, getDateChunks, subtractOneDay, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncCapitalOne(settings, accountMappings, options = {}) {
    console.log("Capital One: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);

    const allKeys = Object.keys(accountMappings).filter(k => k.startsWith("capitalone-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allKeys;
    await seedLastTxDates(settings, lastTxDates, accountMappings, syncKeys);
    const plans = Object.fromEntries(syncKeys.map(k => [k, getSyncPlan(lastSyncDates, syncFromDate, k, lastTxDates, accountMappings[k])]));
    const activeKeys = syncKeys.filter(k => plans[k]);
    const tab = await openTabBackground("https://myaccounts.capitalone.com/accountSummary");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    activeKeys.forEach(k => reportProgress(options, k, 15, "Opening Capital One…"));

    let caponeAccounts;
    try {
        caponeAccounts = await pollForCapitalOneAccounts(tab.id, (t) => {
            activeKeys.forEach(k => reportProgress(options, k, 15 + Math.round(t * 35), "Logging in…"));
        });
    } catch (err) {
        console.error("Capital One: login failed, giving up.", err.message);
        return;
    } finally {
        chrome.tabs.remove(tab.id);
    }

    await chrome.storage.local.set({ cachedCapitalOneAccounts: caponeAccounts });

    const todayStr = pacificDate(new Date());

    for (const account of caponeAccounts) {
        const mappingKey = `capitalone-${account.id}`;
        if (!syncKeys.includes(mappingKey)) continue;
        const mapped = accountMappings[mappingKey];
        if (!mapped) continue;
        const plan = plans[mappingKey];
        if (!plan) {
            console.warn(`Capital One ${account.name}: no sync start date configured, skipping.`);
            continue;
        }
        const { startDate, endDate: today } = plan;

        console.log(`Capital One ${account.name} sync: ${startDate} → ${todayStr}`);
        reportProgress(options, mappingKey, 55, "Fetching transactions");

        try {
            const transactions = await fetchCapitalOneTransactions(account.id, startDate, todayStr);
            const currentBalance = Math.round(account.presentBalance * 100);
            const isFirstSync = !lastSyncDates[mappingKey];
            let result = {};
            if (transactions.length > 0) {
                reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`Capital One ${account.name}: importing ${transactions.length} transactions.`);
                (result = await importTransactions(`Capital One ${account.name}`, settings, mapped, transactions, mappingKey,
                    (frac, msg) => reportProgress(options, mappingKey, 80 + Math.round(frac * 20), msg)));
            } else {
                console.log(`Capital One ${account.name}: no new transactions.`);
            }
            await logBalanceDrift(`Capital One ${account.name}`, mappingKey, options.appBalances?.[mappingKey], result.byApp, -currentBalance);
            await applyActualStartingBalance(`Capital One ${account.name}`, settings, mapped, { mappingKey, bankBalance: -currentBalance, appBalances: options.appBalances?.[mappingKey], byApp: result.byApp, isFirstSync, startDate, importedId: `capitalone-${account.id}-starting-balance` });
            await updateLastSyncStats(mappingKey, transactions);
            await updateLastSyncDate(mappingKey, today);

            reportProgress(options, mappingKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error(`Capital One ${account.name} failed:`, err.message);
        }
    }
}

export async function getCapitalOneAccountsForPopup() {
    const tab = await openTabBackground("https://myaccounts.capitalone.com/accountSummary");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    try {
        return await pollForCapitalOneAccounts(tab.id);
    } catch (err) {
        throw new Error("Timed out waiting for Capital One login");
    } finally {
        chrome.tabs.remove(tab.id);
    }
}

function pollForCapitalOneAccounts(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let shownToUser = false;

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                removeGuard();
                reject(new Error("Timed out waiting for Capital One accounts"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const tab = await chrome.tabs.get(tabId);

                if (tab.url && !tab.url.includes("myaccounts.capitalone.com/accountSummary")) {
                    if (!shownToUser) {
                        shownToUser = true;
                        chrome.tabs.update(tabId, { active: true });
                        chrome.windows.update(tab.windowId, { focused: true });
                        console.log("Capital One: waiting for login...");
                    }
                    return;
                }

                if (tab.status !== "complete") return;

                const accounts = await fetchCapitalOneAccounts();
                if (accounts.length > 0) {
                    clearInterval(interval);
                    removeGuard();
                    resolve(accounts);
                }
            } catch {
                // Tab not ready or not logged in yet
            }
        }, POLL_INTERVAL_MS);

        const removeGuard = onTabClose(tabId, () => {
            clearInterval(interval);
            reject(new Error("Browser window closed"));
        });
    });
}

async function fetchCapitalOneAccounts() {
    const response = await fetch("https://myaccounts.capitalone.com/web-api/protected/636178/customer-accounts?density=2&retrieveBusinessName=true&versionUpgrade=true", {
        headers: {
            accept: "application/json;v=1",
            "accept-language": "en-US",
            "c1-xhr": "true",
            "channel-type": "WEB",
            "x-c1-dataorchestrator-cache": "refresh",
            "x-ui-routing-id": "accountSummary",
        },
        credentials: "include",
    });
    if (!response.ok) return [];
    const json = await response.json();
    return (json?.entries ?? [])
        .filter(e => e.businessLine === "CREDIT_CARDS")
        .map(e => ({
            id: e.accountReferenceId,
            name: e.product?.productName ?? "Credit Card",
            lastFour: e.lastFour,
            presentBalance: e.presentBalance ?? 0,
        }));
}

async function fetchCapitalOneTransactions(accountId, startDate, endDate) {
    const encodedId = encodeURIComponent(encodeURIComponent(accountId));
    const chunks = getDateChunks(startDate, endDate, 365);
    const allTransactions = [];

    for (const [chunkStart, chunkEnd] of chunks) {
        const url = `https://myaccounts.capitalone.com/web-api/protected/17463/credit-cards/accounts/${encodedId}/transactions/download?fromTransactionDate=${chunkStart}&toTransactionDate=${chunkEnd}&documentFormatType=application/csv&acceptLanguage=en-US&X-User-Action=ease.downloadTransactions`;
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
        allTransactions.push(...parseCapitalOneCsv(csv));
    }

    // Remove transactions that are going to post today because they aren't included in the balance calc
    let yesterday = subtractOneDay(endDate);
    const url = `https://myaccounts.capitalone.com/web-api/protected/19902/credit-cards/accounts/${encodedId}/transactions?fromDate=${yesterday}&toDate=${endDate}`;
    console.log("Capital One: fetching", url);
    const response = await fetch(url, {
        headers: {
            accept: "application/json;v=1",
            "accept-language": "en-US",
            "x-user-action": "ease.detailsAndTransactionSummary",
            "x-ui-routing-id": "Card/REFID",
        },
        credentials: "include",
    });

    if (!response.ok) throw new Error(`Capital One export failed: ${response.status}`);

    const json = await response.json();
    for (let tx of json.entries) {
        if (tx.transactionState === "PENDING" && 'transactionPostedDate' in tx) {
            let date = tx.transactionPostedDate.split("T")[0];
            let isCredit = tx.transactionDebitCredit === "Credit";
            let amount = Math.round(tx.transactionAmount * 100) * (isCredit ? 1 : -1);
            let category = tx.displayCategory;

            let idx = allTransactions.findIndex(t => t.date === date && t.amount === amount && t.category === category.trim());
            if (idx >= 0) {
                console.log("Removing duplicate pending transaction from today");
                allTransactions.splice(idx, 1);
            }
        }
    }

    return allTransactions;
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
            category: category.trim(),
            imported_id: `capitalone-${date}-${amount}-${category.trim()}`,
        });
    }

    return transactions;
}

