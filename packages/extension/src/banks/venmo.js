import { getSyncPlan, parseCsvLine, openTabBackground, reportProgress, updateLastSyncDate, updateLastSyncCount, updateLastSyncMetrics, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../utils.js";
import { sendToHost } from '../host.js';

export async function syncVenmo(settings, accountMappings, options = {}) {
    console.log("Venmo: starting");
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);

    const cashAccountId = accountMappings["venmo-cash"];
    const creditAccountId = accountMappings["venmo-credit"];
    const cashPlan = cashAccountId ? getSyncPlan(lastSyncDates, syncFromDate, "venmo-cash", options) : null;
    const creditPlan = creditAccountId ? getSyncPlan(lastSyncDates, syncFromDate, "venmo-credit", options) : null;
    const needsCash = cashAccountId && cashPlan?.shouldSync;
    const needsCredit = creditAccountId && creditPlan?.shouldSync;

    if (!needsCash && !needsCredit) {
        console.log("Venmo: already synced today, skipping.");
        return;
    }

    const cashStart = cashPlan?.startDate;
    const creditStart = creditPlan?.startDate;
    const today = cashPlan?.endDate || creditPlan?.endDate;

    if (needsCash && !cashStart) {
        console.warn("Venmo: no sync start date configured, skipping.");
        return;
    }
    if (needsCredit && !creditStart) {
        console.warn("Venmo Credit: no sync start date configured, skipping.");
        return;
    }

    await closeExistingVenmoTabs();
    await clearVenmoCookies();
    const tab = await openTabBackground("https://venmo.com");
    if (needsCash) reportProgress(options, "venmo-cash", 15, "Opening Venmo…");
    if (needsCredit) reportProgress(options, "venmo-credit", 15, "Opening Venmo…");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let venmoData;
    try {
        venmoData = await pollForVenmoData(tab.id, { needsProfileId: needsCash, needsBearerToken: needsCredit }, (t) => {
            if (needsCash) reportProgress(options, "venmo-cash", 15 + Math.round(t * 35), "Logging in…");
            if (needsCredit) reportProgress(options, "venmo-credit", 15 + Math.round(t * 35), "Logging in…");
        });
    } catch (err) {
        chrome.tabs.remove(tab.id);
        console.error("Venmo: login failed, giving up.");
        await setSyncError("venmo-cash", "Login failed. Please log in and run sync again.");
        return;
    }

    chrome.tabs.remove(tab.id);

    if (needsCash) {
        console.log(`Venmo sync: ${cashStart} → ${today}`);
        try {
            reportProgress(options, "venmo-cash", 55, "Fetching transactions");
            const transactions = await fetchVenmoTransactions(venmoData.profileId, cashStart, today);
            if (transactions.length > 0) {
                reportProgress(options, "venmo-cash", 80, `Importing ${transactions.length} transactions`);
                console.log(`Venmo: importing ${transactions.length} transactions.`);
                await sendToHost("importTransactions", { settings, accountId: cashAccountId, transactions });
            } else {
                console.log("Venmo: no new transactions.");
            }
            await updateLastSyncCount("venmo-cash", transactions.length);
            await updateLastSyncMetrics("venmo-cash", transactions);
            reportProgress(options, "venmo-cash", 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error("Venmo failed:", err.message);
        }
        if (!cashPlan.isForced) await updateLastSyncDate("venmo-cash", today);
        await clearSyncError("venmo-cash");
    }

    if (needsCredit) {
        console.log(`Venmo Credit sync: ${creditStart} → ${today}`);
        try {
            reportProgress(options, "venmo-credit", 55, "Fetching transactions");
            const transactions = await fetchVenmoCreditTransactions(venmoData.bearerToken, creditStart, today);
            if (transactions.length > 0) {
                reportProgress(options, "venmo-credit", 80, `Importing ${transactions.length} transactions`);
                console.log(`Venmo Credit: importing ${transactions.length} transactions.`);
                await sendToHost("importTransactions", { settings, accountId: creditAccountId, transactions });
            } else {
                console.log("Venmo Credit: no new transactions.");
            }
            await updateLastSyncCount("venmo-credit", transactions.length);
            await updateLastSyncMetrics("venmo-credit", transactions);
            reportProgress(options, "venmo-credit", 100, transactions.length ? `Imported ${transactions.length}` : "No new transactions");
        } catch (err) {
            console.error("Venmo Credit failed:", err.message);
        }
        if (!creditPlan.isForced) await updateLastSyncDate("venmo-credit", today);
    }
}

async function setSyncError(key, message) {
    const { syncErrors = {} } = await chrome.storage.local.get("syncErrors");
    syncErrors[key] = message;
    await chrome.storage.local.set({ syncErrors });
}

async function clearSyncError(key) {
    const { syncErrors = {} } = await chrome.storage.local.get("syncErrors");
    delete syncErrors[key];
    await chrome.storage.local.set({ syncErrors });
}

async function closeExistingVenmoTabs() {
    const tabs = await chrome.tabs.query({ url: "*://*.venmo.com/*" });
    for (const tab of tabs) {
        await chrome.tabs.remove(tab.id);
    }
}

async function clearVenmoCookies() {
    const cookies = await chrome.cookies.getAll({ domain: ".venmo.com" });
    for (const cookie of cookies) {
        await chrome.cookies.remove({
            url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
            name: cookie.name,
        });
    }
}

function pollForVenmoData(tabId, { needsProfileId, needsBearerToken }, onTick) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let dataPageStart = null;
        let clickedStatements = false;

        function onTabUpdated(updatedTabId, changeInfo) {
            if (updatedTabId !== tabId) return;
            if (!changeInfo.url?.includes("account.venmo.com")) return;
            chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                injectImmediately: true,
                func: () => {
                    if (window._venmoIntercepted) return;
                    window._venmoIntercepted = true;
                    const _fetch = window.fetch;
                    window.fetch = function(...args) {
                        let auth;
                        const h = args[1]?.headers;
                        if (h) auth = h instanceof Headers ? h.get("authorization") : (h.authorization || h.Authorization);
                        if (!auth && args[0] instanceof Request) auth = args[0].headers.get("authorization");
                        if (auth?.startsWith("Bearer ")) window._capturedBearer = auth.slice(7);
                        return _fetch.apply(this, args);
                    };
                },
            }).catch(() => {});
        }

        if (needsBearerToken) chrome.tabs.onUpdated.addListener(onTabUpdated);

        const cleanup = () => chrome.tabs.onUpdated.removeListener(onTabUpdated);

        const interval = setInterval(async () => {
            const elapsed = Date.now() - start;
            onTick?.(Math.min(elapsed / POLL_TIMEOUT_MS, 0.99));
            try {
                const tab = await chrome.tabs.get(tabId);

                if (!tab.url?.includes("account.venmo.com")) {
                    dataPageStart = null;
                    clickedStatements = false;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    cleanup();
                    reject(new Error("Timed out waiting for Venmo data"));
                    return;
                }

                if (tab.status !== "complete") return;

                if (!clickedStatements) {
                    const clicked = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            const link = document.querySelector('a[href="/statement"]');
                            if (link) { link.click(); return true; }
                            return false;
                        },
                    });
                    if (clicked?.[0]?.result) clickedStatements = true;
                    return;
                }

                if (!tab.url?.includes("account.venmo.com/statement")) return;

                if (tab.status !== "complete") return;

                let profileId = null;
                let bearerToken = null;

                if (needsProfileId) {
                    const result = await chrome.tabs.sendMessage(tabId, { type: "GET_VENMO_PROFILE_ID" }).catch(() => null);
                    profileId = result?.profileId ?? null;
                }

                if (needsBearerToken) {
                    const result = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: "MAIN",
                        func: () => window._capturedBearer ?? null,
                    });
                    bearerToken = result?.[0]?.result ?? null;
                }

                const gotAll = (!needsProfileId || profileId) && (!needsBearerToken || bearerToken);
                if (gotAll) {
                    clearInterval(interval);
                    cleanup();
                    resolve({ profileId, bearerToken });
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

async function fetchVenmoTransactions(profileId, startDate, endDate) {
    const url = `https://account.venmo.com/api/statement/download?startDate=${startDate}&endDate=${endDate}&csv=true&profileId=${profileId}&accountType=personal`;
    console.log("Venmo: fetching", url);
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Venmo export failed: ${response.status}`);

    const csv = await response.text();
    return parseVenmoCsv(csv, startDate, endDate);
}

function parseVenmoCsv(csv, startDate, endDate) {
    const lines = csv.trim().split("\n");
    if (lines.length < 4) return [];

    const transactions = [];

    for (let i = 3; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const id = cols[1]?.trim();
        const datetime = cols[2]?.trim();
        const type = cols[3]?.trim();
        const status = cols[4]?.trim();
        const note = cols[5]?.trim();
        const from = cols[6]?.trim();
        const destination = cols[15]?.trim();
        const amountRaw = cols[8]?.trim();

        if (!id || !datetime || !amountRaw) continue;
        if (status && status !== "Complete" && status !== "Issued") continue;

        const amountMatch = amountRaw.match(/([+-])\s*\$\s*([\d.]+)/);
        if (!amountMatch) continue;

        const sign = amountMatch[1] === "+" ? 1 : -1;
        const amount = Math.round(parseFloat(amountMatch[2]) * 100) * sign;
        const date = datetime.split("T")[0];

        if (startDate && date < startDate) continue;
        if (endDate && date > endDate) continue;

        const payee = type === "Payment" && sign === 1 ? from : destination || type;
        const notes = type === "Payment" ? note : type;

        transactions.push({
            date,
            amount,
            notes,
            payee_name: payee,
            imported_id: `venmo-${id}`,
        });
    }

    return transactions;
}

async function fetchVenmoCreditTransactions(bearerToken, startDate, endDate) {
    const allTransactions = [];
    let pageNumber = 1;
    let pageToken = null;

    while (true) {
        let url = `https://api.venmo.com/v1/credit-card/transactions?page_number=${pageNumber}`;
        if (pageToken) url += `&ledger_page_token=${pageToken}`;
        console.log("Venmo Credit: fetching", url);

        const res = await fetch(url, {
            headers: {
                authorization: `Bearer ${bearerToken}`,
                accept: "application/json",
            },
        });

        if (!res.ok) throw new Error(`Venmo Credit transactions failed: ${res.status}`);
        const body = await res.json();
        const page = body.data || body;

        let reachedStart = false;
        for (const tx of page) {
            const date = tx.created_at?.split("T")[0];
            if (!date) continue;
            if (date > endDate) continue;
            if (date < startDate) { reachedStart = true; break; }
            if (tx.status !== "settled") continue;

            const amount = tx.amount * -1;
            const payee = tx.merchant?.name || tx.description;

            allTransactions.push({
                date,
                amount,
                payee_name: payee,
                imported_id: `venmo-credit-${tx.id}`,
            });
        }

        if (reachedStart) break;

        pageToken = body.pagination?.next_ledger_page_token;
        if (!pageToken) break;
        pageNumber++;
    }

    return allTransactions;
}
