import { syncSoFi, getSoFiAccountsForPopup } from "./banks/sofi.js";
import { syncVenmo } from "./banks/venmo.js";
import { syncBilt } from "./banks/bilt.js";
import { syncCapitalOne } from "./banks/capitalone.js";
import { syncFidelity } from "./banks/fidelity.js";
import { syncTarget } from "./banks/target.js";
import { syncWellsFargo } from "./banks/wellsfargo.js";
import { sendToHost } from "./host.js";

// background.js - service worker
// Handles daily alarms and orchestrates sync for each bank

const ALARM_NAME = "daily-sync";
const ALARM_PERIOD_MINUTES = 24 * 60;

// ── Alarm setup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: ALARM_PERIOD_MINUTES,
  });
  console.log("Actual Bank Sync installed, alarm scheduled.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runSync().catch((err) => console.error("Sync failed:", err));
  }
});

// ── Sync orchestration ───────────────────────────────────────────────────────

let syncInProgress = false;

async function runSync() {
  if (syncInProgress) {
    console.log("Sync already in progress, skipping.");
    return;
  }
  syncInProgress = true;
  try {
  console.log("Starting sync...");

  const settings = await chrome.storage.sync.get([
    "actualUrl",
    "actualPassword",
    "actualSyncId",
    "actualFilePassword",
  ]);

  if (!settings.actualUrl || !settings.actualPassword || !settings.actualSyncId) {
    console.warn("Sync skipped: Actual settings not configured.");
    return;
  }

  // Get account mappings (bankKey → actualAccountId)
  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");

  if (Object.keys(accountMappings).length === 0) {
    console.warn("Sync skipped: No account mappings configured.");
    return;
  }

  if (accountMappings["sofi-credit"] || Object.keys(accountMappings).some(k => k.startsWith("sofi-"))) await syncSoFi(settings, accountMappings);
  if (accountMappings["venmo-cash"] || accountMappings["venmo-credit"]) await syncVenmo(settings, accountMappings);
  if (accountMappings["bilt-credit"]) await syncBilt(settings, accountMappings);
  if (accountMappings["capitalone-credit"]) await syncCapitalOne(settings, accountMappings);
  if (accountMappings["fidelity-credit"]) await syncFidelity(settings, accountMappings);
  if (accountMappings["target-credit"]) await syncTarget(settings, accountMappings);
  if (accountMappings["wf-credit"]) await syncWellsFargo(settings, accountMappings);

  await chrome.storage.local.set({ lastSyncTime: Date.now() });
  console.log("Sync complete.");

  await notifyPopup();

  } finally {
    syncInProgress = false;
  }
}

// ── Message handler (from popup) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TEST_CONNECTION") {
    sendToHost("testConnection", { settings: msg.settings })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_ACTUAL_ACCOUNTS") {
    sendToHost("getAccounts", { settings: msg.settings })
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async
  }

  if (msg.type === "RUN_SYNC") {
    if (syncInProgress) {
      sendResponse({ error: "Sync already in progress" });
      return true;
    }
    runSync()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SOFI_ACCOUNTS") {
    getSoFiAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "IMPORT_TRANSACTIONS") {
    sendToHost("importTransactions", {
      settings: msg.settings,
      accountId: msg.accountId,
      transactions: msg.transactions,
    })
        .then((result) => sendResponse({ result }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function notifyPopup() {
  const { lastSyncDates = {}, lastSyncTime } = await chrome.storage.local.get(["lastSyncDates", "lastSyncTime"]);
  chrome.runtime.sendMessage({ type: "SYNC_UPDATED", lastSyncDates, lastSyncTime }).catch(() => {});
}
