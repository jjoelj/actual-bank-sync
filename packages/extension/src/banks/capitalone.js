import { getSyncPlan, pacificDate, openTabBackground, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, getDateChunks, applyStartingBalance, subtractOneDay } from "../utils.js";

export async function syncCapitalOne(settings, accountMappings, options = {}) {
    console.log("Capital One: starting");
    const { lastSyncDates = {}, syncFromDate, startingBalances = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "startingBalances"]);

    const allKeys = Object.keys(accountMappings).filter(k => k.startsWith("capitalone-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allKeys;
    const plans = Object.fromEntries(syncKeys.map(k => {
        let plan = getSyncPlan(lastSyncDates, syncFromDate, k, options);
        if (plan && startingBalances[k] === undefined) plan = { ...plan, shouldSync: true, startDate: syncFromDate ?? plan.startDate };
        return [k, plan];
    }));
    const allSyncedToday = syncKeys.length > 0 && syncKeys.every(k => !plans[k]?.shouldSync);

    if (allSyncedToday) {
        console.log("Capital One: all accounts already synced today, skipping.");
        return;
    }

    const activeKeys = syncKeys.filter(k => plans[k]?.shouldSync);
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
        chrome.tabs.remove(tab.id);
        return;
    }

    await chrome.storage.local.set({ cachedCapitalOneAccounts: caponeAccounts });
    chrome.tabs.remove(tab.id);

    const todayStr = pacificDate(new Date());

    for (const account of caponeAccounts) {
        const mappingKey = `capitalone-${account.id}`;
        if (!syncKeys.includes(mappingKey)) continue;
        const actualAccountId = accountMappings[mappingKey];
        if (!actualAccountId) continue;
        const plan = plans[mappingKey];
        if (!plan) {
            console.warn(`Capital One ${account.name}: no sync start date configured, skipping.`);
            continue;
        }
        if (!plan.shouldSync) {
            console.log(`Capital One ${account.name}: already synced today, skipping.`);
            continue;
        }
        const { startDate, endDate: today } = plan;

        console.log(`Capital One ${account.name} sync: ${startDate} → ${todayStr}`);
        reportProgress(options, mappingKey, 55, "Fetching transactions");

        try {
            const transactions = await fetchCapitalOneTransactions(account.id, startDate, todayStr);
            if (transactions.length > 0) {
                reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`Capital One ${account.name}: importing ${transactions.length} transactions.`);
                await importTransactions(`Capital One ${account.name}`, settings, actualAccountId, transactions);
            } else {
                console.log(`Capital One ${account.name}: no new transactions.`);
            }
            const isFirstSync = !lastSyncDates[mappingKey] || startingBalances[mappingKey] === undefined;
            await updateLastSyncStats(mappingKey, transactions);
            await updateLastSyncDate(mappingKey, today);

            const currentBalance = Math.round(account.presentBalance * 100);
            await applyStartingBalance(`Capital One ${account.name}`, mappingKey, { settings, accountId: actualAccountId, transactions, accountBalance: -currentBalance, isFirstSync, startDate, importedId: `capitalone-${account.id}-starting-balance` });

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

    let accounts;
    try {
        accounts = await pollForCapitalOneAccounts(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        throw new Error("Timed out waiting for Capital One login");
    }

    chrome.tabs.remove(tab.id);
    return accounts;
}

function pollForCapitalOneAccounts(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Capital One accounts"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status !== "complete") return;
                if (!tab.url?.includes("myaccounts.capitalone.com/accountSummary")) return;

                const accounts = await fetchCapitalOneAccounts();
                if (accounts.length > 0) {
                    clearInterval(interval);
                    resolve(accounts);
                }
            } catch {
                // Tab not ready or not logged in yet
            }
        }, POLL_INTERVAL_MS);
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

            let importedId = `capitalone-${date}-${amount}-${category.trim()}`;

            // only remove first instance in case there are multiple (they'll be handled if needed)
            let idx = allTransactions.findIndex(t => t.imported_id === importedId);
            if (idx > 0) {
                console.log("Removing pending transaction from today:", importedId);
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
            notes: category.trim(),
            imported_id: `capitalone-${date}-${amount}-${category.trim()}`,
        });
    }

    return transactions;
}

