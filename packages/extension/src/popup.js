import { ACCOUNT_TYPES, BANK_LABELS, getBankForKey } from "./accounts.js";
import { pacificDate, offsetDate, getSyncPlan, appTargets, migrateAccountMappings } from "./utils.js";

const $ = (id) => document.getElementById(id);

const APPS = ["sure", "actual"];
const APP_LABELS = { sure: "Sure", actual: "Actual" };

// Serializes async read-modify-write sections so rapid, overlapping calls don't
// interleave at their awaits and clobber each other's writes (last-writer-wins).
function makeMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
}
// Guards the categoryMappings read-modify-write: mapping several categories in
// quick succession must not drop any mapping.
const withCategoryMappingLock = makeMutex();

let sureAccounts = [];
let actualAccounts = [];
let appCategories = [];
let sureConfigured = false;
let actualConfigured = false;
let addedTypes = new Set();
const activeProgress = new Map();

function accountsFor(app) {
  return app === "sure" ? sureAccounts : actualAccounts;
}

// ── Startup cleanup ───────────────────────────────────────────────────────────

const KNOWN_LOCAL_KEYS = new Set([
  "accountMappings", "addedAccountTypes",
  "cachedSureAccounts", "cachedActualAccounts", "cachedSofiAccounts", "cachedCapitalOneAccounts", "cachedUSBankAccounts", "cachedWFAccounts",
  "lastSyncTime", "lastCompletedSyncSessionId", "lastCompletedSyncSummary",
  "activeSyncSessionId", "activeSyncSummary", "syncFromDate", "nextScheduledSyncAt",
  "lastSyncDates", "lastSyncMetrics", "syncErrors", "lastTxDates",
  "logBuffer",
  "cachedCategories", "categoryMappings", "pendingCategoryTxns",
]);

const PER_ACCOUNT_KEYS = [
  "lastSyncDates", "lastSyncMetrics", "syncErrors", "lastTxDates", "pendingCategoryTxns",
];

function isValidKey(key) {
  return key in ACCOUNT_TYPES || key.startsWith("sofi-") || key.startsWith("capitalone-") || key.startsWith("usbank-") || key.startsWith("wf-");
}

async function purgeStaleKeys() {
  const all = await chrome.storage.local.get(null);
  const { accountMappings = {}, addedAccountTypes = [] } = all;

  const stale = Object.keys(all).filter(k => !KNOWN_LOCAL_KEYS.has(k));
  if (stale.length) await chrome.storage.local.remove(stale);

  const mapped = (key) => key in accountMappings;

  await chrome.storage.local.set({
    accountMappings:   Object.fromEntries(Object.entries(accountMappings).filter(([k]) => isValidKey(k))),
    addedAccountTypes: addedAccountTypes.filter(t => t in ACCOUNT_TYPES),
    ...Object.fromEntries(
      PER_ACCOUNT_KEYS.map(k => [k, Object.fromEntries(Object.entries(all[k] ?? {}).filter(([sk]) => mapped(sk)))])
    ),
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await migrateAccountMappings();
  await purgeStaleKeys();

  const settings = await chrome.storage.sync.get(["sureApiKey", "sureUrl", "actualUrl", "actualPassword", "actualSyncId", "actualFilePassword"]);
  if (settings.sureUrl) $("sure-url").value = settings.sureUrl;
  if (settings.sureApiKey) $("sure-api-key").value = settings.sureApiKey;
  if (settings.actualUrl)          $("actual-url").value           = settings.actualUrl;
  if (settings.actualPassword)     $("actual-password").value      = settings.actualPassword;
  if (settings.actualSyncId)       $("actual-sync-id").value       = settings.actualSyncId;
  if (settings.actualFilePassword) $("actual-file-password").value = settings.actualFilePassword;

  sureConfigured = Boolean(settings.sureApiKey && settings.sureUrl);
  actualConfigured = Boolean(settings.actualUrl && settings.actualPassword && settings.actualSyncId);

  if (sureConfigured) $("sure-connect-btn").textContent = "Reconnect";
  if (settings.actualUrl && settings.actualPassword) {
    $("connect-btn").style.display = "none";
    $("budget-fields").style.display = "block";
  }

  const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
  if (lastSyncTime) showStatus(`Last synced ${formatDateTime(lastSyncTime)}`, "");

  const { cachedSureAccounts, cachedActualAccounts, accountMappings = {}, addedAccountTypes = [] } =
    await chrome.storage.local.get(["cachedSureAccounts", "cachedActualAccounts", "accountMappings", "addedAccountTypes"]);

  if (cachedSureAccounts) sureAccounts = cachedSureAccounts;
  if (cachedActualAccounts) actualAccounts = cachedActualAccounts;

  const { cachedCategories } = await chrome.storage.local.get("cachedCategories");
  if (cachedCategories) appCategories = cachedCategories;
  await updateCategoriesBadge();

  const { syncFromDate } = await chrome.storage.local.get(["syncFromDate", "lastSyncDates"]);
  if (syncFromDate) $("sync-from-date").value = syncFromDate;

  for (const type of addedAccountTypes) {
    if (type === "sofi-banking") {
      const { cachedSofiAccounts = [] } = await chrome.storage.local.get("cachedSofiAccounts");
      addSoFiBankingRows(cachedSofiAccounts, accountMappings);
    } else if (type === "capitalone-cards") {
      const { cachedCapitalOneAccounts = [] } = await chrome.storage.local.get("cachedCapitalOneAccounts");
      addCapitalOneCards(cachedCapitalOneAccounts, accountMappings);
    } else if (type === "usbank-cards") {
      const { cachedUSBankAccounts = [] } = await chrome.storage.local.get("cachedUSBankAccounts");
      addUSBankCards(cachedUSBankAccounts, accountMappings);
    } else if (type === "wf-cards") {
      const { cachedWFAccounts = [] } = await chrome.storage.local.get("cachedWFAccounts");
      addWFCards(cachedWFAccounts, accountMappings);
    } else {
      addAccountRow(type, accountMappings);
    }
  }

  showView(sureConfigured || actualConfigured ? "accounts" : "settings");

  populateDropdown();
  updateDropdownOptions();
  updateUsedOptions();
  sortAccountRows();
  await renderSyncStatus();
  await renderSyncSummary();
  updateSyncBtn();

  if (sureConfigured) loadSureAccounts();
  if (actualConfigured) loadActualAccounts();
  if (sureConfigured || actualConfigured) loadCategories();
}

// ── View management ───────────────────────────────────────────────────────────

function showView(view) {
  $("accounts-view").style.display = view === "accounts" ? "flex" : "none";
  $("settings-view").style.display = view === "settings" ? "block" : "none";
  $("logs-view").style.display = view === "logs" ? "block" : "none";
  $("categories-view").style.display = view === "categories" ? "block" : "none";
  $("settings-btn").classList.toggle("active", view === "settings");
  $("logs-btn").classList.toggle("active", view === "logs");
  $("categories-btn").classList.toggle("active", view === "categories");
}

$("refresh-btn").addEventListener("click", async () => {
  $("refresh-btn").disabled = true;
  showStatus("Refreshing accounts...", "");
  if (sureConfigured) await loadSureAccounts();
  if (actualConfigured) await loadActualAccounts();
  await loadCategories();
  $("refresh-btn").disabled = false;
});

$("settings-btn").addEventListener("click", () => {
  const inSettings = $("settings-view").style.display !== "none";
  showView(inSettings ? "accounts" : "settings");
});

// ── Logs ────────────────────────────────────────────────────────────────────

const LOG_BUFFER_KEY = "logBuffer";
const MAX_LOG_LINES = 600;
const renderedLogIds = new Set();
let logFilter = ""; // lowercased; empty = show all

function lineMatchesFilter(searchText) {
  return !logFilter || searchText.includes(logFilter);
}

// Render `text` into `el`, wrapping case-insensitive matches of `filter` in
// <mark>. Built from text nodes so log content can't inject markup.
function highlightInto(el, text, filter) {
  el.textContent = "";
  if (!filter) { el.textContent = text; return; }
  const lower = text.toLowerCase();
  let i = 0, idx;
  while ((idx = lower.indexOf(filter, i)) !== -1) {
    if (idx > i) el.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(idx, idx + filter.length);
    el.appendChild(mark);
    i = idx + filter.length;
  }
  if (i < text.length) el.appendChild(document.createTextNode(text.slice(i)));
}

function updateLogSearchCount() {
  const el = $("logs-search-count");
  if (!logFilter) { el.textContent = ""; return; }
  let visible = 0;
  for (const line of $("logs-output").querySelectorAll(".log-line")) {
    if (lineMatchesFilter(line.dataset.search)) visible++;
  }
  el.textContent = `${visible} match${visible === 1 ? "" : "es"}`;
}

// Re-apply the current filter to every rendered line (show/hide + re-highlight).
function applyLogFilter() {
  for (const line of $("logs-output").querySelectorAll(".log-line")) {
    const match = lineMatchesFilter(line.dataset.search);
    line.style.display = match ? "" : "none";
    const msg = line.querySelector(".log-msg");
    if (msg) highlightInto(msg, line.dataset.msg, logFilter);
  }
  updateLogSearchCount();
}

$("logs-search").addEventListener("input", (e) => {
  logFilter = e.target.value.trim().toLowerCase();
  applyLogFilter();
});

$("logs-btn").addEventListener("click", () => {
  const inLogs = $("logs-view").style.display !== "none";
  showView(inLogs ? "accounts" : "logs");
  if (!inLogs) renderAllLogs();
});

$("logs-clear-btn").addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_LOGS" });
  renderedLogIds.clear();
  $("logs-output").innerHTML = '<div class="logs-empty">No logs yet.</div>';
  updateLogSearchCount();
});

