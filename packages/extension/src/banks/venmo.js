import { isoDate, offsetDate, parseCsvLine, alreadySyncedToday, openTabBackground, waitForTabClose, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../utils.js";
import { sendToHost } from '../host.js';

export async function syncVenmo(settings, accountMappings, retried = false) {
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates["venmo-cash"] || syncFromDate;

    if (!startDate) {
        console.warn("Venmo: no sync start date configured, skipping.");
        return;
    }

    if (alreadySyncedToday(lastSyncDates, "venmo-cash")) {
        console.log("Venmo: already synced today, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);
    console.log(`Venmo sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings["venmo-cash"];
    if (!actualAccountId) return;

    await closeExistingVenmoTabs();
    await clearVenmoCookies();
    const tab = await openTabBackground("https://venmo.com");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let profileId;
    try {
        profileId = await pollForVenmoProfileId(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        if (retried) {
            console.error("Venmo: login failed after retry, giving up.");
            await chrome.storage.local.set({ venmoError: "Venmo login failed. If this keeps happening, try restarting Edge." });
            return;
        }
        const tab2 = await openTabBackground("https://venmo.com");
        chrome.tabs.update(tab2.id, { active: true });
        chrome.windows.update(tab2.windowId, { focused: true });
        console.log("Venmo: waiting for login...");
        await waitForTabClose(tab2.id);
        await syncVenmo(settings, accountMappings, true);
        return;
    }

    chrome.tabs.remove(tab.id);

    try {
        const transactions = await fetchVenmoTransactions(profileId, startDate, today);
        if (transactions.length > 0) {
            console.log(`Venmo: importing ${transactions.length} transactions.`);
            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
        } else {
            console.log("Venmo: no new transactions.");
        }
    } catch (err) {
        console.error("Venmo failed:", err.message);
    }

    lastSyncDates["venmo-cash"] = today;
    await chrome.storage.local.set({ lastSyncDates });
    await chrome.storage.local.remove("venmoError");
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

function pollForVenmoProfileId(tabId) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let venmoState = "wait-for-account"; // wait for account.venmo.com, then click statements, then get profile id

        const interval = setInterval(async () => {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for Venmo profile ID"));
                return;
            }

            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status !== "complete") return;

                if (venmoState === "wait-for-account" && tab.url?.includes("account.venmo.com")) {
                    const clicked = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            const link = document.querySelector('a[href="/statement"]');
                            if (link) { link.click(); return true; }
                            return false;
                        },
                    });
                    if (clicked?.[0]?.result) venmoState = "get-profile-id";

                } else if (venmoState === "get-profile-id" && tab.url?.includes("account.venmo.com/statement")) {
                    const result = await chrome.tabs.sendMessage(tabId, { type: "GET_VENMO_PROFILE_ID" });
                    if (result?.profileId) {
                        clearInterval(interval);
                        resolve(result.profileId);
                    }
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

async function fetchVenmoTransactions(profileId, startDate, endDate) {
    const url = `https://account.venmo.com/api/statement/download?startDate=${startDate}&endDate=${endDate}&csv=true&profileId=${profileId}&accountType=personal`;

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
            notes: notes,
            payee_name: payee,
            imported_id: `venmo-${id}`,
        });
    }

    return transactions;
}
