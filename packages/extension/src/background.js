import { installLogCapture, clearLogBuffer } from "./logger.js";
installLogCapture();

import { syncSoFi, getSoFiAccountsForPopup } from "./banks/sofi.js";
import { syncVenmo } from "./banks/venmo.js";
import { syncBilt } from "./banks/bilt.js";
import { syncCapitalOne, getCapitalOneAccountsForPopup } from "./banks/capitalone.js";
import { syncFidelity } from "./banks/fidelity.js";
import { syncTarget } from "./banks/target.js";
import { syncUSBank, getUSBankAccountsForPopup } from "./banks/usbank.js";
import { syncWellsFargo, getWellsFargoAccountsForPopup } from "./banks/wellsfargo.js";
import * as sure from "./sure.js";
import { sendToHost } from "./host.js";
import { ACCOUNT_TYPES } from "./accounts.js";
import { pacificDate, flushPendingCategories, appTargets, migrateAccountMappings } from "./utils.js";

const SINGLE_ACCOUNT_SYNC = {
  bilt:     syncBilt,
  fidelity: syncFidelity,
  target:   syncTarget,
};

const ALARM_NAME = "scheduled-sync";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ALARM_DELAY_MS = 60 * 1000;

// ── App configuration ────────────────────────────────────────────────────────

const SETTINGS_KEYS = ["sureApiKey", "sureUrl", "actualUrl", "actualPassword", "actualSyncId", "actualFilePassword"];

function getStoredSettings() {
  return chrome.storage.sync.get(SETTINGS_KEYS);
}

function sureConfigured(settings) {
  return Boolean(settings.sureApiKey && settings.sureUrl);
}

function actualConfigured(settings) {
  return Boolean(settings.actualUrl && settings.actualPassword && settings.actualSyncId);
}

function sendProgress(key, percent, message) {
  chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", key, percent, message }).catch(() => {});
}

// Per-account progress reporter for flushes (upload phase only). A null message
// clears the row's progress; otherwise the 0→1 fraction maps onto the full bar.
function sendFlushProgress(key, frac, message) {
  if (message == null) sendProgress(key, null);
  else sendProgress(key, Math.round(frac * 100), message);
}

// ── Alarm setup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  migrateAccountMappings().catch((err) => console.error("Mapping migration failed:", err));
  scheduleNextSyncAlarm().catch((err) => console.error("Failed to schedule sync alarm:", err));
  console.log("Bank Sync installed, alarm scheduled.");
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
let flushQueued = false;

// Coalescing flush driver. Requests that arrive while a sync or an earlier flush
// is running don't get dropped — they set flushQueued, and the in-flight run
// loops to pick them up (or runSync drains on completion). This way mapping a
// category while a previous flush is still running still imports.
function requestFlush() {
  flushQueued = true;
  pumpFlush();
}

async function pumpFlush() {
  if (syncInProgress) return;       // a sync or flush is running; it will drain on completion
  if (!flushQueued) return;
  syncInProgress = true;
  try {
    while (flushQueued) {
      flushQueued = false;
      try {
        const settings = await getStoredSettings();
        const { added } = await flushPendingCategories(settings, undefined, sendFlushProgress);
        if (added) console.log(`Flushed ${added} mapped transaction(s).`);
      } catch (err) {
        console.warn("Flush failed:", err.message);
      }
    }
  } finally {
    syncInProgress = false;
  }
  await notifyPopup();
}

// Fetch current balances from each configured app, keyed by mapping key:
// appBalances[key] = { sure: cents|null, actual: cents|null }.
async function fetchAppBalances(settings, accountMappings) {
  let sureBalanceById = {};
  let actualBalanceById = {};
  if (sureConfigured(settings)) {
    try {
      const accounts = await sure.getAccounts();
      sureBalanceById = Object.fromEntries(accounts.map(a => [a.id, a.balance_cents]));
    } catch (err) {
      console.warn("Failed to fetch Sure balances:", err.message);
    }
  }
  if (actualConfigured(settings)) {
    try {
      const accounts = await sendToHost("getAccounts", { settings });
      actualBalanceById = Object.fromEntries(accounts.map(a => [a.id, a.balance_cents]));
    } catch (err) {
      console.warn("Failed to fetch Actual balances:", err.message);
    }
  }

  const appBalances = {};
  for (const [key, mapping] of Object.entries(accountMappings)) {
    const target = appTargets(mapping);
    appBalances[key] = {
      sure:   target.sure   != null ? (sureBalanceById[target.sure]     ?? null) : null,
      actual: target.actual != null ? (actualBalanceById[target.actual] ?? null) : null,
    };
  }
  return appBalances;
}