function formatLogTime(t) {
  return new Date(t).toLocaleTimeString("en-US", { hour12: false });
}

function appendLogLine(entry) {
  if (renderedLogIds.has(entry.id)) return;
  renderedLogIds.add(entry.id);

  const out = $("logs-output");
  out.querySelector(".logs-empty")?.remove();

  const line = document.createElement("div");
  line.className = `log-line ${entry.level}`;
  line.dataset.msg = entry.msg;
  line.dataset.search = `${entry.msg} ${entry.level}`.toLowerCase();

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatLogTime(entry.t);

  const msg = document.createElement("span");
  msg.className = "log-msg";
  highlightInto(msg, entry.msg, logFilter);

  line.appendChild(time);
  line.appendChild(msg);
  const matches = lineMatchesFilter(line.dataset.search);
  if (!matches) line.style.display = "none";
  out.appendChild(line);

  while (out.children.length > MAX_LOG_LINES) out.removeChild(out.firstChild);
  if (logFilter) updateLogSearchCount();
  if (matches && $("logs-autoscroll").checked) out.scrollTop = out.scrollHeight;
}

async function renderAllLogs() {
  const { [LOG_BUFFER_KEY]: entries = [] } = await chrome.storage.local.get(LOG_BUFFER_KEY);
  const out = $("logs-output");
  out.innerHTML = "";
  renderedLogIds.clear();
  if (!entries.length) {
    out.innerHTML = '<div class="logs-empty">No logs yet.</div>';
    updateLogSearchCount();
    return;
  }
  for (const entry of entries) appendLogLine(entry);
  updateLogSearchCount();
}

// ── Categories ────────────────────────────────────────────────────────────────

const CAT_BLANK = "__blank__";
const CAT_CREATE = "__create__";

// Banks whose "mapped" section is expanded, remembered across re-renders.
const expandedMappedBanks = new Set();

$("categories-btn").addEventListener("click", async () => {
  const inCategories = $("categories-view").style.display !== "none";
  showView(inCategories ? "accounts" : "categories");
  if (!inCategories) {
    if (!appCategories.length) await loadCategories();
    await renderCategoriesView();
  }
});

$("categories-refresh-btn").addEventListener("click", async () => {
  $("categories-refresh-btn").disabled = true;
  await loadCategories();
  await renderCategoriesView();
  $("categories-refresh-btn").disabled = false;
});

// The union of both configured apps' categories, keyed by name — category
// mappings store names that are resolved per app at import time.
async function loadCategories() {
  try {
    const res = await sendMessage({ type: "GET_CATEGORIES" });
    if (res.error) throw new Error(res.error);
    appCategories = res.categories || [];
    await chrome.storage.local.set({ cachedCategories: appCategories });
    await updateCategoriesBadge();
  } catch (err) {
    console.warn("Failed to load categories:", err.message);
  }
}

// Collect held-back categories from the pending queue, grouped by bank, split
// into ones still needing a mapping and ones already mapped (awaiting flush or
// editable). pendingCounts[bank][raw] = how many transactions are waiting.
async function getCategoryData() {
  const { pendingCategoryTxns = {}, categoryMappings = {} } =
    await chrome.storage.local.get(["pendingCategoryTxns", "categoryMappings"]);

  const rawByBank = {};
  const pendingCounts = {};
  const txnsByBankRaw = {}; // bank -> raw category -> [{ date, name }]
  for (const [key, txns] of Object.entries(pendingCategoryTxns)) {
    const bank = getBankForKey(key);
    if (!bank) continue;
    for (const tx of txns) {
      if (!tx.category) continue;
      const raw = tx.category;
      (rawByBank[bank] ??= new Set()).add(raw);
      ((pendingCounts[bank] ??= {})[raw] ??= 0);
      pendingCounts[bank][raw]++;
      (((txnsByBankRaw[bank] ??= {})[raw] ??= [])).push({ date: tx.date, name: tx.payee_name });
    }
  }

  // All distinct transaction names per category (most-recent first), so the
  // full set of merchants under an unfamiliar category is visible when mapping.
  const examples = {};
  for (const [bank, byRaw] of Object.entries(txnsByBankRaw)) {
    examples[bank] = {};
    for (const [raw, list] of Object.entries(byRaw)) {
      const sorted = list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const names = [];
      for (const t of sorted) {
        const n = (t.name || "").trim();
        if (n && !names.includes(n)) names.push(n);
      }
      examples[bank][raw] = names;
    }
  }

  const banks = [];
  const bankIds = new Set([...Object.keys(rawByBank), ...Object.keys(categoryMappings)]);
  for (const bank of bankIds) {
    const bankMap = categoryMappings[bank] || {};
    const raws = rawByBank[bank] || new Set();
    const unmapped = [...raws].filter(r => !Object.prototype.hasOwnProperty.call(bankMap, r)).sort();
    const mapped = Object.keys(bankMap).sort().map(raw => ({ raw, value: bankMap[raw] }));
    if (!unmapped.length && !mapped.length) continue;
    banks.push({ bank, label: BANK_LABELS[bank] ?? bank, unmapped, mapped });
  }
  banks.sort((a, b) => a.label.localeCompare(b.label));
  return { banks, pendingCounts, examples };
}

