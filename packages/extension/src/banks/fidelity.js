import { isoDate, offsetDate, alreadySyncedToday, openTabBackground, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, updateLastSyncDate } from "../utils.js";
import { sendToHost } from "../host.js";

export async function syncFidelity(settings, accountMappings) {
    console.log("Fidelity: starting");
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates["fidelity-credit"] || syncFromDate;

    if (!startDate) {
        console.warn("Fidelity: no sync start date configured, skipping.");
        return;
    }

    if (alreadySyncedToday(lastSyncDates, "fidelity-credit")) {
        console.log("Fidelity: already synced today, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);
    console.log(`Fidelity sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings["fidelity-credit"];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://digital.fidelity.com/ftgw/digital/portfolio/summary");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let fidelityData;
    try {
        fidelityData = await pollForFidelityData(tab.id);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        console.error("Fidelity: login failed, giving up.");
        return;
    }

    let csvData;
    try {
        const result = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_FIDELITY_TRANSACTIONS",
            accessToken: fidelityData.accessToken,
            accountToken: fidelityData.accountToken,
            startDate,
            endDate: today,
        });
        if (result.error) throw new Error(result.error);
        csvData = result.data;
    } catch (err) {
        console.error("Fidelity fetch failed:", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    chrome.tabs.remove(tab.id);

    try {
        const transactions = parseFidelityCsv(csvData);
        if (transactions.length > 0) {
            console.log(`Fidelity: importing ${transactions.length} transactions.`);
            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
        } else {
            console.log("Fidelity: no new transactions.");
        }
    } catch (err) {
        console.error("Fidelity import failed:", err.message);
    }

    await updateLastSyncDate("fidelity-credit", today);
}

function pollForFidelityData(tabId) {
    return new Promise((resolve, reject) => {
        let dataPageStart = null;
        let trackingTabId = tabId;
        let clickedDownload = false;
        let fidelityState = "click-card";

        const interval = setInterval(async () => {
            try {
                const tab = await chrome.tabs.get(trackingTabId);
                console.log("fidelity state:", fidelityState, "url:", tab.url, "status:", tab.status);

                const onFidelityPage = tab.url?.includes("digital.fidelity.com") || tab.url?.includes("login.fidelityrewards.com");
                if (!onFidelityPage) {
                    dataPageStart = null;
                    return;
                }

                if (!dataPageStart) dataPageStart = Date.now();
                if (Date.now() - dataPageStart > POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    reject(new Error("Timed out waiting for Fidelity data"));
                    return;
                }

                if (tab.status !== "complete") return;

                if (fidelityState === "click-card" && tab.url?.includes("digital.fidelity.com")) {
                    const clicked = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            const link = Array.from(document.querySelectorAll("a[id]"))
                                .find(a => /^\d{4}$/.test(a.id));
                            if (link) { link.click(); return true; }
                            return false;
                        },
                    });
                    if (clicked?.[0]?.result) fidelityState = "click-download";
                } else if (fidelityState === "click-download" && tab.url?.includes("digital.fidelity.com")) {
                    if (!clickedDownload) {
                        clickedDownload = true;

                        chrome.tabs.onCreated.addListener(function createdListener(newTab) {
                            chrome.tabs.onCreated.removeListener(createdListener);

                            chrome.tabs.onUpdated.addListener(function updatedListener(updatedTabId, changeInfo) {
                                if (updatedTabId !== newTab.id) return;
                                if (changeInfo.url?.includes("fidelityrewards.com")) {
                                    chrome.tabs.onUpdated.removeListener(updatedListener);
                                    const url = changeInfo.url;
                                    chrome.tabs.update(trackingTabId, { url });
                                    chrome.tabs.remove(newTab.id);
                                    fidelityState = "get-data";
                                }
                            });
                        });

                        await chrome.scripting.executeScript({
                            target: { tabId: trackingTabId },
                            world: "MAIN",
                            func: () => {
                                const link = Array.from(document.querySelectorAll("a"))
                                    .find(l => l.textContent.includes("Download transactions"));
                                link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                            },
                        });
                    }
                } else if (fidelityState === "get-data" && tab.url?.includes("login.fidelityrewards.com/digital/servicing")) {
                    const result = await chrome.tabs.sendMessage(tabId, { type: "GET_FIDELITY_DATA" });
                    if (result?.accessToken && result?.accountToken) {
                        clearInterval(interval);
                        resolve(result);
                    }
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function parseFidelityCsv(csv) {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    const transactions = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        // "Date","Transaction","Name","Memo","Amount"
        const date = cols[0]?.replace(/"/g, "").trim();
        const transaction = cols[1]?.replace(/"/g, "").trim();
        const name = cols[2]?.replace(/"/g, "").trim();
        const amountStr = cols[4]?.replace(/"/g, "").trim();

        if (!date || !amountStr) continue;

        const amount = Math.round(parseFloat(amountStr) * 100);

        transactions.push({
            date,
            amount,
            notes: transaction,
            payee_name: name,
            imported_id: `fidelity-${date}-${amountStr}-${name}`,
        });
    }

    return transactions;
}
