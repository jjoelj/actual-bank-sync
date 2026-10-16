import { autoLogin, enterTextedCode } from "../login.js";
import { getSyncPlan, refreshLastTxDates, pacificDate, toLocalDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

export async function syncUSBank(settings, accountMappings, options = {}) {
    console.log("US Bank: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);

    const allKeys = Object.keys(accountMappings).filter(k => k.startsWith("usbank-"));
    const syncKeys = options.syncKeys?.length ? options.syncKeys : allKeys;
    await refreshLastTxDates(settings, lastTxDates, accountMappings, syncKeys);
    const plans = Object.fromEntries(syncKeys.map(k => [k, getSyncPlan(lastSyncDates, syncFromDate, k, lastTxDates, accountMappings[k])]));
    const activeKeys = syncKeys.filter(k => plans[k]);
    const tab = await openTabBackground("https://onlinebanking.usbank.com/auth/login/");
    activeKeys.forEach(k => reportProgress(options, k, 15, "Opening US Bank…"));

    let usbankData;
    try {
        usbankData = await pollForUSBankData(tab.id, (t, msg) => {
            activeKeys.forEach(k => reportProgress(options, k, 15 + Math.round(t * 35), msg));
        });
    } catch (err) {
        console.warn("US Bank: login failed, giving up.", err.message);
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
            await logBalanceDrift(`US Bank ${account.name}`, mappingKey, options.appBalances?.[mappingKey], result.byApp, -currentBalance);
            await applyActualStartingBalance(`US Bank ${account.name}`, settings, mapped, { mappingKey, bankBalance: -currentBalance, appBalances: options.appBalances?.[mappingKey], byApp: result.byApp, isFirstSync, startDate, importedId: `usbank-${account.id}-starting-balance` });
            await updateLastSyncStats(mappingKey, transactions);
            if (result.failures?.length) throw new Error(result.failures.join("; "));
            await updateLastSyncDate(mappingKey, today);

            reportProgress(options, mappingKey, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error(`US Bank ${account.name} failed:`, err.message);
        }
    }

    chrome.tabs.remove(tab.id).catch(() => {});   // may already be closed
}

export async function getUSBankAccountsForPopup() {
    const tab = await openTabBackground("https://onlinebanking.usbank.com/auth/login/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { state: "normal", focused: true });

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
        chrome.tabs.remove(tab.id).catch(() => {});   // may already be closed
    }
}

// The code screen: Continue texts the code, then the code box shows on the same page.
const USBANK_CODE = {
    from: /u\.?\s*s\.?\s*bank/i,
    sendButton: "#otp-cont-button",
    codeBox: "#input_idshield-input",
};

// Types the saved password once on the sign-in page. US Bank then asks for a
// texted code every time: it's read off Google Messages and entered once. If
// that fails (or the code screen is still up after), the window comes up so
// the user can finish; the poll carries on after. Also comes up 20s after the
// last submit, or after 15s if no password field ever showed.
function pollForUSBankData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        let start = Date.now();
        let busy = false;   // autoLogin takes seconds; don't let ticks overlap it
        let loginAttempted = false;
        let codeAttempted = false;
        let loginAt = 0;
        let shownToUser = false;
        let status = "Signing in…";
        // Progress moves by sign-in step (frac), never back; waiting on the
        // user or a text doesn't advance it.
        let progress = 0;
        const say = (msg, frac) => {
            status = msg;
            if (frac != null) progress = Math.max(progress, frac);
            onTick?.(progress, msg);
        };

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            const elapsed = Date.now() - start;
            if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                removeGuard();
                reject(new Error("Timed out waiting for US Bank data"));
                return;
            }
            onTick?.(progress, status);

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status !== "complete") return;
                if (!tab.url?.includes("onlinebanking.usbank.com")) return;

                if (!shownToUser) {
                    const [probe] = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => ({
                            password: !!document.querySelector("#input_aw-password"),
                            codeScreen: !!document.querySelector("#otp-cont-button, #input_idshield-input"),
                        }),
                    });
                    const { password, codeScreen } = probe?.result || {};
                    if (password && !loginAttempted) {
                        loginAttempted = true;   // one auto-login per sync; a bad password falls to the user
                        say("Signing in with saved login…", 0.1);
                        loginAt = await autoLogin(tabId, "usbank") ? Date.now() : 0;
                    }
                    if (codeScreen && !codeAttempted) {
                        codeAttempted = true;
                        if (await enterTextedCode(tabId, "US Bank", USBANK_CODE, say)) {
                            start = loginAt = Date.now();   // waiting on the text doesn't count toward the timeout
                            say("Finishing sign-in…", 0.85);
                            return;
                        }
                    }
                    const giveUp = codeScreen
                        || (loginAttempted ? Date.now() - loginAt > 20000 : (password && Date.now() - start > 15000));
                    if (giveUp) {
                        shownToUser = true;
                        say(codeScreen ? "Enter the texted code in the US Bank window" : "Sign in in the US Bank window");
                        console.log(codeScreen ? "US Bank: code required; waiting for you to enter it..." : "US Bank: waiting for login...");
                        chrome.tabs.update(tabId, { active: true });
                        chrome.windows.update(tab.windowId, { state: "normal", focused: true });
                    }
                }

                const result = await chrome.tabs.sendMessage(tabId, { type: "GET_USBANK_DATA" });
                if (result?.accessToken && result?.accounts?.length > 0) {
                    clearInterval(interval);
                    removeGuard();
                    resolve(result);
                }
            } catch {
                // Tab not ready or content script not loaded yet
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
                // subCategory is the one reward categories are assessed on
                // ("Fast Food"); `category` is the broad parent ("Food & Dining").
                category: tx.enrichedDetails?.subCategory || tx.enrichedDetails?.category || undefined,
                imported_id: tx.transactionUniqueId ? `usbank-${tx.transactionUniqueId}` : undefined,
            });
        }

        if (pageNumber >= (result.totalPages || 1) || added === 0) break;
        pageNumber++;
    }

    return allTransactions;
}