async function updateCategoriesBadge() {
  const { banks } = await getCategoryData();
  const count = banks.reduce((sum, b) => sum + b.unmapped.length, 0);
  const badge = $("categories-badge");
  badge.textContent = count;
  badge.style.display = count > 0 ? "" : "none";
}

function buildCategorySelect(currentValue) {
  const select = document.createElement("select");

  const choose = document.createElement("option");
  choose.value = "";
  choose.textContent = "— choose category —";
  select.appendChild(choose);

  const blank = document.createElement("option");
  blank.value = CAT_BLANK;
  blank.textContent = "Leave uncategorized";
  select.appendChild(blank);

  for (const cat of [...appCategories].sort((a, b) => catLabel(a).localeCompare(catLabel(b)))) {
    const opt = document.createElement("option");
    opt.value = cat.name;
    opt.textContent = catLabel(cat);
    select.appendChild(opt);
  }

  const create = document.createElement("option");
  create.value = CAT_CREATE;
  create.textContent = "+ Create new…";
  select.appendChild(create);

  if (currentValue === "") select.value = CAT_BLANK;
  else if (currentValue != null) select.value = currentValue;
  else select.value = "";
  // If the mapped name no longer exists as an option, fall back to placeholder.
  if (currentValue != null && currentValue !== "" && select.value !== currentValue) select.value = "";

  return select;
}

function catLabel(cat) {
  return cat.parent ? `${cat.parent} / ${cat.name}` : cat.name;
}

async function renderCategoriesView() {
  const out = $("categories-output");
  const { banks, pendingCounts, examples } = await getCategoryData();

  out.innerHTML = "";
  if (!banks.length) {
    out.innerHTML = '<div class="cat-empty">No categories to map yet. They appear here after a sync finds categories you haven\'t mapped.</div>';
    return;
  }

  for (const { bank, label, unmapped, mapped } of banks) {
    const group = document.createElement("div");
    group.className = "cat-bank-group";

    const header = document.createElement("div");
    header.className = "cat-bank-header";
    header.textContent = label;
    group.appendChild(header);

    for (const raw of unmapped) {
      const count = pendingCounts[bank]?.[raw];
      group.appendChild(buildCategoryRow(bank, raw, undefined, count, true, examples[bank]?.[raw]));
    }

    if (mapped.length) {
      const details = document.createElement("details");
      details.className = "cat-mapped";
      details.open = expandedMappedBanks.has(bank);
      details.addEventListener("toggle", () => {
        if (details.open) expandedMappedBanks.add(bank);
        else expandedMappedBanks.delete(bank);
      });

      const summary = document.createElement("summary");
      summary.textContent = `${mapped.length} mapped`;
      details.appendChild(summary);

      const wrap = document.createElement("div");
      wrap.className = "cat-mapped-rows";
      for (const { raw, value } of mapped) {
        const count = pendingCounts[bank]?.[raw];
        wrap.appendChild(buildCategoryRow(bank, raw, value, count, false, examples[bank]?.[raw]));
      }
      details.appendChild(wrap);
      group.appendChild(details);
    }

    out.appendChild(group);
  }
}

function buildCategoryRow(bank, raw, currentValue, pendingCount, isUnmapped, examples) {
  const row = document.createElement("div");
  row.className = "cat-row" + (isUnmapped ? " is-unmapped" : "");

  const info = document.createElement("div");
  info.className = "cat-info";

  const rawEl = document.createElement("div");
  rawEl.className = "cat-raw";
  rawEl.textContent = raw;
  rawEl.title = raw;
  if (pendingCount) {
    const countEl = document.createElement("span");
    countEl.className = "cat-pending-count";
    countEl.textContent = `${pendingCount} waiting`;
    rawEl.appendChild(countEl);
  }
  info.appendChild(rawEl);

  if (examples?.length) {
    const exEl = document.createElement("div");
    exEl.className = "cat-examples";
    const text = examples.join(" · ");
    exEl.textContent = text;
    exEl.title = `${examples.length} name${examples.length === 1 ? "" : "s"}: ${text}`;
    info.appendChild(exEl);
  }

  const select = buildCategorySelect(currentValue);
  let lastValue = select.value;
  select.addEventListener("change", () => {
    saveCategoryMapping(bank, raw, select, lastValue).then(() => { lastValue = select.value; });
  });

  row.appendChild(info);
  row.appendChild(select);
  return row;
}

async function saveCategoryMapping(bank, raw, select, lastValue) {
  const choice = select.value;
  let newValue; // undefined = unmap, "" = uncategorized, else budget category name

  if (choice === CAT_CREATE) {
    const name = prompt(`New category name for "${raw}":`, raw);
    if (!name || !name.trim()) { select.value = lastValue; return; }
    showStatus(`Creating category "${name.trim()}"…`, "");
    const res = await sendMessage({ type: "CREATE_CATEGORY", name: name.trim() });
    if (res.error) {
      showStatus(`Could not create category: ${res.error}`, "error");
      select.value = lastValue;
      return;
    }
    appCategories.push(res.category);
    await chrome.storage.local.set({ cachedCategories: appCategories });
    newValue = res.category.name;
  } else if (choice === CAT_BLANK) {
    newValue = "";
  } else if (choice === "") {
    newValue = undefined; // unmap
  } else {
    newValue = choice;
  }

  await withCategoryMappingLock(async () => {
    const { categoryMappings = {} } = await chrome.storage.local.get("categoryMappings");
    const bankMap = { ...(categoryMappings[bank] || {}) };
    if (newValue === undefined) delete bankMap[raw];
    else bankMap[raw] = newValue;
    categoryMappings[bank] = bankMap;
    await chrome.storage.local.set({ categoryMappings });
  });

  if (newValue !== undefined) {
    // Fire-and-forget: the background coalesces flushes and imports the held
    // transactions, even if a sync or another flush is currently running. The
    // row's "waiting" count clears via the storage-change re-render when done.
    await sendMessage({ type: "FLUSH_PENDING_CATEGORIES" });
    showStatus(`Mapped "${raw}".`, "ok");
  }

  await renderCategoriesView();
  await updateCategoriesBadge();
}

// ── Settings ──────────────────────────────────────────────────────────────────

$("sure-connect-btn").addEventListener("click", async () => {
  $("sure-connect-btn").disabled = true;
  const sureUrl = $("sure-url").value.trim();
  const apiKey = $("sure-api-key").value.trim();
  if (!sureUrl) {
    showStatus("Please enter your Sure URL.", "error");
    $("sure-connect-btn").disabled = false;
    return;
  }
  if (!apiKey) {
    showStatus("Please enter an API key.", "error");
    $("sure-connect-btn").disabled = false;
    return;
  }
  showStatus("Connecting to Sure...", "");
  try {
    await chrome.storage.sync.set({ sureApiKey: apiKey, sureUrl });
    const origin = new URL(sureUrl).origin + "/*";
    const hasPermission = await chrome.permissions.contains({ origins: [origin] });
    if (!hasPermission) {
      showStatus("Approve the permission prompt, then click Connect again.", "");
      chrome.permissions.request({ origins: [origin] });
      $("sure-connect-btn").disabled = false;
      return;
    }
    const res = await sendMessage({ type: "TEST_SURE_CONNECTION" });
    if (res.error) throw new Error(res.error);

    sureConfigured = true;
    showStatus("Connected to Sure. Loading accounts...", "ok");
    await loadSureAccounts();
    loadCategories();
  } catch (err) {
    showStatus(`Sure connection failed: ${err.message}`, "error");
  } finally {
    $("sure-connect-btn").disabled = false;
  }
});

