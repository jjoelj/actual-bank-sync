import { getSyncPlan, seedLastTxDates, pacificDate, toLocalDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncUSBank(settings, accountMappings, options = {}) {
    console.log("US Bank: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);

    const allKeys = Object.keys(accountMappings).filter(k => k.startsWith("usbank-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allKeys;
    await seedLastTxDates(settings, lastTxDates, accountMappings, syncKeys);
    const plans = Object.fromEntries(syncKeys.map(k => [k, getSyncPlan(lastSyncDates, syncFromDate, k, lastTxDates, accountMappings[k])]));
    const activeKeys = syncKeys.filter(k => plans[k]);
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
        const mapped = accountMappings[mappingKey];
        if (!mapped) continue;
        const plan = plans[mappingKey];
        if (!plan) {
            console.warn(`US Bank ${account.name}: no sync start date configured, skipping.`);
            continue;
        }
        const { startDate, endDate: today } = plan;

        console.log(`US Bank ${account.name} sync: ${startDate} → ${todayStr}`);
        reportProgress(options, mappingKey, 55, "Fetching transactions");

        try {
            const transactions = await fetchUSBankTransactions(tab.id, accessToken, afToken, account.accountToken, startDate, todayStr);
            const currentBalance = Math.round(account.currentBalance * 100);
            const isFirstSync = !lastSyncDates[mappingKey];
            let result = {};
            if (transactions.length > 0) {
                reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`US Bank ${account.name}: importing ${transactions.length} transactions.`);
                (result = await importTransactions(`US Bank ${account.name}`, settings, mapped, transactions, mappingKey,
                    (frac, msg) => reportProgress(options, mappingKey, 80 + Math.round(frac * 20), msg)));
            } else {
                console.log(`US Bank ${account.name}: no new transactions.`);
            }
            logBalanceDrift(`US Bank ${account.name}`, options.appBalances?.[mappingKey], result.byApp, -currentBalance);
            await applyActualStartingBalance(`US Bank ${account.name}`, settings, mapped, { bankBalance: -currentBalance, appBalances: options.appBalances?.[mappingKey], byApp: result.byApp, isFirstSync, startDate, importedId: `usbank-${account.id}-starting-balance` });
            await updateLastSyncStats(mappingKey, transactions);
            await updateLastSyncDate(mappingKey, today);

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
                removeGuard();
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
                    removeGuard();
                    resolve(result);
                }
            } catch {
                // Tab not ready or content script not loaded yet
            }
        }, POLL_INTERVAL_MS);

        const removeGuard = onTabClose(tabId, () => {
            clearInterval(interval);
            reject(new Error("Browser window closed"));
        });
    });
}

async function fetchUSBankTransactions(tabId, accessToken, afToken, accountToken, startDate, endDate) {
    const allTransactions = [];
    const seen = new Set();
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

        let added = 0;
        for (const tx of result.transactions) {
            const key = tx.transactionUniqueId || `${tx.postedDateTime}|${tx.transactionAmount}|${tx.description}`;
            if (seen.has(key)) continue;
            seen.add(key);
            added++;

            const date = toLocalDate(tx.postedDateTime);
            if (!date) continue;

            const amount = Math.round(tx.transactionAmount * 100);
            const isCredit = tx.debitCreditMemo?.toUpperCase()?.startsWith("C");
            const signedAmount = isCredit ? amount : -amount;

            allTransactions.push({
                date,
                amount: signedAmount,
                payee_name: tx.description?.trim(),
                category: tx.enrichedDetails?.category || undefined,
                imported_id: tx.transactionUniqueId ? `usbank-${tx.transactionUniqueId}` : undefined,
            });
        }

        if (pageNumber >= (result.totalPages || 1) || added === 0) break;
        pageNumber++;
    }

    return allTransactions;
}