async function runSync(options = {}) {
  if (syncInProgress) {
    console.log("Sync already in progress, skipping.");
    return;
  }
  syncInProgress = true;
  const syncSessionId = Date.now();
  try {
  await migrateAccountMappings();
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

  const settings = await getStoredSettings();

  if (!sureConfigured(settings) && !actualConfigured(settings)) {
    console.warn("Sync skipped: neither Sure nor Actual is configured.");
    return;
  }

  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");

  if (Object.keys(accountMappings).length === 0) {
    console.warn("Sync skipped: No account mappings configured.");
    return;
  }

  const appBalances = await fetchAppBalances(settings, accountMappings);

  const { lastSyncDates = {} } = await chrome.storage.local.get("lastSyncDates");
  const today = pacificDate(new Date());

  let scopedMappings;
  if (options.targetKeys?.length) {
    scopedMappings = Object.fromEntries(Object.entries(accountMappings).filter(([key]) => options.targetKeys.includes(key)));
  } else {
    scopedMappings = Object.fromEntries(Object.entries(accountMappings).filter(([key]) => lastSyncDates[key] !== today));
  }

  const keys = Object.keys(scopedMappings);

  // Safety net: import any held-back transactions whose category has since been
  // mapped (the popup also flushes immediately when a mapping is saved).
  try {
    const { added } = await flushPendingCategories(settings, keys, sendFlushProgress);
    if (added) console.log(`Flushed ${added} previously held transaction(s).`);
  } catch (err) {
    console.warn("Failed to flush pending categories:", err.message);
  }

  if (keys.length === 0) {
    console.log("All accounts already synced today.");
    return;
  }

  const sofiKeys = keys.filter(k => k.startsWith("sofi-"));
  if (sofiKeys.length) {
    sofiKeys.forEach(k => sendProgress(k, 5, "Opening SoFi"));
    const allSofiMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("sofi-")));
    await syncSoFi(settings, allSofiMappings, {
      ...getSyncOptionsForKeys(options, sofiKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: sofiKeys, appBalances,
    });
    sofiKeys.forEach(k => sendProgress(k, null));
  }

  const caponeKeys = keys.filter(k => k.startsWith("capitalone-"));
  if (caponeKeys.length) {
    caponeKeys.forEach(k => sendProgress(k, 5, "Opening Capital One"));
    const allCaponeMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("capitalone-")));
    await syncCapitalOne(settings, allCaponeMappings, {
      ...getSyncOptionsForKeys(options, caponeKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: caponeKeys, appBalances,
    });
    caponeKeys.forEach(k => sendProgress(k, null));
  }

  const usbankKeys = keys.filter(k => k.startsWith("usbank-"));
  if (usbankKeys.length) {
    usbankKeys.forEach(k => sendProgress(k, 5, "Opening US Bank"));
    const allUSBankMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => k.startsWith("usbank-")));
    await syncUSBank(settings, allUSBankMappings, {
      ...getSyncOptionsForKeys(options, usbankKeys, (key, percent, message) => sendProgress(key, percent, message)),
      syncKeys: usbankKeys, appBalances,
    });
    usbankKeys.forEach(k => sendProgress(k, null));
  }

  const wfKeys = keys.filter(k => k.startsWith("wf-"));
  for (const key of wfKeys) {
    sendProgress(key, 5, "Opening Wells Fargo");
    await syncWellsFargo(settings, scopedMappings, key, { ...getSyncOptionsForKeys(options, [key], (percent, message) => sendProgress(key, percent, message)), appBalances });
    sendProgress(key, null);
  }

  const venmoKeys = keys.filter(k => ACCOUNT_TYPES[k]?.bank === "venmo");
  if (venmoKeys.length) {
    venmoKeys.forEach(k => sendProgress(k, 5, "Opening Venmo"));
    await syncVenmo(settings, scopedMappings, { ...getSyncOptionsForKeys(options, venmoKeys, (key, percent, message) => sendProgress(key, percent, message)), appBalances });
    venmoKeys.forEach(k => sendProgress(k, null));
  }

  for (const key of keys) {
    const syncFn = SINGLE_ACCOUNT_SYNC[ACCOUNT_TYPES[key]?.bank];
    if (syncFn) {
      sendProgress(key, 5, "Opening bank");
      await syncFn(settings, scopedMappings, key, { ...getSyncOptionsForKeys(options, [key], (percent, message) => sendProgress(key, percent, message)), appBalances });
      sendProgress(key, null);
    }
  }

  const { lastSyncMetrics = {}, lastSyncDates: currentSyncDates = {} } = await chrome.storage.local.get(["lastSyncMetrics", "lastSyncDates"]);
  const mappedKeys = Object.keys(accountMappings);
  const syncedAccounts = mappedKeys.filter(k => currentSyncDates[k]).length;
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

  await notifyPopup();

  } finally {
    await chrome.storage.local.remove(["activeSyncSessionId", "activeSyncSummary"]);
    syncInProgress = false;
    await scheduleNextSyncAlarm();
    // Drain anything mapped while this sync was running (or queued meanwhile).
    requestFlush();
  }
}