$("connect-btn").addEventListener("click", async () => {
  $("connect-btn").disabled = true;
  showStatus("Connecting to Actual...", "");
  try {
    const res = await sendMessage({
      type: "TEST_ACTUAL_CONNECTION",
      settings: { actualUrl: $("actual-url").value.trim(), actualPassword: $("actual-password").value },
    });
    if (res.error) throw new Error(res.error);

    const cleanUrl = new URL($("actual-url").value.trim()).origin;
    await chrome.storage.sync.set({ actualUrl: cleanUrl, actualPassword: $("actual-password").value });
    $("connect-btn").style.display = "none";
    $("budget-fields").style.display = "block";
    showStatus("Connected to Actual. Enter your budget details.", "ok");
  } catch (err) {
    showStatus(`Actual connection failed: ${err.message}`, "error");
  } finally {
    $("connect-btn").disabled = false;
  }
});

$("save-settings-btn").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    actualUrl:          $("actual-url").value.trim(),
    actualPassword:     $("actual-password").value,
    actualSyncId:       $("actual-sync-id").value.trim(),
    actualFilePassword: $("actual-file-password").value,
  });
  actualConfigured = Boolean($("actual-url").value.trim() && $("actual-password").value && $("actual-sync-id").value.trim());
  showStatus("Settings saved. Loading accounts...", "");
  await loadActualAccounts();
  loadCategories();
});

$("reset-btn").addEventListener("click", async () => {
  // Reset only touches accounts that are mapped — an Actual budget (and even a
  // Sure ledger) can hold accounts this extension doesn't manage.
  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
  const targets = [];
  const seen = new Set();
  for (const mapping of Object.values(accountMappings)) {
    const target = appTargets(mapping);
    for (const app of APPS) {
      const id = target[app];
      if (!id || seen.has(`${app}:${id}`)) continue;
      seen.add(`${app}:${id}`);
      const name = accountsFor(app).find(a => a.id === id)?.name || id;
      targets.push({ app, id, name: `${name} (${APP_LABELS[app]})` });
    }
  }
  if (!targets.length) {
    showStatus("No mapped accounts.", "error");
    return;
  }
  $("reset-btn").disabled = true;
  let total = 0;
  try {
    // One pass to tally what would be deleted, then a single confirm for the
    // whole operation — no per-account prompting.
    showStatus("Counting transactions…", "");
    const toDelete = [];
    let grandTotal = 0;
    for (const target of targets) {
      const countRes = await sendMessage({ type: "GET_TRANSACTION_COUNT", app: target.app, accountId: target.id });
      if (countRes.error) throw new Error(countRes.error);
      if (countRes.count === 0) continue;
      toDelete.push({ ...target, count: countRes.count });
      grandTotal += countRes.count;
    }
    const txPart = grandTotal > 0
      ? `Delete ${grandTotal} transaction${grandTotal === 1 ? "" : "s"} across ${toDelete.length} mapped account${toDelete.length === 1 ? "" : "s"}, then reset`
      : "No transactions to delete. Reset";
    if (!confirm(`${txPart} sync data (category mappings, dates, queues)? Your account mappings are kept.`)) {
      showStatus("Reset cancelled.", "");
      return;
    }
    for (const { app, id, name, count } of toDelete) {
      showStatus(`Deleting ${count} transactions from ${name}...`, "");
      const res = await sendMessage({ type: "DELETE_ALL_TRANSACTIONS", app, accountId: id });
      if (res.error) throw new Error(res.error);
      total += res.count;
    }
    // Reset is a full clean slate: wipe every sync watermark, metric, category
    // mapping, held-back queue, and stored error so the next sync re-pulls from
    // scratch and re-prompts/re-categorizes fresh. This runs even when there are
    // no transactions to delete. Account configuration (accountMappings,
    // syncFromDate) is left intact.
    await chrome.storage.local.set({
      lastSyncDates: {},
      lastSyncMetrics: {},
      lastTxDates: {},
      syncErrors: {},
      categoryMappings: {},
      pendingCategoryTxns: {},
    });
    showStatus(total > 0 ? `Deleted ${total} transaction${total === 1 ? "" : "s"} and reset.` : "Reset complete.", "ok");
    if (sureConfigured) await loadSureAccounts();
    if (actualConfigured) await loadActualAccounts();
  } catch (err) {
    showStatus(`Reset failed: ${err.message}`, "error");
  } finally {
    $("reset-btn").disabled = false;
  }
});

async function loadSureAccounts() {
  try {
    const res = await sendMessage({ type: "GET_SURE_ACCOUNTS" });
    if (res.error) throw new Error(res.error);

    sureAccounts = res.accounts;
    await chrome.storage.local.set({ cachedSureAccounts: sureAccounts });
    await refreshAppSelects("sure");
    showStatus("Ready to sync.", "ok");
  } catch (err) {
    showStatus(`Error loading Sure accounts: ${err.message}`, "error");
  }
}

async function loadActualAccounts() {
  try {
    const res = await sendMessage({ type: "GET_ACTUAL_ACCOUNTS" });
    if (res.error) throw new Error(res.error);

    actualAccounts = res.accounts;
    await chrome.storage.local.set({ cachedActualAccounts: actualAccounts });
    await refreshAppSelects("actual");
    showStatus("Ready to sync.", "ok");
  } catch (err) {
    showStatus(`Error loading Actual accounts: ${err.message}`, "error");
  }
}

async function refreshAppSelects(app) {
  showView("accounts");
  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
  for (const sel of document.querySelectorAll(`select[data-mapping-key][data-app="${app}"]`)) {
    refreshSelect(sel, appTargets(accountMappings[sel.dataset.mappingKey])[app]);
    syncMappingDisplay(sel.closest(".account-row"));
  }
  updateUsedOptions();
  await renderSyncStatus();
}

// ── Sync ──────────────────────────────────────────────────────────────────────

function updateSyncBtn() {
  const hasMapping = Array.from(document.querySelectorAll("select[data-mapping-key]")).some(sel => sel.value);
  const syncFromDate = $("sync-from-date").value;
  $("sync-btn").style.display = (hasMapping && syncFromDate) ? "block" : "none";
  if (hasMapping) renderSyncStatus();
}

$("sync-btn").addEventListener("click", async () => {
  await runSyncFromPopup({}, "Syncing…");
});

$("sync-from-date").addEventListener("change", async () => {
  await chrome.storage.local.set({ syncFromDate: $("sync-from-date").value });
  updateSyncBtn();
});

// ── Add account dropdown ──────────────────────────────────────────────────────

function populateDropdown() {
  const dropdown = $("account-type-dropdown");
  dropdown.innerHTML = "";
  const sorted = Object.entries(BANK_LABELS).sort(([, a], [, b]) => a.localeCompare(b));
  for (const [bankId, label] of sorted) {
    const div = document.createElement("div");
    div.className = "dropdown-option";
    div.dataset.bank = bankId;
    div.textContent = label;
    dropdown.appendChild(div);
  }
}

$("add-account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dropdown = $("account-type-dropdown");
  const opening = !dropdown.classList.contains("open");
  dropdown.classList.toggle("open");
  $("accounts-view").style.paddingBottom = opening ? `${dropdown.offsetHeight + 16}px` : "";
});

document.addEventListener("click", () => {
  $("account-type-dropdown").classList.remove("open");
  $("accounts-view").style.paddingBottom = "";
});

$("account-type-dropdown").addEventListener("click", async (e) => {
  const option = e.target.closest(".dropdown-option");
  if (!option) return;
  $("account-type-dropdown").classList.remove("open");
  $("accounts-view").style.paddingBottom = "";
  await addBank(option.dataset.bank);
  sortAccountRows();
  updateDropdownOptions();
});

