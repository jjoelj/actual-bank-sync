import { syncSoFi, getSoFiAccountsForPopup } from "./banks/sofi.js";
import { syncVenmo } from "./banks/venmo.js";
import { syncBilt } from "./banks/bilt.js";
import { syncCapitalOne } from "./banks/capitalone.js";
import { syncFidelity } from "./banks/fidelity.js";
import { syncTarget } from "./banks/target.js";
import { syncWellsFargo } from "./banks/wellsfargo.js";
import { sendToHost } from "./host.js";
import { ACCOUNT_TYPES } from "./accounts.js";

const SINGLE_ACCOUNT_SYNC = {
  bilt:       syncBilt,
  capitalone: syncCapitalOne,
  fidelity:   syncFidelity,
  target:     syncTarget,
  wf:         syncWellsFargo,
};

// background.js - service worker
// Schedules sync only when the oldest mapped account is at least a week stale

const ALARM_NAME = "scheduled-sync";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ALARM_DELAY_MS = 60 * 1000;

function sendProgress(key, percent, message) {
  chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", key, percent, message }).catch(() => {});
}

// ── Alarm setup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  scheduleNextSyncAlarm().catch((err) => console.error("Failed to schedule sync alarm:", err));
  console.log("Actual Bank Sync installed, alarm scheduled.");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runSync().catch((err) => console.error("Sync failed:", err));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || syncInProgress) return;
  if (!changes.accountMappings && !changes.lastSyncDates && !changes.syncFromDate) return;
  scheduleNextSyncAlarm().catch((err) => console.error("Failed to reschedule sync alarm:", err));
});

// ── Sync orchestration ───────────────────────────────────────────────────────

let syncInProgress = false;

async function runSync(options = {}) {
  if (syncInProgress) {
    console.log("Sync already in progress, skipping.");
    return;
  }
  syncInProgress = true;
  const syncSessionId = Date.now();
  try {
  await chrome.storage.local.set({
    activeSyncSessionId: syncSessionId,
    activeSyncSummary: {
      sessionId: syncSessionId,
      byKey: {},
      syncedAccounts: 0,
      transactionCount: 0,
      inflow: 0,
      outflow: 0,
    },
  });
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

  const scopedMappings = options.targetKeys?.length
    ? Object.fromEntries(Object.entries(accountMappings).filter(([key]) => options.targetKeys.includes(key)))
    : accountMappings;

  const keys = Object.keys(scopedMappings);

  const sofiKeys = keys.filter(k => k.startsWith("sofi-"));
  if (sofiKeys.length) {
    sofiKeys.forEach(k => sendProgress(k, 5, "Opening SoFi"));
    await syncSoFi(settings, scopedMappings, getSyncOptionsForKeys(options, sofiKeys, (key, percent, message) => sendProgress(key, percent, message)));
    sofiKeys.forEach(k => sendProgress(k, null));
  }

  const venmoKeys = keys.filter(k => ACCOUNT_TYPES[k]?.bank === "venmo");
  if (venmoKeys.length) {
    venmoKeys.forEach(k => sendProgress(k, 5, "Opening Venmo"));
    await syncVenmo(settings, scopedMappings, getSyncOptionsForKeys(options, venmoKeys, (key, percent, message) => sendProgress(key, percent, message)));
    venmoKeys.forEach(k => sendProgress(k, null));
  }

  for (const key of keys) {
    const syncFn = SINGLE_ACCOUNT_SYNC[ACCOUNT_TYPES[key]?.bank];
    if (syncFn) {
      sendProgress(key, 5, "Opening bank");
      await syncFn(settings, scopedMappings, key, getSyncOptionsForKeys(options, [key], (percent, message) => sendProgress(key, percent, message)));
      sendProgress(key, null);
    }
  }

  const { lastSyncMetrics = {}, lastSyncDates = {} } = await chrome.storage.local.get(["lastSyncMetrics", "lastSyncDates"]);
  const mappedKeys = Object.keys(accountMappings);
  const syncedAccounts = mappedKeys.filter(k => lastSyncDates[k]).length;
  const metricValues = mappedKeys.map(k => lastSyncMetrics[k]).filter(Boolean);
  const newSummary = syncedAccounts > 0
    ? metricValues.reduce((acc, m) => ({
        ...acc,
        transactionCount: acc.transactionCount + (m.count || 0),
        inflow: acc.inflow + (m.inflow || 0),
        outflow: acc.outflow + (m.outflow || 0),
      }), { syncedAccounts, transactionCount: 0, inflow: 0, outflow: 0 })
    : undefined;
  await chrome.storage.local.set({
    lastSyncTime: Date.now(),
    lastCompletedSyncSessionId: syncSessionId,
    ...(newSummary !== undefined ? { lastCompletedSyncSummary: newSummary } : {}),
  });
  console.log("Sync complete.");

  await scheduleNextSyncAlarm();
  await notifyPopup();

  } finally {
    await chrome.storage.local.remove(["activeSyncSessionId", "activeSyncSummary"]);
    syncInProgress = false;
    await scheduleNextSyncAlarm();
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
    runSync(msg.options || {})
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
  const { lastSyncDates = {}, lastSyncTime, nextScheduledSyncAt = null } = await chrome.storage.local.get(["lastSyncDates", "lastSyncTime", "nextScheduledSyncAt"]);
  chrome.runtime.sendMessage({ type: "SYNC_UPDATED", lastSyncDates, lastSyncTime, nextScheduledSyncAt }).catch(() => {});
}

function getSyncOptionsForKeys(options, keys, onProgress) {
  const syncOptions = { onProgress };
  if (!options.forceDays || !options.forceKeys?.length) return syncOptions;
  const matchingForceKeys = options.forceKeys.filter(key => keys.includes(key));
  if (!matchingForceKeys.length) return syncOptions;
  return {
    ...syncOptions,
    forceDays: options.forceDays,
  };
}

async function scheduleNextSyncAlarm() {
  const { accountMappings = {}, lastSyncDates = {}, syncFromDate } = await chrome.storage.local.get([
    "accountMappings",
    "lastSyncDates",
    "syncFromDate",
  ]);

  const mappedKeys = Object.keys(accountMappings);
  if (!mappedKeys.length) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({ nextScheduledSyncAt: null });
    return;
  }

  const candidateTimes = mappedKeys
    .map((key) => lastSyncDates[key] || syncFromDate)
    .filter(Boolean)
    .map((isoStr) => new Date(`${isoStr}T12:00:00`).getTime() + WEEK_MS);

  if (!candidateTimes.length) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({ nextScheduledSyncAt: null });
    return;
  }

  const nextWhen = Math.max(Math.min(...candidateTimes), Date.now() + MIN_ALARM_DELAY_MS);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { when: nextWhen });
  await chrome.storage.local.set({ nextScheduledSyncAt: nextWhen });
}
