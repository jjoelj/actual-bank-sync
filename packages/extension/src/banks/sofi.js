import { getDateChunks, getSyncPlan, pacificDate, parseCsvLine, openTabBackground, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, applyStartingBalance } from "../utils.js";

export async function syncSoFi(settings, accountMappings, options = {}) {
    console.log("SoFi: starting");
    const { lastSyncDates = {}, syncFromDate, startingBalances = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "startingBalances"]);

    const allSofiKeys = Object.keys(accountMappings).filter(k => k.startsWith("sofi-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allSofiKeys;
    const plans = Object.fromEntries(syncKeys.map(k => {
        let plan = getSyncPlan(lastSyncDates, syncFromDate, k, options);
        if (plan && startingBalances[k] === undefined) plan = { ...plan, shouldSync: true, startDate: syncFromDate ?? plan.startDate };
        return [k, plan];
    }));
    const allSyncedToday = syncKeys.length > 0 && syncKeys.every(k => !plans[k]?.shouldSync);

    if (allSyncedToday) {
        console.log("SoFi: all accounts already synced today, skipping.");
        return;
    }

    const activeKeys = syncKeys.filter(k => plans[k]?.shouldSync);
    const tab = await openTabBackground("https://www.sofi.com/my/banking/accounts/");
    activeKeys.forEach(k => reportProgress(options, k, 15, "Opening SoFi…"));

    const fetchedData = [];
    const todayStr = pacificDate(new Date());

    try {
        let apolloState;
        try {
            apolloState = await pollForApolloState(tab.id, (t) => {
                activeKeys.forEach(k => reportProgress(options, k, 15 + Math.round(t * 30), "Logging in…"));
            });
        } catch (err) {
            console.error("SoFi: login failed, giving up.", err.message);
            return;
        }

        const sofiAccounts = extractSoFiAccounts(apolloState);
        await chrome.storage.local.set({ cachedSofiAccounts: sofiAccounts });

        if (sofiAccounts.length === 0) {
            console.warn("SoFi: no accounts found in Apollo state.");
            return;
        }

        activeKeys.forEach(k => reportProgress(options, k, 47, "Getting account data…"));

        let csrfToken;
        try {
            csrfToken = await getCsrfFromTab(tab.id);
        } catch (err) {
            console.error("SoFi: failed to get CSRF token:", err.message);
            return;
        }

        for (const account of sofiAccounts) {
            const mappingKey = `sofi-${account.id}`;
            if (!syncKeys.includes(mappingKey)) continue;
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
            const { startDate } = plan;

            console.log(`SoFi ${account.id} fetching: ${startDate} → ${todayStr}`);
            reportProgress(options, mappingKey, 55, "Fetching transactions");

            try {
                const result = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_SOFI_TRANSACTIONS",
                    accountId: account.queryId,
                    csrfToken,
                    startDate,
                    endDate: todayStr,
                });
                if (result.error) throw new Error(result.error);

                let balance = null;
                const balanceResult = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_SOFI_BALANCE",
                    accountId: account.queryId,
                });
                if (balanceResult.error) {
                    console.warn(`SoFi ${account.id}: failed to get balance:`, balanceResult.error);
                } else {
                    balance = balanceResult.balance;
                }

                fetchedData.push({ account, mappingKey, actualAccountId, plan, transactions: result.transactions, balance });
            } catch (err) {
                console.error(`SoFi account ${account.id} fetch failed:`, err.message);
            }
        }
    } finally {
        chrome.tabs.remove(tab.id);
    }

    // Phase 2: import (tab already closed)
    for (const { account, mappingKey, actualAccountId, plan, transactions, balance } of fetchedData) {
        const { startDate, endDate: today } = plan;
        try {
            await updateLastSyncDate(mappingKey, today);
            await updateLastSyncStats(mappingKey, transactions);

            if (transactions.length > 0) {
                reportProgress(options, mappingKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`SoFi ${account.id}: importing ${transactions.length} transactions.`);
                await importTransactions(`SoFi ${account.id}`, settings, actualAccountId, transactions);
            } else {
                console.log(`SoFi ${account.id}: no new transactions.`);
            }

            if (balance != null) {
                const isFirstSync = !lastSyncDates[mappingKey] || startingBalances[mappingKey] === undefined;
                await applyStartingBalance(`SoFi ${account.id}`, mappingKey, { settings, accountId: actualAccountId, transactions, accountBalance: balance, isFirstSync, startDate, importedId: `sofi-${account.id}-starting-balance` });
            }

            reportProgress(options, mappingKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error(`SoFi account ${account.id} import failed:`, err.message);
        }
    }

    const creditKey = "sofi-credit";
    const creditActualId = accountMappings[creditKey];
    scope: if (creditActualId && syncKeys.includes(creditKey)) {
        const isFirstSync = !lastSyncDates[creditKey] || startingBalances[creditKey] === undefined;
        let creditPlan = getSyncPlan(lastSyncDates, syncFromDate, creditKey, options);
        if (!creditPlan) {
            console.warn(`SoFi Credit: no sync start date configured, skipping.`);
            break scope
        }
        if (isFirstSync) creditPlan = { ...creditPlan, shouldSync: true, startDate: syncFromDate ?? creditPlan.startDate };
        if (!creditPlan.shouldSync) {
            console.log(`SoFi Credit: already synced today, skipping.`);
            break scope
        }
        const { startDate, endDate: today } = creditPlan;

        console.log(`SoFi Credit sync: ${startDate} → ${todayStr}`);

        try {
            reportProgress(options, creditKey, 55, "Fetching transactions");
            const transactions = await fetchSoFiCreditTransactions(startDate, todayStr);
            if (transactions.length > 0) {
                reportProgress(options, creditKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`SoFi credit: importing ${transactions.length} transactions.`);
                await importTransactions("SoFi Credit", settings, creditActualId, transactions);
            } else {
                console.log("SoFi credit: no new transactions.");
            }
            await updateLastSyncStats(creditKey, transactions);
            await updateLastSyncDate(creditKey, today);

            try {
                const currentBalance = await fetchSoFiCreditBalance();
                await applyStartingBalance("SoFi Credit", creditKey, { settings, accountId: creditActualId, transactions, accountBalance: -currentBalance, isFirstSync, startDate, importedId: "sofi-credit-starting-balance" });
            } catch (err) {
                console.warn("SoFi credit: failed to verify starting balance:", err.message);
            }

            reportProgress(options, creditKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error("SoFi credit failed:", err.message);
        }
    }
}

async function fetchSoFiCreditBalance() {
    const response = await fetch("https://www.sofi.com/credit-card-aggregator/api/public/v1/overview", {
        headers: { accept: "application/json" },
        credentials: "include",
    });
    if (!response.ok) throw new Error(`SoFi credit overview failed: ${response.status}`);
    const json = await response.json();
    const account = json?.accounts?.[0];
    if (!account) throw new Error("No credit account found in overview response");
    return Math.round(account.currentBalanceAmount * 100);
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

        if (response.status === 400) {
            console.log("SoFi Credit: no transactions for chunk", chunkStart, "→", chunkEnd);
            continue;
        }
        if (!response.ok) {
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
        const bankMatch = key.match(/^(Checking|Savings)Account:\{"id":"(\d+)"}$/);
        if (bankMatch) {
            accounts.push({ type: bankMatch[1], id: bankMatch[2], queryId: bankMatch[2] });
            continue;
        }
        if (key.startsWith("VaultAccount:")) {
            const data = apolloState[key];
            const frn = data?.frn;
            if (!frn) continue;
            const vaultNum = frn.split("/").pop();
            accounts.push({ type: "Vault", id: `vault-${vaultNum}`, queryId: frn, name: data?.name ?? null });
        }
    }

    return accounts;
}


export async function getSoFiAccountsForPopup() {
    const tab = await openTabBackground("https://www.sofi.com/my/banking/accounts/");

    try {
        const apolloState = await pollForApolloState(tab.id);
        return extractSoFiAccounts(apolloState);
    } catch (err) {
        throw new Error("Timed out waiting for SoFi login");
    } finally {
        chrome.tabs.remove(tab.id);
    }
}