function updateDropdownOptions() {
  let anyVisible = false;
  for (const option of document.querySelectorAll(".dropdown-option")) {
    const bankId = option.dataset.bank;
    let allAdded;
    if (bankId in BANK_FETCH_FNS) {
      allAdded = !!document.querySelector(`.bank-group[data-bank="${bankId}"]`);
    } else {
      allAdded = Object.keys(ACCOUNT_TYPES)
        .filter(k => ACCOUNT_TYPES[k].bank === bankId)
        .every(k => addedTypes.has(k));
    }
    option.style.display = allAdded ? "none" : "";
    if (!allAdded) anyVisible = true;
  }
  $("add-account-btn").style.display = anyVisible ? "" : "none";
}

// ── Account rows ──────────────────────────────────────────────────────────────

async function addSoFiBanking() {
  showStatus("Loading SoFi accounts...", "");
  try {
    const res = await sendMessage({ type: "GET_SOFI_ACCOUNTS" });
    if (res.error) throw new Error(res.error);
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addSoFiBankingRows(res.accounts, accountMappings);
    addedTypes.add("sofi-banking");
    await chrome.storage.local.set({ cachedSofiAccounts: res.accounts, addedAccountTypes: [...addedTypes] });
    showStatus("SoFi accounts loaded.", "ok");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
}

async function addBank(bankId) {
  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
  if (bankId === "sofi") {
    await addSoFiBanking();
    return;
  }
  if (bankId === "capitalone") {
    await addCapitalOneBanking();
    return;
  }
  if (bankId === "usbank") {
    await addUSBankBanking();
    return;
  }
  if (bankId === "wf") {
    await addWFBanking();
    return;
  }
  const keys = Object.keys(ACCOUNT_TYPES).filter(k => ACCOUNT_TYPES[k].bank === bankId && !ACCOUNT_TYPES[k].optional && !addedTypes.has(k));
  for (const key of keys) addAccountRow(key, accountMappings);
  if (keys.length) persistAddedTypes();
}

function addSoFiBankingRows(bankAccounts, savedMappings) {
  addedTypes.add("sofi-banking");
  for (const bank of bankAccounts || []) {
    const key = `sofi-${bank.id}`;
    const label = bank.type === "Vault"
      ? (bank.name ? `${bank.name} Vault` : "Vault")
      : bank.type.replace("Account", "").trim();
    addMappingRow(key, label, savedMappings[key]);
  }
}

async function addCapitalOneBanking() {
  showStatus("Loading Capital One accounts...", "");
  try {
    const res = await sendMessage({ type: "GET_CAPITALONE_ACCOUNTS" });
    if (res.error) throw new Error(res.error);
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addCapitalOneCards(res.accounts, accountMappings);
    addedTypes.add("capitalone-cards");
    await chrome.storage.local.set({ cachedCapitalOneAccounts: res.accounts, addedAccountTypes: [...addedTypes] });
    showStatus("Capital One accounts loaded.", "ok");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
}

function addCapitalOneCards(bankAccounts, savedMappings) {
  addedTypes.add("capitalone-cards");
  for (const account of bankAccounts || []) {
    const key = `capitalone-${account.id}`;
    const label = `${account.name} (${account.lastFour})`;
    addMappingRow(key, label, savedMappings[key]);
  }
}

async function addUSBankBanking() {
  showStatus("Loading US Bank accounts...", "");
  try {
    const res = await sendMessage({ type: "GET_USBANK_ACCOUNTS" });
    if (res.error) throw new Error(res.error);
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addUSBankCards(res.accounts, accountMappings);
    addedTypes.add("usbank-cards");
    await chrome.storage.local.set({ cachedUSBankAccounts: res.accounts, addedAccountTypes: [...addedTypes] });
    showStatus("US Bank accounts loaded.", "ok");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
}

function addUSBankCards(bankAccounts, savedMappings) {
  addedTypes.add("usbank-cards");
  for (const account of bankAccounts || []) {
    const key = `usbank-${account.id}`;
    const label = `${account.name} (${account.lastFour})`;
    addMappingRow(key, label, savedMappings[key]);
  }
}

async function addWFBanking() {
  showStatus("Loading Wells Fargo accounts...", "");
  try {
    const res = await sendMessage({ type: "GET_WF_ACCOUNTS" });
    if (res.error) throw new Error(res.error);
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addWFCards(res.accounts, accountMappings);
    addedTypes.add("wf-cards");
    await chrome.storage.local.set({ cachedWFAccounts: res.accounts, addedAccountTypes: [...addedTypes] });
    showStatus("Wells Fargo accounts loaded.", "ok");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
}

function addWFCards(bankAccounts, savedMappings) {
  addedTypes.add("wf-cards");
  for (const account of bankAccounts || []) {
    const key = `wf-${account.id}`;
    const label = `${account.name} (${account.lastFour})`;
    addMappingRow(key, label, savedMappings[key]);
  }
}

function addAccountRow(type, savedMappings) {
  addedTypes.add(type);
  addMappingRow(type, ACCOUNT_TYPES[type].label, savedMappings[type]);
}

const BANK_FETCH_FNS = {
  sofi:       addSoFiBanking,
  capitalone: addCapitalOneBanking,
  usbank:     addUSBankBanking,
  wf:         addWFBanking,
};

function getOrCreateBankGroup(bankId) {
  const existing = document.querySelector(`.bank-group[data-bank="${bankId}"]`);
  if (existing) return existing;
  const group = document.createElement("div");
  group.className = "bank-group";
  group.dataset.bank = bankId;
  const header = document.createElement("div");
  header.className = "bank-group-header";

  const nameEl = document.createElement("span");
  nameEl.textContent = BANK_LABELS[bankId] ?? bankId;
  header.appendChild(nameEl);

  const fetchFn = BANK_FETCH_FNS[bankId];
  if (fetchFn) {
    const fetchBtn = document.createElement("button");
    fetchBtn.type = "button";
    fetchBtn.className = "bank-fetch-btn";
    fetchBtn.textContent = "↻";
    fetchBtn.title = "Fetch accounts";
    fetchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      fetchFn();
    });
    header.appendChild(fetchBtn);
  }

  group.appendChild(header);
  const addRow = document.createElement("div");
  addRow.className = "bank-add-row";
  group.appendChild(addRow);
  $("accounts-list").appendChild(group);
  return group;
}

function updateBankGroupAddOptions(bankId) {
  const group = document.querySelector(`.bank-group[data-bank="${bankId}"]`);
  if (!group) return;
  const container = group.querySelector(".bank-add-row");
  if (!container) return;

  const addableKeys = bankId === "sofi"
    ? ["sofi-credit"]
    : Object.keys(ACCOUNT_TYPES).filter(k => ACCOUNT_TYPES[k].bank === bankId);

  const missing = addableKeys.filter(k => !addedTypes.has(k));
  container.innerHTML = "";

  for (const key of missing) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bank-add-chip";
    btn.textContent = `+ ${ACCOUNT_TYPES[key].label}`;
    btn.addEventListener("click", async () => {
      const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
      addAccountRow(key, accountMappings);
      persistAddedTypes();
      updateBankGroupAddOptions(bankId);
      updateDropdownOptions();
    });
    container.appendChild(btn);
  }
}

function addMappingRow(mappingKey, label, savedMapping) {
  if (document.querySelector(`select[data-mapping-key="${mappingKey}"]`)) return;
  const selected = appTargets(savedMapping);

  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.rowKey = mappingKey;
  row.dataset.sourceLabel = label;

  const info = document.createElement("div");
  info.className = "account-info";

  const labelEl = document.createElement("div");
  labelEl.className = "account-label";
  labelEl.textContent = label;

  const sourceEl = document.createElement("div");
  sourceEl.className = "account-source";
  sourceEl.textContent = label;

  const subEl = document.createElement("div");
  subEl.className = "account-sub";
  subEl.id = `sub-${mappingKey}`;

  const rangeEl = document.createElement("div");
  rangeEl.className = "account-range";
  rangeEl.id = `range-${mappingKey}`;
  rangeEl.title = "Date range the next sync will cover";

  const progressEl = document.createElement("div");
  progressEl.className = "account-progress";

  const progressBarEl = document.createElement("div");
  progressBarEl.className = "account-progress-bar";
  progressBarEl.id = `progress-${mappingKey}`;

  progressEl.appendChild(progressBarEl);

  info.appendChild(labelEl);
  info.appendChild(sourceEl);
  info.appendChild(subEl);
  info.appendChild(rangeEl);
  info.appendChild(progressEl);

  // One select per app, stacked: a bank account can sync to Sure, Actual, or both.
  const selectsWrap = document.createElement("div");
  selectsWrap.className = "mapping-selects";
  const selects = [];
  for (const app of APPS) {
    const selRow = document.createElement("div");
    selRow.className = "mapping-select-row";

    const tag = document.createElement("span");
    tag.className = "app-tag";
    tag.textContent = APP_LABELS[app][0];
    tag.title = APP_LABELS[app];

    const select = document.createElement("select");
    select.dataset.mappingKey = mappingKey;
    select.dataset.app = app;
    refreshSelect(select, selected[app]);

    select.addEventListener("change", () => {
      saveMappings();
      updateUsedOptions();
      syncMappingDisplay(row);
      updateSyncBtn();
    });
    select.addEventListener("blur", () => {
      requestAnimationFrame(() => {
        if (selects.some(s => s === document.activeElement)) return;
        setMappingEditorState(row, false);
      });
    });

    selects.push(select);
    selRow.appendChild(tag);
    selRow.appendChild(select);
    selectsWrap.appendChild(selRow);
  }

  const mappingDisplay = document.createElement("button");
  mappingDisplay.type = "button";
  mappingDisplay.className = "mapping-display";
  mappingDisplay.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMappingEditorState(row, true);
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn edit-mapping";
  editBtn.textContent = "✎";
  editBtn.title = "Edit mapping";
  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMappingEditorState(row, true);
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "icon-btn remove";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove";
  removeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.remove();
    const type = getTypeForKey(mappingKey);
    if (type === "sofi-banking") {
      const hasMoreBankingRows = !!document.querySelector('.account-row[data-row-key^="sofi-"]:not([data-row-key="sofi-credit"])');
      if (!hasMoreBankingRows) addedTypes.delete("sofi-banking");
    } else if (type === "capitalone-cards") {
      const hasMoreRows = !!document.querySelector('.account-row[data-row-key^="capitalone-"]');
      if (!hasMoreRows) addedTypes.delete("capitalone-cards");
    } else if (type === "usbank-cards") {
      const hasMoreRows = !!document.querySelector('.account-row[data-row-key^="usbank-"]');
      if (!hasMoreRows) addedTypes.delete("usbank-cards");
    } else if (type === "wf-cards") {
      const hasMoreRows = !!document.querySelector('.account-row[data-row-key^="wf-"]');
      if (!hasMoreRows) addedTypes.delete("wf-cards");
    } else if (type) {
      addedTypes.delete(type);
    }
    const bank = getBankForKey(mappingKey);
    if (bank) {
      const group = document.querySelector(`.bank-group[data-bank="${bank}"]`);
      if (group) {
        if (group.querySelectorAll(".account-row").length === 0) {
          group.remove();
        } else {
          updateBankGroupAddOptions(bank);
        }
      }
    }
    updateDropdownOptions();
    persistAddedTypes();
    const [
      { accountMappings = {} }, { lastSyncDates = {} }, { lastSyncMetrics = {} }, { syncErrors = {} },
      { lastTxDates = {} }, { activeSyncSummary = null }, { lastCompletedSyncSummary = null }, { pendingCategoryTxns = {} },
    ] = await Promise.all([
      chrome.storage.local.get("accountMappings"),
      chrome.storage.local.get("lastSyncDates"),
      chrome.storage.local.get("lastSyncMetrics"),
      chrome.storage.local.get("syncErrors"),
      chrome.storage.local.get("lastTxDates"),
      chrome.storage.local.get("activeSyncSummary"),
      chrome.storage.local.get("lastCompletedSyncSummary"),
      chrome.storage.local.get("pendingCategoryTxns"),
    ]);
    for (const obj of [accountMappings, lastSyncDates, lastSyncMetrics, syncErrors, lastTxDates, pendingCategoryTxns]) {
      delete obj[mappingKey];
    }
    if (activeSyncSummary?.byKey) delete activeSyncSummary.byKey[mappingKey];
    if (lastCompletedSyncSummary?.byKey) delete lastCompletedSyncSummary.byKey[mappingKey];
    await chrome.storage.local.set({ accountMappings, lastSyncDates, lastSyncMetrics, syncErrors, lastTxDates, activeSyncSummary, lastCompletedSyncSummary, pendingCategoryTxns });
    await renderSyncSummary();
    await updateCategoriesBadge();
    updateSyncBtn();
  });

  const syncOneBtn = document.createElement("button");
  syncOneBtn.className = "icon-btn sync-one";
  syncOneBtn.textContent = "↻";
  syncOneBtn.title = "Sync this account";
  syncOneBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selects.some(s => s.value)) return;
    await runSyncFromPopup({ targetKeys: [mappingKey] }, `Syncing ${row.dataset.sourceLabel}…`);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn delete-txns";
  deleteBtn.textContent = "⌫";
  deleteBtn.title = "Delete all transactions";
  deleteBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const mappedTargets = selects
      .filter(s => s.value)
      .map(s => ({ app: s.dataset.app, id: s.value, name: `${s.options[s.selectedIndex]?.textContent || "this account"} (${APP_LABELS[s.dataset.app]})` }));
    if (!mappedTargets.length) return;
    const names = mappedTargets.map(t => `"${t.name}"`).join(" and ");
    if (!confirm(`Delete ALL transactions in ${names}? This cannot be undone.`)) return;
    deleteBtn.disabled = true;
    showStatus("Deleting transactions...", "");
    try {
      let total = 0;
      for (const target of mappedTargets) {
        const res = await sendMessage({ type: "DELETE_ALL_TRANSACTIONS", app: target.app, accountId: target.id });
        if (res.error) throw new Error(res.error);
        total += res.count;
      }
      showStatus(`Deleted ${total} transaction${total === 1 ? "" : "s"}.`, "ok");
      const { lastSyncDates = {}, lastSyncMetrics = {}, lastTxDates = {}, pendingCategoryTxns = {} } =
        await chrome.storage.local.get(["lastSyncDates", "lastSyncMetrics", "lastTxDates", "pendingCategoryTxns"]);
      delete lastSyncDates[mappingKey];
      delete lastSyncMetrics[mappingKey];
      delete lastTxDates[mappingKey];
      delete pendingCategoryTxns[mappingKey]; // held-back queue is per-account
      // Category mappings are user-curated config (kept per bank), not sync
      // state — a re-sync should reuse them, so only Reset wipes them.
      await chrome.storage.local.set({ lastSyncDates, lastSyncMetrics, lastTxDates, pendingCategoryTxns });
      if (sureConfigured) await loadSureAccounts();
      if (actualConfigured) await loadActualAccounts();
    } catch (err) {
      showStatus(`Delete failed: ${err.message}`, "error");
    } finally {
      deleteBtn.disabled = false;
    }
  });

  row.appendChild(info);
  row.appendChild(mappingDisplay);
  row.appendChild(selectsWrap);
  row.appendChild(editBtn);
  row.appendChild(syncOneBtn);
  row.appendChild(deleteBtn);
  row.appendChild(removeBtn);

  const bank = getBankForKey(mappingKey);
  const container = bank ? getOrCreateBankGroup(bank) : $("accounts-list");
  container.appendChild(row);
  syncMappingDisplay(row);
  updateUsedOptions();
  if (bank) updateBankGroupAddOptions(bank);
}

