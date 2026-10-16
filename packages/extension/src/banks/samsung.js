import { autoLogin } from "../login.js";
import { getSyncPlan, refreshLastTxDates, pacificDate, openTabBackground, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportProgress, updateLastSyncDate, updateLastSyncStats, importTransactions, logBalanceDrift, applyActualStartingBalance, onTabClose } from "../utils.js";

// Samsung Galaxy Card is serviced by Barclays (barclaycardus.com). No 2FA on
// that portal. When a login is needed the saved (DPAPI-encrypted) login is
// submitted in the background; with none saved, or if it fails, the tab comes to
// the front for a manual login, which the content script saves for next time.
export async function syncSamsung(settings, accountMappings, accountKey, options = {}) {
    console.log("Samsung: starting");
    const { lastSyncDates = {}, syncFromDate, lastTxDates = {} } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate", "lastTxDates"]);
    await refreshLastTxDates(settings, lastTxDates, accountMappings, [accountKey]);
    const plan = getSyncPlan(lastSyncDates, syncFromDate, accountKey, lastTxDates, accountMappings[accountKey]);
    if (!plan) {
        console.warn("Samsung: no sync start date configured, skipping.");
        return;
    }
    const { startDate, endDate: today } = plan;
    console.log(`Samsung sync: ${startDate} → ${today}`);
    reportProgress(options, 15, "Waiting for Barclays");

    const mapped = accountMappings[accountKey];
    if (!mapped) return;

    const tab = await openTabBackground("https://cards.barclaycardus.com/");

    let transactions;
    let balance = null;

    try {
        let accountId;
        try {
            accountId = await pollForSamsungData(tab.id, (t, msg) => {
                reportProgress(options, 15 + Math.round(t * 35), msg);
            });
        } catch (err) {
            console.warn("Samsung: login failed, giving up.", err.message);
            return;
        }

        try {
            reportProgress(options, 55, "Fetching transactions");
            // Every statement cycle the window overlaps; ids dedup any overlap.
            // Past cycles are named by exact closing date (any other date
            // returns no rows), so get the real latest one from Barclays.
            const closeResult = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_SAMSUNG_LAST_CLOSE" });
            const lastClose = parseCloseDate(closeResult.statementBalanceDate);
            if (!lastClose) {
                throw new Error(`no statement closing date (${closeResult.error || JSON.stringify(closeResult.statementBalanceDate)}); past cycles can't be fetched`);
            }
            const byId = new Map();
            for (const cycleDate of samsungCycleDates(startDate, lastClose)) {
                const result = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_SAMSUNG_TRANSACTIONS", accountId, cycleDate });
                if (result.error) throw new Error(`cycle ${cycleDate}: ${result.error}`);
                // A wrong closing date returns 200 + no rows, indistinguishable
                // from a quiet month, so say so.
                if (!result.data.length && cycleDate !== "9999-12-31") {
                    console.warn(`Samsung: no transactions for the cycle closing ${cycleDate}; if that's wrong, the close day changed in an older cycle.`);
                }
                for (const item of result.data) byId.set(item.id, item);
            }
            transactions = parseSamsungTransactions([...byId.values()], startDate);

            const balanceResult = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_SAMSUNG_BALANCE" });
            if (balanceResult.error) {
                console.warn("Samsung: failed to get balance:", balanceResult.error);
            } else {
                balance = parseMoney(balanceResult.balance);
            }
        } catch (err) {
            console.error("Samsung fetch failed:", err.message);
            return;
        }
    } finally {
        chrome.tabs.remove(tab.id).catch(() => {});   // may already be closed
    }

    const isFirstSync = !lastSyncDates[accountKey];
    let result = {};
    try {
        if (transactions.length > 0) {
            reportProgress(options, 80, `Importing ${transactions.length} transactions`);
            console.log(`Samsung: importing ${transactions.length} transactions.`);
            (result = await importTransactions("Samsung", settings, mapped, transactions, accountKey,
                (frac, msg) => reportProgress(options, 80 + Math.round(frac * 20), msg)));
        } else {
            console.log("Samsung: no new transactions.");
        }
        await updateLastSyncStats(accountKey, transactions);
        if (result.failures?.length) throw new Error(result.failures.join("; "));
        if (balance != null) {
            await logBalanceDrift("Samsung", accountKey, options.appBalances?.[accountKey], result.byApp, -balance);
            await applyActualStartingBalance("Samsung", settings, mapped, { mappingKey: accountKey, bankBalance: -balance, appBalances: options.appBalances?.[accountKey], byApp: result.byApp, isFirstSync, startDate, importedId: "samsung-starting-balance" });
        }

        await updateLastSyncDate(accountKey, today);
    } catch (err) {
        console.error("Samsung import failed:", err.message);
    }

    reportProgress(options, 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
}

// Waits for the Barclays account context to be reachable and returns the numeric
// account id. Discovery is done by reading the account's own transactions XHR
// off the page's performance resource timeline — the /activity page fires it on
// load — which avoids depending on any Barclays DOM selectors.
function pollForSamsungData(tabId, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let busy = false;
        let loginAttempted = false;
        let loginAt = 0;
        let shownToUser = false;
        let status = "Signing in…";
        // Progress moves by sign-in step, never back; waiting on the user doesn't advance it.
        let progress = 0;
        const say = (msg, frac) => {
            status = msg;
            if (frac != null) progress = Math.max(progress, frac);
            onTick?.(progress, msg);
        };
        let navigatedToActivity = false;
        let cardsSettleTicks = 0;

        const interval = setInterval(async () => {
            if (busy) return;
            busy = true;
            const elapsed = Date.now() - start;
            onTick?.(progress, status);
            try {
                const tab = await chrome.tabs.get(tabId);
                if (!tab.url?.includes("barclaycardus.com")) { dataPageStart = null; return; }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    removeGuard();
                    reject(new Error("Timed out waiting for Barclays"));
                    return;
                }
                if (tab.status !== "complete") return;

                const probe = await chrome.scripting.executeScript({
                    // All frames: the login form is in a cross-origin iframe
                    // (www.barclaycardus.com/servicing/authenticate inside cards.).
                    target: { tabId, allFrames: true },
                    world: "MAIN",
                    func: () => ({
                        // Barclays' password field is type="text" + a CSS mask, so
                        // match it by id/name/data-auto, not by type.
                        hasPassword: !!document.querySelector('#password, input[name="uxLoginForm.password"], input[data-auto="pass-word"]'),
                        accountId: (performance.getEntriesByType("resource") || [])
                            .map(e => e.name.match(/\/cards\/accounts\/(\d+)\/transactions/)?.[1])
                            .find(Boolean) || null,
                    }),
                });
                const results = (probe || []).map(r => r.result || {});
                const hasPassword = results.some(r => r.hasPassword);
                const accountId = results.find(r => r.accountId)?.accountId;

                if (accountId) {
                    clearInterval(interval);
                    removeGuard();
                    resolve(accountId);
                    return;
                }

                if (hasPassword) {
                    cardsSettleTicks = 0;   // still on the login form; don't count toward the fallback
                    if (!loginAttempted) {
                        loginAttempted = true;   // one auto-login per sync; a bad password falls to the user
                        // The 20s grace starts after submit (autoLogin can wait ~15s for the form).
                        say("Signing in with saved login…", 0.3);
                        loginAt = await autoLogin(tabId, "samsung") ? Date.now() : 0;   // 0 → show the tab now
                    }
                    // Still on the login form 20s after auto-login (or nothing saved):
                    // hand it to the user once.
                    if (loginAttempted && !shownToUser && Date.now() - loginAt > 20000) {
                        shownToUser = true;
                        say("Sign in in the Samsung window");
                        console.warn("Samsung: auto-login unavailable or failed; waiting for manual login.");
                        chrome.tabs.update(tabId, { active: true });
                        chrome.windows.update(tab.windowId, { state: "normal", focused: true });
                    }
                    return;
                }

                // Detect auth by host: login lives on cards.barclaycardus.com, the
                // account app on www.barclaycardus.com. Once we're on the www app
                // (and no password field), go to /activity to fire the transactions
                // XHR. Gating on host — not just "password gone" — keeps us from
                // navigating away mid-login (the field vanishes into a spinner
                // before auth completes) and hanging the sign-in.
                const onApp = tab.url.includes("www.barclaycardus.com");
                if (!navigatedToActivity && onApp && !tab.url.includes("/activity")) {
                    navigatedToActivity = true;
                    chrome.tabs.update(tabId, { url: "https://www.barclaycardus.com/servicing/activity" });
                    return;
                }
                // Fallback: an already-logged-in session that lands on the cards
                // host without redirecting to www. After a few settled no-password
                // ticks (not the brief post-submit spinner), jump to the app.
                // ponytail: ~4s heuristic; if a real login spinner ever outlasts it
                // this would interrupt — bump the threshold if that happens.
                if (!navigatedToActivity && !onApp && ++cardsSettleTicks >= 8) {
                    navigatedToActivity = true;
                    chrome.tabs.update(tabId, { url: "https://www.barclaycardus.com/servicing/activity" });
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

// paymentTile's statementBalanceDate → "YYYY-MM-DD". Accepts ISO or US
// "MM/DD/YYYY"; anything else → null.
export function parseCloseDate(str) {
    const s = String(str ?? "");
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso.slice(1).join("-");
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return null;
}

// cycleDates to fetch so [startDate, today] is covered: the current cycle plus
// every closed cycle whose closing date is on/after startDate (a cycle closing
// on C holds transactions from the previous close through C). lastClose is the
// real latest closing date (paymentTile); older closes repeat its day of month.
// ponytail: older closes assume a fixed close day (true so far: Oct 2026 closed
// on a Sunday, so it isn't business-day adjusted). Only backfills reach them.
export function samsungCycleDates(startDate, lastClose) {
    const cycles = ["9999-12-31"];
    if (!lastClose) return cycles;
    let [y, m, day] = lastClose.split("-").map(Number);
    const close = () => {
        const d = Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate());   // clamp e.g. the 31st in short months
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    const back = () => { if (--m === 0) { m = 12; y--; } };
    while (close() >= startDate) {
        cycles.push(close());
        back();
    }
    return cycles;
}

// Barclays returns an unsigned amount; sign it from the transaction type
// (purchases/fees are outflows, payments/credits/returns are inflows).
const CREDIT_TYPES = /PAYMENT|CREDIT|RETURN|REFUND|REVERSAL/;

export function parseSamsungTransactions(data, startDate) {
    return (data || []).map(item => {
        const a = item.attributes || {};
        const date = a.transactionDate;
        const raw = Math.round((a.amount?.value ?? 0) * 100);
        if (!date || raw === 0) return null;
        if (startDate && date < startDate) return null;
        const isCredit = CREDIT_TYPES.test(String(a.transactionType).toUpperCase());
        return {
            date,
            amount: isCredit ? raw : -raw,
            payee_name: (a.merchantInfo?.merchantName || a.description)?.trim(),
            category: a.merchantInfo?.merchantCategoryType || undefined,
            imported_id: item.id ? `samsung-${item.id}` : undefined,
        };
    }).filter(Boolean);
}

export function parseMoney(str) {
    if (str == null) return null;
    const n = Number(String(str).replace(/[^0-9.-]/g, ""));
    return Number.isNaN(n) ? null : Math.round(n * 100);
}
