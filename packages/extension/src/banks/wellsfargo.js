import { isoDate, offsetDate, alreadySyncedToday, openTabBackground, waitForTabClose, parseCsvLine, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, updateLastSyncDate } from "../utils.js";
import { sendToHost } from "../host.js";

export async function syncWellsFargo(settings, accountMappings, retried = false) {
    const { lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get(["lastSyncDates", "syncFromDate"]);
    const startDate = lastSyncDates["wf-credit"] || syncFromDate;

    if (!startDate) {
        console.warn("WF: no sync start date configured, skipping.");
        return;
    }

    if (alreadySyncedToday(lastSyncDates, "wf-credit")) {
        console.log("WF: already synced today, skipping.");
        return;
    }

    const today = offsetDate(isoDate(new Date()), -1);
    console.log(`WF sync: ${startDate} → ${today}`);

    const actualAccountId = accountMappings["wf-credit"];
    if (!actualAccountId) return;

    const tab = await openTabBackground("https://www.wellsfargo.com/");
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });

    let wfData;
    try {
        wfData = await pollForWFData(tab.id);
        console.log("WF download URL:", wfData.downloadUrl);
    } catch (err) {
        chrome.tabs.remove(tab.id);
        if (retried) {
            console.error("WF: login failed after retry, giving up.");
            return;
        }
        const tab2 = await openTabBackground("https://connect.secure.wellsfargo.com/services/downloadactivity/showform");
        chrome.tabs.update(tab2.id, { active: true });
        chrome.windows.update(tab2.windowId, { focused: true });
        console.log("WF: waiting for login...");
        await waitForTabClose(tab2.id);
        await syncWellsFargo(settings, accountMappings, true);
        return;
    }

    // Format dates as MM/DD/YYYY for WF
    const fromDate = formatWFDate(startDate);
    const toDate = formatWFDate(today);

    let csvData;
    try {
        const result = await chrome.tabs.sendMessage(tab.id, {
            type: "FETCH_WF_TRANSACTIONS",
            accountId: wfData.accountId,
            downloadUrl: `https://connect.secure.wellsfargo.com/services${wfData.downloadUrl}`,
            startDate: fromDate,
            endDate: toDate,
        });
        if (result.error) throw new Error(result.error);
        csvData = result.data;
    } catch (err) {
        console.error("WF fetch failed:", err.message);
        chrome.tabs.remove(tab.id);
        return;
    }

    chrome.tabs.remove(tab.id);

    try {
        const transactions = parseWFCsv(csvData);
        if (transactions.length > 0) {
            console.log(`WF: importing ${transactions.length} transactions.`);
            await sendToHost("importTransactions", {
                settings,
                accountId: actualAccountId,
                transactions,
            });
        } else {
            console.log("WF: no new transactions.");
        }
    } catch (err) {
        console.error("WF import failed:", err.message);
    }

    await updateLastSyncDate("wf-credit", today);
}

function pollForWFData(tabId) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let wfState = "click-card";
        let clickedCard = false;
        let clickedDownload = false;

        const interval = setInterval(async () => {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                clearInterval(interval);
                reject(new Error("Timed out waiting for WF data"));
                return;
            }

            try {
                const tab = await chrome.tabs.get(tabId);
                console.log("WF state:", wfState, "url:", tab.url);

                if (tab.status !== "complete") return;

                if (wfState === "click-card" && tab.url?.includes("accountsummary")) {
                    if (!clickedCard) {
                        const clicked = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const btn = document.querySelector('[data-testid="WELLS FARGO AUTOGRAPH VISA® CARD-title"]')?.closest("button");
                                if (btn) { btn.click(); return true; }
                                return false;
                            },
                        });
                        if (clicked?.[0]?.result) {
                            clickedCard = true;
                            wfState = "click-download";
                        }
                    }

                } else if (wfState === "click-download" && tab.url?.includes("accountdetails")) {
                    if (!clickedDownload) {
                        const clicked = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const btn = document.querySelector('[data-testid="download-account-activity-link"]');
                                if (btn) { btn.click(); return true; }
                                return false;
                            },
                        });
                        if (clicked?.[0]?.result) {
                            clickedDownload = true;
                            wfState = "get-data";
                        }
                    }

                } else if (wfState === "get-data" && tab.url?.includes("download-account-activity")) {
                    const result = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: "MAIN",
                        func: () => {
                            const data = window._wfPayload?.applicationData?.downloadAccountActivity;
                            const accountId = data?.downloadAccountInfo?.allEligibleAccounts?.[0]?.id;
                            const downloadUrl = data?.urls?.find(u => u.id === "downloadFile")?.url;
                            return { accountId, downloadUrl };
                        },
                    });
                    const { accountId, downloadUrl } = result?.[0]?.result || {};
                    if (accountId && downloadUrl) {
                        clearInterval(interval);
                        resolve({ accountId, downloadUrl });
                    }
                }
            } catch {
                // Tab not ready yet
            }
        }, POLL_INTERVAL_MS);
    });
}

function formatWFDate(isoStr) {
    const [year, month, day] = isoStr.split("-");
    return `${month}/${day}/${year}`;
}

function parseWFCsv(csv) {
    const lines = csv.trim().split("\n");
    if (lines.length < 1) return [];

    const transactions = [];

    for (const line of lines) {
        const cols = parseCsvLine(line);
        // "date","amount","*","","description"
        const date = cols[0]?.replace(/"/g, "").trim();
        const amountStr = cols[1]?.replace(/"/g, "").trim();
        const description = cols[4]?.replace(/"/g, "").trim();

        if (!date || !amountStr) continue;

        const raw = parseFloat(amountStr);
        // WF: positive = payment/credit, negative = charge
        const amount = Math.round(raw * 100);

        transactions.push({
            date: formatISODate(date),
            amount,
            payee_name: description,
            imported_id: `wf-${date}-${amountStr}-${description}`,
        });
    }

    return transactions;
}

function formatISODate(mmddyyyy) {
    const [month, day, year] = mmddyyyy.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