function getTypeForKey(mappingKey) {
  if (mappingKey.startsWith("sofi-") && mappingKey !== "sofi-credit") return "sofi-banking";
  if (mappingKey.startsWith("capitalone-")) return "capitalone-cards";
  if (mappingKey.startsWith("usbank-")) return "usbank-cards";
  if (mappingKey.startsWith("wf-")) return "wf-cards";
  return ACCOUNT_TYPES[mappingKey] ? mappingKey : null;
}

function persistAddedTypes() {
  chrome.storage.local.set({ addedAccountTypes: [...addedTypes] });
}

// ── Selects ───────────────────────────────────────────────────────────────────

function refreshSelect(select, selectedId) {
  const currentValue = selectedId || select.value;
  select.innerHTML = "";

  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = `— ${APP_LABELS[select.dataset.app]} account —`;
  select.appendChild(emptyOpt);

  for (const acct of accountsFor(select.dataset.app)) {
    const opt = document.createElement("option");
    opt.value = acct.id;
    opt.textContent = acct.name;
    if (acct.id === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
}

function rowSelects(row) {
  return Array.from(row.querySelectorAll("select[data-mapping-key]"));
}

function syncMappingDisplay(row) {
  const selects = rowSelects(row);
  const display = row.querySelector(".mapping-display");
  const editBtn = row.querySelector(".edit-mapping");
  const labelEl = row.querySelector(".account-label");
  const sourceEl = row.querySelector(".account-source");

  const names = [];
  const titles = [];
  for (const sel of selects) {
    if (!sel.value) continue;
    const text = sel.options[sel.selectedIndex]?.textContent || "";
    titles.push(`${APP_LABELS[sel.dataset.app]}: ${text}`);
    if (!names.includes(text)) names.push(text);
  }
  const hasMapping = names.length > 0;
  const isEditing = row.classList.contains("is-editing");
  const sourceLabel = row.dataset.sourceLabel || "";
  const joined = names.join(" · ");

  display.textContent = hasMapping ? joined : "Select account";
  display.title = hasMapping ? `Mapped to ${titles.join(", ")}` : "Select account";
  labelEl.textContent = hasMapping ? joined : sourceLabel;
  labelEl.title = titles.join(", ");
  sourceEl.textContent = sourceLabel;
  sourceEl.style.display = hasMapping && !isEditing ? "none" : "";
  row.classList.toggle("is-mapped", hasMapping);
  row.classList.toggle("is-editing", isEditing || !hasMapping);
  if (editBtn) editBtn.style.display = hasMapping ? "" : "none";
}

function setMappingEditorState(row, isEditing) {
  const selects = rowSelects(row);
  if (!selects.length) return;
  const hasMapping = selects.some(s => s.value);
  row.classList.toggle("is-editing", isEditing || !hasMapping);
  syncMappingDisplay(row);
  if (isEditing || !hasMapping) {
    const target = selects.find(s => !s.disabled);
    target?.focus();
  }
}

function updateUsedOptions() {
  for (const app of APPS) {
    const selects = Array.from(document.querySelectorAll(`select[data-mapping-key][data-app="${app}"]`));
    const usedIds = new Set(selects.map(s => s.value).filter(Boolean));
    for (const sel of selects) {
      for (const opt of sel.options) {
        if (!opt.value) continue;
        opt.disabled = usedIds.has(opt.value) && opt.value !== sel.value;
      }
    }
  }
}

async function saveMappings() {
  const mappings = {};
  for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
    if (!sel.value) continue;
    (mappings[sel.dataset.mappingKey] ??= {})[sel.dataset.app] = sel.value;
  }
  await chrome.storage.local.set({ accountMappings: mappings });
}

// ── Sync status ───────────────────────────────────────────────────────────────

// Balance for a mapping key: Sure's number when mapped there, otherwise Actual's.
function balanceForTarget(target) {
  const sureBal = target.sure != null ? sureAccounts.find(a => a.id === target.sure)?.balance_cents : undefined;
  if (sureBal != null) return sureBal;
  const actualBal = target.actual != null ? actualAccounts.find(a => a.id === target.actual)?.balance_cents : undefined;
  return actualBal != null ? actualBal : undefined;
}

async function renderSyncStatus() {
  const { lastSyncDates = {}, lastSyncMetrics = {}, syncErrors = {}, accountMappings = {}, lastTxDates = {}, syncFromDate } =
    await chrome.storage.local.get(["lastSyncDates", "lastSyncMetrics", "syncErrors", "accountMappings", "lastTxDates", "syncFromDate"]);

  for (const el of document.querySelectorAll("[id^='sub-']")) {
    const key = el.id.replace("sub-", "");
    const row = el.closest(".account-row");
    const progress = activeProgress.get(key);
    if (progress) {
      applyProgressState(row, key, progress);
      continue;
    }
    const target = appTargets(accountMappings[key]);
    const isMapped = Boolean(target.sure || target.actual);
    const bal = isMapped ? balanceForTarget(target) : undefined;
    const balHtml = bal != null ? balanceSpan(bal) : "";

    const rangeEl = document.getElementById(`range-${key}`);
    if (rangeEl) {
      const plan = isMapped ? getSyncPlan(lastSyncDates, syncFromDate, key, lastTxDates) : null;
      rangeEl.textContent = plan ? `${formatRangeDate(plan.startDate)} → ${formatRangeDate(plan.endDate)}` : "";
    }

    if (syncErrors[key]) {
      el.innerHTML = escapeHtml(syncErrors[key]) + (balHtml ? ` • ${balHtml}` : "");
      el.className = "account-sub error";
      row?.classList.remove("is-syncing");
    } else {
      const date = lastSyncDates[key];
      if (date) {
        const count = lastSyncMetrics[key]?.count;
        const countStr = formatTransactionCount(count);
        let statusHtml = countStr ? `Synced ${escapeHtml(formatDate(date))} • ${escapeHtml(countStr)}` : `Synced ${escapeHtml(formatDate(date))}`;
        if (balHtml) statusHtml += ` • ${balHtml}`;
        el.className = "account-sub synced";
        row?.classList.remove("is-syncing");
        el.innerHTML = statusHtml;
      } else {
        el.innerHTML = balHtml;
        el.className = "account-sub";
        row?.classList.remove("is-syncing");
      }
    }
  }

  const anyUnsynced = Array.from(document.querySelectorAll("select[data-mapping-key]"))
    .some(sel => sel.value && !lastSyncDates[sel.dataset.mappingKey]);
  $("sync-from-section").style.display = anyUnsynced ? "block" : "none";
  updateSyncFromControl(anyUnsynced);
  await renderSyncSummary();
}

function sortAccountRows() {
  const list = $("accounts-list");
  if (!list) return;
  const groups = Array.from(list.querySelectorAll(":scope > .bank-group"));
  if (groups.length < 2) return;
  groups.sort((a, b) => {
    const la = (BANK_LABELS[a.dataset.bank] ?? a.dataset.bank).toLowerCase();
    const lb = (BANK_LABELS[b.dataset.bank] ?? b.dataset.bank).toLowerCase();
    return la.localeCompare(lb);
  });
  for (const group of groups) list.appendChild(group);
}

async function renderSyncSummary() {
  const {
    accountMappings = {},
    lastSyncDates = {},
    activeSyncSummary = null,
    lastCompletedSyncSummary = null,
    nextScheduledSyncAt = null,
  } = await chrome.storage.local.get([
    "accountMappings",
    "lastSyncDates",
    "activeSyncSummary",
    "lastCompletedSyncSummary",
    "nextScheduledSyncAt",
  ]);

  const mappedKeys = Object.keys(accountMappings);
  const summaryEl = $("sync-summary");

  if (!mappedKeys.length) {
    summaryEl.style.display = "none";
    return;
  }

  $("summary-next-alarm").textContent = nextScheduledSyncAt
    ? `Next auto sync ${formatDateTime(nextScheduledSyncAt)}`
    : "";

  const netWorthRow = $("summary-net-worth-row");
  const mappedBalances = mappedKeys
    .map(k => balanceForTarget(appTargets(accountMappings[k])))
    .filter(b => b != null);
  if (mappedBalances.length > 0) {
    const netWorth = mappedBalances.reduce((s, b) => s + b, 0);
    const nwEl = $("summary-net-worth");
    nwEl.textContent = formatCurrency(netWorth);
    nwEl.className = netWorth < 0 ? "amount-neg" : "";
    netWorthRow.style.display = "";
  } else {
    netWorthRow.style.display = "none";
  }

  const liveSummary = activeSyncSummary?.sessionId && (activeSyncSummary.syncedAccounts || activeSyncSummary.transactionCount) ? activeSyncSummary : null;

  if (liveSummary) {
    $("summary-accounts").textContent = `${liveSummary.syncedAccounts || 0} accounts done`;
    $("summary-transactions").textContent = `${liveSummary.transactionCount || 0} transactions added`;
    $("summary-transactions").style.display = "";
  } else {
    const syncedAccounts = mappedKeys.filter(k => lastSyncDates[k]).length;
    $("summary-accounts").textContent = syncedAccounts > 0
      ? `${syncedAccounts} account${syncedAccounts === 1 ? "" : "s"} synced`
      : `${mappedKeys.length} mapped`;
    $("summary-transactions").textContent = "";
    $("summary-transactions").style.display = "none";
  }
  summaryEl.style.display = "flex";
}

function updateSyncFromControl(anyUnsynced) {
  const input = $("sync-from-date");
  input.readOnly = !anyUnsynced;
  input.title = anyUnsynced ? "" : "Add or reset an unsynced account to change this";
}

function formatDate(isoStr) {
  const today = pacificDate(new Date());
  if (isoStr === today) return "today";
  if (isoStr === offsetDate(today, -1)) return "yesterday";
  const [year, month, day] = isoStr.split("-");
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatRangeDate(isoStr) {
  const [year, month, day] = isoStr.split("-");
  return `${month}/${day}/${year}`;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTransactionCount(count) {
  if (count == null) return "";
  if (count === 0) return "No transactions";
  return `${count} transaction${count === 1 ? "" : "s"}`;
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((cents || 0) / 100);
}

function balanceSpan(cents) {
  const cls = cents < 0 ? "amount-neg" : "";
  return `<span class="${cls}">${escapeHtml(formatCurrency(cents))}</span>`;
}


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      resolve(response || { error: chrome.runtime.lastError?.message });
    });
  });
}

