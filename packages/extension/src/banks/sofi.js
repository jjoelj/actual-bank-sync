import { getDateChunks, getSyncPlan, seedLastTxDates, pacificDate, parseCsvLine, openTabBackground, POLL_TIMEOUT_MS, POLL_INTERVAL_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncSoFi(settings, accountMappings, options = {}) {
    console.log("SoFi: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);

    const allSofiKeys = Object.keys(accountMappings).filter(k => k.startsWith("sofi-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allSofiKeys;
    // SoFi banking accounts are synced as a group: we always fetch and import
    // *all* mapped banking accounts, not just the requested ones, so
    // removeMatchedIncomingTransfers can see both sides of an internal transfer
    // (one side may have already synced today, or only one row may be requested).
    // Unmapped accounts aren't in accountMappings, so this still only imports
    // accounts that have a Sure mapping. The credit card is separate and stays
    // scoped to syncKeys.
    const bankingKeys = allSofiKeys.filter(k => k !== "sofi-credit");
    await seedLastTxDates(settings, lastTxDates, accountMappings, Array.from(new Set([...bankingKeys, ...syncKeys])));
    const plans = Object.fromEntries(bankingKeys.map(k => [k, getSyncPlan(lastSyncDates, syncFromDate, k, lastTxDates, accountMappings[k])]));
    const activeKeys = bankingKeys.filter(k => plans[k]);
    // Fetch every account over one window (the earliest active start date) so
    // both sides of an internal transfer land in the same batch — that's what
    // lets removeMatchedIncomingTransfers pair a "From …" with its "To …".
    // Re-fetched rows that already exist in Sure are deduped on import.
    const fetchStart = activeKeys.length
        ? activeKeys.reduce((min, k) => (plans[k].startDate < min ? plans[k].startDate : min), plans[activeKeys[0]].startDate)
        : null;
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
            const mapped = accountMappings[mappingKey];
            if (!mapped) continue; // no Sure mapping → don't fetch/import
            const plan = plans[mappingKey];
            if (!plan) {
                console.warn(`SoFi ${account.id}: no sync start date configured, skipping.`);
                continue;
            }
            console.log(`SoFi ${account.id} fetching: ${fetchStart} → ${todayStr}`);
            reportProgress(options, mappingKey, 55, "Fetching transactions");

            try {
                const result = await chrome.tabs.sendMessage(tab.id, {
                    type: "FETCH_SOFI_TRANSACTIONS",
                    accountId: account.queryId,
                    csrfToken,
                    startDate: fetchStart,
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

                fetchedData.push({ account, mappingKey, mapped, plan, transactions: result.transactions, balance });
            } catch (err) {
                console.error(`SoFi account ${account.id} fetch failed:`, err.message);
            }
        }
    } finally {
        chrome.tabs.remove(tab.id);
    }

    // Drop the incoming side of internal transfers: a "From …" transaction is a
    // transfer only when a matching "To …" exists in a *different* account (same
    // date, opposite amount — SoFi posts both sides instantly). The outgoing
    // "To …" side is kept and imported; a user-defined rule in each app turns it
    // into a transfer that creates the counterpart (the apps' auto-matching is
    // too unreliable to import both raw sides).
    removeMatchedIncomingTransfers(fetchedData);

    // Phase 2: import (tab already closed). A user-defined rule (required setup,
    // see README) creates the matching inflow whenever a "To …" transfer is
    // imported, so import every account's "To …" rows first and let those
    // imports finish before importing anything else — by the time the remaining
    // rows land, the rule-generated other side already exists (and our own
    // "From …" duplicate was dropped above).
    const isToTransfer = (tx) => typeof tx.payee_name === "string" && tx.payee_name.startsWith("To ");
    const batches = fetchedData.map(data => ({
        ...data,
        toTxns: data.transactions.filter(isToTransfer),
        restTxns: data.transactions.filter(tx => !isToTransfer(tx)),
    }));
    const addedByKey = {};

    // Pass 1: all "To …" transfers, so Sure creates each matching other side.
    for (const { account, mappingKey, mapped, toTxns } of batches) {
        if (toTxns.length === 0) continue;
        try {
            reportProgress(options, mappingKey, 75, `Importing ${toTxns.length} transfer${toTxns.length === 1 ? "" : "s"}`);
            console.log(`SoFi ${account.id}: importing ${toTxns.length} "To …" transfer(s) first.`);
            const result = await importTransactions(`SoFi ${account.id}`, settings, mapped, toTxns, mappingKey,
                (frac, msg) => reportProgress(options, mappingKey, 75 + Math.round(frac * 10), msg));
            accumulateAdded(addedByKey, mappingKey, result.byApp);
        } catch (err) {
            console.error(`SoFi account ${account.id} transfer import failed:`, err.message);
        }
    }

    // Pass 2: everything else, plus per-account bookkeeping over the full set.
    for (const { account, mappingKey, mapped, plan, transactions, restTxns, balance } of batches) {
        const { startDate, endDate: today } = plan;
        try {
            if (restTxns.length > 0) {
                reportProgress(options, mappingKey, 85, `Importing ${restTxns.length} transactions`);
                console.log(`SoFi ${account.id}: importing ${restTxns.length} transactions.`);
                const result = await importTransactions(`SoFi ${account.id}`, settings, mapped, restTxns, mappingKey,
                    (frac, msg) => reportProgress(options, mappingKey, 85 + Math.round(frac * 15), msg));
                accumulateAdded(addedByKey, mappingKey, result.byApp);
            } else if (transactions.length === 0) {
                console.log(`SoFi ${account.id}: no new transactions.`);
            }
            if (balance != null) {
                logBalanceDrift(`SoFi ${account.id}`, options.appBalances?.[mappingKey], addedByKey[mappingKey], balance);
                await applyActualStartingBalance(`SoFi ${account.id}`, settings, mapped, { bankBalance: balance, appBalances: options.appBalances?.[mappingKey], byApp: addedByKey[mappingKey], isFirstSync: !lastSyncDates[mappingKey], startDate, importedId: `sofi-${account.id}-starting-balance` });
            }
            await updateLastSyncStats(mappingKey, transactions);
            await updateLastSyncDate(mappingKey, today);

            reportProgress(options, mappingKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error(`SoFi account ${account.id} import failed:`, err.message);
        }
    }

    const creditKey = "sofi-credit";
    const creditActualId = accountMappings[creditKey];
    scope: if (creditActualId && syncKeys.includes(creditKey)) {
        const creditPlan = getSyncPlan(lastSyncDates, syncFromDate, creditKey, lastTxDates, creditActualId);
        if (!creditPlan) {
            console.warn(`SoFi Credit: no sync start date configured, skipping.`);
            break scope
        }
        const { startDate, endDate: today } = creditPlan;

        console.log(`SoFi Credit sync: ${startDate} → ${todayStr}`);

        let currentBalance = null;
        try {
            currentBalance = await fetchSoFiCreditBalance();
        } catch (err) {
            console.warn("SoFi Credit: failed to fetch balance:", err.message);
        }

        let result = {};
        try {
            reportProgress(options, creditKey, 55, "Fetching transactions");
            const transactions = await fetchSoFiCreditTransactions(startDate, todayStr);
            if (transactions.length > 0) {
                reportProgress(options, creditKey, 80, `Importing ${transactions.length} transactions`);
                console.log(`SoFi credit: importing ${transactions.length} transactions.`);
                (result = await importTransactions("SoFi Credit", settings, creditActualId, transactions, creditKey,
                    (frac, msg) => reportProgress(options, creditKey, 80 + Math.round(frac * 20), msg)));
            } else {
                console.log("SoFi credit: no new transactions.");
            }
            if (currentBalance != null) {
                logBalanceDrift("SoFi Credit", options.appBalances?.[creditKey], result.byApp, -currentBalance);
                await applyActualStartingBalance("SoFi Credit", settings, creditActualId, { bankBalance: -currentBalance, appBalances: options.appBalances?.[creditKey], byApp: result.byApp, isFirstSync: !lastSyncDates[creditKey], startDate, importedId: "sofi-credit-starting-balance" });
            }
            await updateLastSyncStats(creditKey, transactions);
            await updateLastSyncDate(creditKey, today);

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

        transactions.push({
            date,
            amount,
            payee_name: description.trim(),
            category: category.trim() || undefined,
            notes: type.trim() || undefined,
            imported_id: `sofi-credit-${date}-${amountStr.trim()}-${description.trim()}`,
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
                removeGuard();
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
                    removeGuard();
                    resolve(apolloState);
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

// Accumulate per-app addedSum across the two import passes so the final
// balance-drift check sees everything this sync added for the account.
function accumulateAdded(addedByKey, key, byApp = {}) {
    const acc = addedByKey[key] ??= {};
    for (const [app, r] of Object.entries(byApp)) {
        (acc[app] ??= { addedSum: 0 }).addedSum += r?.addedSum ?? 0;
    }
}

// Remove the incoming ("From …") side of internal transfers by pairing it with
// an outgoing ("To …") side in a different account: same date, opposite amount.
// Matches are consumed so multiple same-day/same-amount transfers pair 1:1, and
// a "From …" with no matching "To …" (e.g. the other account isn't synced) is
// kept as a real inflow.
function removeMatchedIncomingTransfers(fetchedData) {
    const toByKey = new Map(); // `${date}|${amount}` -> [mappingKey, ...]
    for (const { mappingKey, transactions } of fetchedData) {
        for (const tx of transactions) {
            if (typeof tx.payee_name === "string" && tx.payee_name.startsWith("To ")) {
                const key = `${tx.date}|${tx.amount}`;
                if (!toByKey.has(key)) toByKey.set(key, []);
                toByKey.get(key).push(mappingKey);
            }
        }
    }

    for (const data of fetchedData) {
        let removed = 0;
        data.transactions = data.transactions.filter(tx => {
            if (typeof tx.payee_name !== "string" || !tx.payee_name.startsWith("From ")) return true;
            const candidates = toByKey.get(`${tx.date}|${-tx.amount}`);
            const idx = candidates ? candidates.findIndex(k => k !== data.mappingKey) : -1;
            if (idx < 0) return true; // no matching "To" in another account → real inflow, keep
            candidates.splice(idx, 1); // consume so each "To" pairs with one "From"
            removed++;
            return false;
        });
        if (removed) console.log(`SoFi ${data.account.id}: dropped ${removed} incoming transfer(s) matched to a "To" in another account.`);
    }
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
