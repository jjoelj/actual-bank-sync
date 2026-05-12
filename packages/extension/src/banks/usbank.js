import { getSyncPlan, pacificDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, applyStartingBalance } from "../utils.js";

export async function syncUSBank(settings, accountMappings, options = {}) {
    console.log("US Bank: starting");
    const { lastSyncDates = {}, syncFromDate, startingBalances = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "startingBalances"]);

    const allKeys = Object.keys(accountMappings).filter(k => k.startsWith("usbank-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allKeys;
    const plans = Object.fromEntries(syncKeys.map(k => {
        let plan = getSyncPlan(lastSyncDates, syncFromDate, k, options);
        if (plan && startingBalances[k] === undefined) plan = { ...plan, shouldSync: true, startDate: syncFromDate ?? plan.startDate };
        return [k, plan];
    }));
    const allSyncedToday = syncKeys.length > 0 && syncKeys.every(k => !plans[k]?.shouldSync);

    if (allSyncedToday) {
        console.log("US Bank: all accounts already synced today, skipping.");
        return;
    }

    const activeKeys = syncKeys.filter(k => plans[k]?.shouldSync);
    const tab = await openTabBackground("https://onlinebanking.usbank.com/auth/login/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    activeKeys.forEach(k => reportProgress(options, k, 15, "Opening US Bank…"));

    let usbankData;
    try {
        usbankData = await pollForUSBankData(tab.id, (t) => {
            activeKeys.forEach(k => reportProgress(options, k, 15 + Math.round(t * 35), "Logging in…"));
        });
    } catch (err) {
        console.error("US Bank: login failed, giving up.", err.message);
        return;
    }

    const { accessToken, afToken, accounts: cadAccounts } = usbankData;

    const accountTokens = cadAccounts
        .filter(a => a.accountToken)
        .map(a => a.accountToken);

    let accountDetails = [];
    if (accountTokens.length) {
        try {
            const result = await chrome.tabs.sendMessage(tab.id, {
                type: "FETCH_USBANK_ACCOUNTS",
                accessToken,
                accountTokens,
            });
            if (result.error) throw new Error(result.error);
            accountDetails = (result.accounts ?? []).map((a, i) => ({
                ...a,
                accountToken: accountTokens[i],
            }));
        } catch (err) {
            console.error("US Bank: failed to fetch account details:", err.message);
        }
    }

    const usbankAccounts = accountDetails
        .filter(a => a.accountType === "Credit Card")
        .map(a => ({
            id: a.accountNumber?.slice(-4) ?? a.uniqueIdentifier,
            name: a.nickname || a.details?.cardName || a.productDescription || "Credit Card",
            lastFour: a.accountNumber?.slice(-4),
            accountToken: a.accountToken,
            currentBalance: a.balances?.currentBalance ?? 0,
        }));

    await chrome.storage.local.set({ cachedUSBankAccounts: usbankAccounts });

    const todayStr = pacificDate(new Date());

    for (const account of usbankAccounts) {
        const mappingKey = `usbank-${account.id}`;
        if (!syncKeys.includes(mappingKey)) continue;
        const actualAccountId = accountMappings[mappingKey];
        if (!actualAccountId) continue;
        const plan = plans[mappingKey];
        if (!plan) {
            console.warn(`US Bank ${account.name}: no sync start date configured, skipping.`);
            continue;
        }
        if (!plan.shouldSync) {
            console.log(`US Bank ${account.name}: already synced today, skipping.`);
            continue;
        }
        const { startDate, endDate: today } = plan;

        console.log(`US Bank ${account.name} sync: ${startDate} → ${todayStr}`);
        reportProgress(options, mappingKey, 55, "Fetching transactions");

        try {
            const transactions = await fetchUSBankTransactions(tab.id, accessToken, afToken, account.accountToken, startDate, todayStr);
            if (transactions.length > 0) {
                reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`US Bank ${account.name}: importing ${transactions.length} transactions.`);
                await importTransactions(`US Bank ${account.name}`, settings, actualAccountId, transactions);
            } else {
                console.log(`US Bank ${account.name}: no new transactions.`);
            }
            const isFirstSync = !lastSyncDates[mappingKey] || startingBalances[mappingKey] === undefined;
            await updateLastSyncStats(mappingKey, transactions);
            await updateLastSyncDate(mappingKey, today);

            const currentBalance = Math.round(account.currentBalance * 100);
            await applyStartingBalance(`US Bank ${account.name}`, mappingKey, { settings, accountId: actualAccountId, transactions, accountBalance: -currentBalance, isFirstSync, startDate, importedId: `usbank-${account.id}-starting-balance` });

            reportProgress(options, mappingKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error(`US Bank ${account.name} failed:`, err.message);
        }
    }

    chrome.tabs.remove(tab.id);
}

export async function getUSBankAccountsForPopup() {
    const tab = await openTabBackground("https://onlinebanking.usbank.com/auth/login/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    try {
        const data = await pollForUSBankData(tab.id);

        const accountTokens = data.accounts
            .filter(a => a.accountToken)
            .map(a => a.accountToken);

        if (!accountTokens.length) return [];

        const result = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_USBANK_ACCOUNTS",
            accessToken: data.accessToken,
            accountTokens,
        });
        if (result.error) throw new Error(result.error);

        return (result.accounts ?? [])
            .filter(a => a.accountType === "Credit Card")
            .map((a, i) => ({
                id: a.accountNumber?.slice(-4) ?? a.uniqueIdentifier,
                name: a.nickname || a.details?.cardName || a.productDescription || "Credit Card",
                lastFour: a.accountNumber?.slice(-4),
                accountToken: accountTokens[i],
                currentBalance: a.balances?.currentBalance ?? 0,
            }));
    } catch (err) {
        throw new Error("Timed out waiting for US Bank login");
    } finally {
        chrome.tabs.remove(tab.id);
    }
}

function pollForUSBankData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for US Bank data"));
                return;
            }
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status !== "complete") return;
                if (!tab.url?.includes("onlinebanking.usbank.com")) return;

                const result = await chrome.tabs.sendMessage(tabId, { type: "GET_USBANK_DATA" });
                if (result?.accessToken && result?.accounts?.length > 0) {
                    clearInterval(interval);
                    resolve(result);
                }
            } catch {
                // Tab not ready or content script not loaded yet
            }
        }, POLL_INTERVAL_MS);
    });
}

async function fetchUSBankTransactions(tabId, accessToken, afToken, accountToken, startDate, endDate) {
    const allTransactions = [];
    let pageNumber = 1;

    while (true) {
        const result = await chrome.tabs.sendMessage(tabId, {
            type: "FETCH_USBANK_TRANSACTIONS",
            accessToken,
            afToken,
            accountToken,
            startDate,
            endDate,
            pageNumber,
        });
        if (result.error) throw new Error(result.error);

        for (const tx of result.transactions) {
            const rawDate = tx.postedDateTime;
            if (!rawDate) continue;
            const date = rawDate.slice(0, 10);

            const amount = Math.round(tx.transactionAmount * 100);
            const isCredit = tx.debitCreditMemo?.toUpperCase()?.startsWith("C");
            const signedAmount = isCredit ? amount : -amount;

            allTransactions.push({
                date,
                amount: signedAmount,
                payee_name: tx.description?.trim(),
                notes: tx.enrichedDetails?.category || undefined,
                imported_id: `usbank-${tx.transactionUniqueId}`,
            });
        }

        if (pageNumber >= (result.totalPages || 1)) break;
        pageNumber++;
    }

    return allTransactions;
}