function showStatus(msg, type) {
  const el = $("status-bar");
  el.textContent = msg;
  el.className = type || "";
}

function applyProgressState(row, key, progress) {
  if (!row) return;
  const textEl = document.getElementById(`sub-${key}`);
  const barEl = document.getElementById(`progress-${key}`);
  row.classList.add("is-syncing");
  if (textEl) {
    const percentLabel = typeof progress.percent === "number" ? ` ${progress.percent}%` : "";
    textEl.textContent = `${progress.message || "Syncing"}${percentLabel}`;
    textEl.className = "account-sub syncing";
  }
  if (barEl) {
    barEl.style.width = `${Math.max(0, Math.min(progress.percent ?? 0, 100))}%`;
  }
}

const SYNC_COOLDOWN_MS = 2 * 60 * 1000;
let cooldownTimer = null;

function startSyncCooldown() {
  const syncBtn = $("sync-btn");
  const endTime = Date.now() + SYNC_COOLDOWN_MS;
  clearInterval(cooldownTimer);

  function tick() {
    const remaining = Math.max(0, endTime - Date.now());
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    syncBtn.textContent = `Sync Now (${m}:${String(s).padStart(2, "0")})`;
  }

  syncBtn.disabled = true;
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

async function runSyncFromPopup(options, pendingMessage) {
  const syncBtn = $("sync-btn");
  syncBtn.disabled = true;

  showStatus(pendingMessage, "");
  const res = await sendMessage({ type: "RUN_SYNC", options });
  if (res.error) {
    showStatus(`Sync failed: ${res.error}`, "error");
  } else {
    const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
    if (lastSyncTime) showStatus(`Last synced ${formatDateTime(lastSyncTime)}`, "");
  }

  if (!options.targetKeys) {
    startSyncCooldown();
  } else {
    syncBtn.disabled = false;
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG_ENTRY") {
    appendLogLine(msg.entry);
    return;
  }

  if (msg.type === "SYNC_UPDATED") {
    renderSyncStatus();
    renderSyncSummary();
    if (msg.lastSyncTime) showStatus(`Last synced ${formatDateTime(msg.lastSyncTime)}`, "");
  }

  if (msg.type === "SYNC_PROGRESS") {
    const row = document.getElementById(`sub-${msg.key}`)?.closest(".account-row");
    if (!row) return;
    if (msg.message != null) {
      activeProgress.set(msg.key, { percent: msg.percent ?? 0, message: msg.message });
      applyProgressState(row, msg.key, activeProgress.get(msg.key));
      renderSyncSummary();
    } else {
      activeProgress.delete(msg.key);
      row.classList.remove("is-syncing");
      renderSyncStatus();
      renderSyncSummary();
    }
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (changes.pendingCategoryTxns || changes.categoryMappings) {
    await updateCategoriesBadge();
    if ($("categories-view").style.display !== "none") await renderCategoriesView();
  }

  const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
  if (changes.cachedSofiAccounts) {
    addSoFiBankingRows(changes.cachedSofiAccounts.newValue || [], accountMappings);
    persistAddedTypes();
    await renderSyncStatus();
    updateSyncBtn();
  }
  if (changes.cachedCapitalOneAccounts) {
    addCapitalOneCards(changes.cachedCapitalOneAccounts.newValue || [], accountMappings);
    persistAddedTypes();
    await renderSyncStatus();
    updateSyncBtn();
  }
  if (changes.cachedUSBankAccounts) {
    addUSBankCards(changes.cachedUSBankAccounts.newValue || [], accountMappings);
    persistAddedTypes();
    await renderSyncStatus();
    updateSyncBtn();
  }
  if (changes.cachedWFAccounts) {
    addWFCards(changes.cachedWFAccounts.newValue || [], accountMappings);
    persistAddedTypes();
    await renderSyncStatus();
    updateSyncBtn();
  }
});

init();