// ── Categories (merged across apps) ──────────────────────────────────────────
// Category mappings store budget category names, resolved per app at import
// time, so the popup works against the union of both apps' categories.

async function getMergedCategories() {
  const settings = await getStoredSettings();
  const byName = new Map();
  if (sureConfigured(settings)) {
    try {
      for (const c of await sure.getCategories()) {
        if (!byName.has(c.name)) byName.set(c.name, c);
      }
    } catch (err) {
      console.warn("Failed to load Sure categories:", err.message);
    }
  }
  if (actualConfigured(settings)) {
    try {
      for (const c of await sendToHost("getCategories", { settings })) {
        if (!byName.has(c.name)) byName.set(c.name, c);
      }
    } catch (err) {
      console.warn("Failed to load Actual categories:", err.message);
    }
  }
  return [...byName.values()];
}

// Create the category in every configured app so the name resolves on both
// sides at import time.
async function createMergedCategory(name) {
  const settings = await getStoredSettings();
  let created = null;
  const errors = [];
  if (sureConfigured(settings)) {
    try {
      created = await sure.createCategory(name);
    } catch (err) {
      errors.push(`Sure: ${err.message}`);
    }
  }
  if (actualConfigured(settings)) {
    try {
      const c = await sendToHost("createCategory", { settings, name });
      created = created ?? c;
    } catch (err) {
      errors.push(`Actual: ${err.message}`);
    }
  }
  if (!created) throw new Error(errors.join("; ") || "No app configured");
  if (errors.length) console.warn("Category created partially:", errors.join("; "));
  return created;
}

// ── Per-app transaction maintenance (popup Reset / per-row delete) ───────────

async function getTransactionCount(app, accountId) {
  if (app === "sure") return sure.getTransactionCount(accountId);
  const settings = await getStoredSettings();
  return sendToHost("getTransactionCount", { settings, accountId });
}

async function deleteAllTransactions(app, accountId) {
  if (app === "sure") return sure.deleteAllTransactions(accountId);
  const settings = await getStoredSettings();
  return sendToHost("deleteAllTransactions", { settings, accountId });
}

// ── Message handler (from popup) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TEST_SURE_CONNECTION") {
    sure.testConnection()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "TEST_ACTUAL_CONNECTION") {
    sendToHost("testConnection", { settings: msg.settings })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SURE_ACCOUNTS") {
    sure.getAccounts()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_ACTUAL_ACCOUNTS") {
    getStoredSettings()
      .then((settings) => sendToHost("getAccounts", { settings }))
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
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

  if (msg.type === "GET_CATEGORIES") {
    getMergedCategories()
      .then((categories) => sendResponse({ categories }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "CREATE_CATEGORY") {
    createMergedCategory(msg.name)
      .then((category) => sendResponse({ category }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "FLUSH_PENDING_CATEGORIES") {
    requestFlush();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_SOFI_ACCOUNTS") {
    getSoFiAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_CAPITALONE_ACCOUNTS") {
    getCapitalOneAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_USBANK_ACCOUNTS") {
    getUSBankAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_TRANSACTION_COUNT") {
    getTransactionCount(msg.app, msg.accountId)
      .then((count) => sendResponse({ count }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "DELETE_ALL_TRANSACTIONS") {
    if (syncInProgress) {
      sendResponse({ error: "Sync in progress, try again later" });
      return true;
    }
    syncInProgress = true;
    deleteAllTransactions(msg.app, msg.accountId)
      .then((count) => sendResponse({ count }))
      .catch((err) => sendResponse({ error: err.message }))
      .finally(() => { syncInProgress = false; });
    return true;
  }

  if (msg.type === "GET_WF_ACCOUNTS") {
    getWellsFargoAccountsForPopup()
      .then((accounts) => sendResponse({ accounts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "CLEAR_LOGS") {
    clearLogBuffer()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function notifyPopup() {
  const { lastSyncDates = {}, lastSyncTime, nextScheduledSyncAt = null } = await chrome.storage.local.get(["lastSyncDates", "lastSyncTime", "nextScheduledSyncAt"]);
  chrome.runtime.sendMessage({ type: "SYNC_UPDATED", lastSyncDates, lastSyncTime, nextScheduledSyncAt }).catch(() => {});
}

function getSyncOptionsForKeys(options, keys, onProgress) {
  return { onProgress };
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
