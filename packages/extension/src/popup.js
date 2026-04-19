import { ACCOUNT_TYPES } from "./accounts.js";

const $ = (id) => document.getElementById(id);

let actualAccounts = [];
let addedTypes = new Set();
const activeProgress = new Map();

// ── Startup cleanup ───────────────────────────────────────────────────────────

function isValidKey(key) {
  return key in ACCOUNT_TYPES || key.startsWith("sofi-");
}

async function purgeStaleKeys() {
  const data = await chrome.storage.local.get(["accountMappings", "lastSyncDates", "lastSyncCounts", "lastSyncMetrics", "syncErrors", "addedAccountTypes", "rowOrder"]);
  const { accountMappings = {}, lastSyncDates = {}, lastSyncCounts = {}, lastSyncMetrics = {}, syncErrors = {}, addedAccountTypes = [], rowOrder = [] } = data;

  await chrome.storage.local.set({
    accountMappings:   Object.fromEntries(Object.entries(accountMappings).filter(([k]) => isValidKey(k))),
    lastSyncDates:     Object.fromEntries(Object.entries(lastSyncDates).filter(([k]) => isValidKey(k))),
    lastSyncCounts:    Object.fromEntries(Object.entries(lastSyncCounts).filter(([k]) => isValidKey(k))),
    lastSyncMetrics:   Object.fromEntries(Object.entries(lastSyncMetrics).filter(([k]) => isValidKey(k))),
    syncErrors:        Object.fromEntries(Object.entries(syncErrors).filter(([k]) => isValidKey(k))),
    addedAccountTypes: addedAccountTypes.filter(t => t in ACCOUNT_TYPES),
    rowOrder:          rowOrder.filter(k => isValidKey(k)),
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await purgeStaleKeys();

  const settings = await chrome.storage.sync.get(["actualUrl", "actualPassword", "actualSyncId", "actualFilePassword"]);
  if (settings.actualUrl)          $("actual-url").value           = settings.actualUrl;
  if (settings.actualPassword)     $("actual-password").value      = settings.actualPassword;
  if (settings.actualSyncId)       $("actual-sync-id").value       = settings.actualSyncId;
  if (settings.actualFilePassword) $("actual-file-password").value = settings.actualFilePassword;

  if (settings.actualUrl && settings.actualPassword) {
    $("connect-btn").style.display = "none";
    $("budget-fields").style.display = "block";
  }

  const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
  if (lastSyncTime) showStatus(`Last synced ${formatDateTime(lastSyncTime)}`, "");

  const { cachedActualAccounts, accountMappings = {}, addedAccountTypes = [], rowOrder = [] } =
    await chrome.storage.local.get(["cachedActualAccounts", "accountMappings", "addedAccountTypes", "rowOrder"]);

  if (cachedActualAccounts) actualAccounts = cachedActualAccounts;

  const { syncFromDate } = await chrome.storage.local.get(["syncFromDate", "lastSyncDates"]);
  if (syncFromDate) $("sync-from-date").value = syncFromDate;

  for (const type of addedAccountTypes) {
    if (type === "sofi-banking") {
      const { cachedBankAccounts = [] } = await chrome.storage.local.get("cachedBankAccounts");
      addSoFiBankingRows(cachedBankAccounts, accountMappings);
    } else {
      addAccountRow(type, accountMappings);
    }
  }

  applyRowOrder(rowOrder);

  showView(cachedActualAccounts?.length > 0 ? "accounts" : "settings");

  populateDropdown();
  updateDropdownOptions();
  updateUsedOptions();
  await renderSyncStatus();
  await renderSyncSummary();
  updateSyncBtn();
}

// ── View management ───────────────────────────────────────────────────────────

function showView(view) {
  const isSettings = view === "settings";
  $("accounts-view").style.display = isSettings ? "none" : "flex";
  $("settings-view").style.display = isSettings ? "block" : "none";
  $("settings-btn").classList.toggle("active", isSettings);
}

$("settings-btn").addEventListener("click", () => {
  const inAccounts = $("accounts-view").style.display !== "none";
  showView(inAccounts ? "settings" : "accounts");
});

// ── Settings ──────────────────────────────────────────────────────────────────

$("connect-btn").addEventListener("click", async () => {
  $("connect-btn").disabled = true;
  showStatus("Connecting...", "");
  try {
    const res = await sendMessage({
      type: "TEST_CONNECTION",
      settings: { actualUrl: $("actual-url").value.trim(), actualPassword: $("actual-password").value },
    });
    if (res.error) throw new Error(res.error);

    const cleanUrl = new URL($("actual-url").value.trim()).origin;
    await chrome.storage.sync.set({ actualUrl: cleanUrl, actualPassword: $("actual-password").value });
    $("connect-btn").style.display = "none";
    $("budget-fields").style.display = "block";
    showStatus("Connected. Enter your budget details.", "ok");
  } catch (err) {
    showStatus(`Connection failed: ${err.message}`, "error");
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
  showStatus("Settings saved. Loading accounts...", "");
  await loadActualAccounts();
});

async function loadActualAccounts() {
  try {
    const settings = await getSettings();
    const res = await sendMessage({ type: "GET_ACTUAL_ACCOUNTS", settings });
    if (res.error) throw new Error(res.error);

    actualAccounts = res.accounts;
    await chrome.storage.local.set({ cachedActualAccounts: actualAccounts });
    showView("accounts");

    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
      refreshSelect(sel, accountMappings[sel.dataset.mappingKey]);
      syncMappingDisplay(sel.closest(".account-row"));
    }
    updateUsedOptions();
    await renderSyncSummary();
    showStatus("Ready to sync.", "ok");
  } catch (err) {
    showStatus(`Error loading accounts: ${err.message}`, "error");
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

function updateSyncBtn() {
  const hasMapping = Array.from(document.querySelectorAll("select[data-mapping-key]")).some(sel => sel.value);
  const syncFromDate = $("sync-from-date").value;
  $("sync-btn").style.display = (hasMapping && syncFromDate) ? "block" : "none";
  $("force-sync-btn").style.display = hasMapping ? "block" : "none";
  if (hasMapping) renderSyncStatus();
}

$("sync-btn").addEventListener("click", async () => {
  await runSyncFromPopup({}, "Syncing…");
});

$("force-sync-btn").addEventListener("click", async () => {
  await runSyncFromPopup({
    forceDays: 1,
    forceKeys: Array.from(document.querySelectorAll("select[data-mapping-key]"))
      .filter(sel => sel.value)
      .map(sel => sel.dataset.mappingKey),
  }, "Force syncing the last day…");
});

$("sync-from-date").addEventListener("change", () => {
  chrome.storage.local.set({ syncFromDate: $("sync-from-date").value });
  updateSyncBtn();
});

// ── Add account dropdown ──────────────────────────────────────────────────────

function populateDropdown() {
  const dropdown = $("account-type-dropdown");
  dropdown.innerHTML = "";
  for (const [type, { label }] of Object.entries(ACCOUNT_TYPES)) {
    const div = document.createElement("div");
    div.className = "dropdown-option";
    div.dataset.type = type;
    div.textContent = label;
    dropdown.appendChild(div);
  }
}

$("add-account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dropdown = $("account-type-dropdown");
  const opening = !dropdown.classList.contains("open");
  dropdown.classList.toggle("open");
  $("accounts-view").style.paddingBottom = opening ? `${dropdown.offsetHeight + 4}px` : "";
});

document.addEventListener("click", () => {
  $("account-type-dropdown").classList.remove("open");
  $("accounts-view").style.paddingBottom = "";
});

$("account-type-dropdown").addEventListener("click", async (e) => {
  const option = e.target.closest(".dropdown-option");
  if (!option) return;
  const type = option.dataset.type;
  $("account-type-dropdown").classList.remove("open");
  $("accounts-view").style.paddingBottom = "";

  if (type === "sofi-banking") {
    await addSoFiBanking();
  } else {
    addAccountRow(type, {});
    persistAddedTypes();
  }
  updateDropdownOptions();
});

function updateDropdownOptions() {
  let anyVisible = false;
  for (const option of document.querySelectorAll(".dropdown-option")) {
    const type = option.dataset.type;
    const hidden = addedTypes.has(type);
    option.style.display = hidden ? "none" : "";
    if (!hidden) anyVisible = true;
  }
  $("add-account-btn").style.display = anyVisible ? "" : "none";
}

// ── Account rows ──────────────────────────────────────────────────────────────

async function addSoFiBanking() {
  showStatus("Loading SoFi accounts...", "");
  try {
    const res = await sendMessage({ type: "GET_SOFI_ACCOUNTS" });
    if (res.error) throw new Error(res.error);
    await chrome.storage.local.set({ cachedBankAccounts: res.accounts });
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addSoFiBankingRows(res.accounts, accountMappings);
    persistAddedTypes();
    showStatus("SoFi accounts loaded.", "ok");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
}

function addSoFiBankingRows(bankAccounts, savedMappings) {
  addedTypes.add("sofi-banking");
  for (const bank of bankAccounts || []) {
    const key = `sofi-${bank.id}`;
    addMappingRow(key, `SoFi ${bank.type.replace("Account", "").trim()}`, savedMappings[key]);
  }
}

function addAccountRow(type, savedMappings) {
  addedTypes.add(type);
  addMappingRow(type, ACCOUNT_TYPES[type].label, savedMappings[type]);
}

let dragSrcKey = null;
let lastDragEnterKey = null;

function addMappingRow(mappingKey, label, selectedId) {
  if (document.querySelector(`select[data-mapping-key="${mappingKey}"]`)) return;

  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.rowKey = mappingKey;
  row.dataset.sourceLabel = label;
  row.draggable = true;

  const handle = document.createElement("div");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";

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

  const progressEl = document.createElement("div");
  progressEl.className = "account-progress";

  const progressBarEl = document.createElement("div");
  progressBarEl.className = "account-progress-bar";
  progressBarEl.id = `progress-${mappingKey}`;

  progressEl.appendChild(progressBarEl);

  info.appendChild(labelEl);
  info.appendChild(sourceEl);
  info.appendChild(subEl);
  info.appendChild(progressEl);

  const select = document.createElement("select");
  select.dataset.mappingKey = mappingKey;
  refreshSelect(select, selectedId);

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

  const forceSyncBtn = document.createElement("button");
  forceSyncBtn.type = "button";
  forceSyncBtn.className = "icon-btn force-sync";
  forceSyncBtn.textContent = "↺";
  forceSyncBtn.title = "Force sync last day";
  forceSyncBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runSyncFromPopup({
      targetKeys: [mappingKey],
      forceKeys: [mappingKey],
      forceDays: 1,
    }, `Force syncing the last day for ${row.querySelector(".account-label")?.textContent || label}…`);
  });

  select.addEventListener("change", () => {
    saveMappings();
    updateUsedOptions();
    syncMappingDisplay(row);
    updateSyncBtn();
  });
  select.addEventListener("blur", () => {
    requestAnimationFrame(() => setMappingEditorState(row, false));
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
    if (type) addedTypes.delete(type);
    updateDropdownOptions();
    persistAddedTypes();
    const [{ accountMappings = {} }, { lastSyncDates = {} }, { lastSyncMetrics = {} }, { syncErrors = {} }, { rowOrder = [] }] = await Promise.all([
      chrome.storage.local.get("accountMappings"),
      chrome.storage.local.get("lastSyncDates"),
      chrome.storage.local.get("lastSyncMetrics"),
      chrome.storage.local.get("syncErrors"),
      chrome.storage.local.get("rowOrder"),
    ]);
    delete accountMappings[mappingKey];
    delete lastSyncDates[mappingKey];
    delete lastSyncMetrics[mappingKey];
    delete syncErrors[mappingKey];
    await chrome.storage.local.set({ accountMappings, lastSyncDates, lastSyncMetrics, syncErrors, rowOrder: rowOrder.filter(k => k !== mappingKey) });
    await renderSyncSummary();
    updateSyncBtn();
  });

  row.appendChild(handle);
  row.appendChild(info);
  row.appendChild(mappingDisplay);
  row.appendChild(select);
  row.appendChild(forceSyncBtn);
  row.appendChild(editBtn);
  row.appendChild(removeBtn);

  row.addEventListener("dragstart", (e) => {
    dragSrcKey = mappingKey;
    lastDragEnterKey = null;
    e.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => row.classList.add("dragging"));
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    dragSrcKey = null;
    lastDragEnterKey = null;
  });

  row.addEventListener("dragenter", async (e) => {
    e.preventDefault();
    if (!dragSrcKey || dragSrcKey === mappingKey) return;
    if (lastDragEnterKey === mappingKey) return;
    lastDragEnterKey = mappingKey;

    const list = $("accounts-list");
    const rows = Array.from(list.querySelectorAll(".account-row"));
    const src = list.querySelector(`[data-row-key="${dragSrcKey}"]`);
    const srcIdx = rows.indexOf(src);
    const tgtIdx = rows.indexOf(row);

    const srcTop = src.getBoundingClientRect().top;
    const tgtTop = row.getBoundingClientRect().top;

    if (srcIdx < tgtIdx) list.insertBefore(row, src);
    else list.insertBefore(src, row);

    const srcDelta = srcTop - src.getBoundingClientRect().top;
    const tgtDelta = tgtTop - row.getBoundingClientRect().top;

    for (const [el, delta] of [[src, srcDelta], [row, tgtDelta]]) {
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      el.getBoundingClientRect(); // force reflow so transition fires
      el.style.transition = "transform 0.15s ease";
      el.style.transform = "";
    }
  });

  row.addEventListener("dragover", (e) => e.preventDefault());

  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    const newOrder = Array.from($("accounts-list").querySelectorAll(".account-row")).map(r => r.dataset.rowKey);
    await chrome.storage.local.set({ rowOrder: newOrder });
  });

  $("accounts-list").appendChild(row);
  syncMappingDisplay(row);
  updateUsedOptions();
}

function applyRowOrder(rowOrder) {
  if (!rowOrder?.length) return;
  const list = $("accounts-list");
  for (const key of rowOrder) {
    const row = list.querySelector(`[data-row-key="${key}"]`);
    if (row) list.appendChild(row);
  }
}

function getTypeForKey(mappingKey) {
  if (mappingKey.startsWith("sofi-") && mappingKey !== "sofi-credit") return "sofi-banking";
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
  emptyOpt.textContent = "— select account —";
  select.appendChild(emptyOpt);

  for (const acct of actualAccounts) {
    const opt = document.createElement("option");
    opt.value = acct.id;
    opt.textContent = acct.name;
    if (acct.id === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
}

function syncMappingDisplay(row) {
  const select = row.querySelector("select[data-mapping-key]");
  const display = row.querySelector(".mapping-display");
  const editBtn = row.querySelector(".edit-mapping");
  const labelEl = row.querySelector(".account-label");
  const sourceEl = row.querySelector(".account-source");
  const selectedText = select.options[select.selectedIndex]?.textContent || "";
  const hasMapping = Boolean(select.value);
  const isEditing = row.classList.contains("is-editing");
  const sourceLabel = row.dataset.sourceLabel || "";

  display.textContent = hasMapping ? selectedText : "Select account";
  display.title = hasMapping ? `Mapped to ${selectedText}` : "Select account";
  labelEl.textContent = hasMapping ? selectedText : sourceLabel;
  sourceEl.textContent = sourceLabel;
  sourceEl.style.display = hasMapping && !isEditing ? "none" : "";
  row.classList.toggle("is-mapped", hasMapping);
  row.classList.toggle("is-editing", isEditing || !hasMapping);
  if (editBtn) editBtn.style.display = hasMapping ? "" : "none";
}

function setMappingEditorState(row, isEditing) {
  const select = row.querySelector("select[data-mapping-key]");
  if (!select) return;
  const hasMapping = Boolean(select.value);
  row.classList.toggle("is-editing", isEditing || !hasMapping);
  syncMappingDisplay(row);
  if ((isEditing || !hasMapping) && !select.disabled) {
    select.focus();
  }
}

function updateUsedOptions() {
  const usedIds = new Set(
    Array.from(document.querySelectorAll("select[data-mapping-key]")).map(s => s.value).filter(Boolean)
  );
  for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
    for (const opt of sel.options) {
      if (!opt.value) continue;
      opt.disabled = usedIds.has(opt.value) && opt.value !== sel.value;
    }
  }
}

async function saveMappings() {
  const mappings = {};
  for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
    if (sel.value) mappings[sel.dataset.mappingKey] = sel.value;
  }
  await chrome.storage.local.set({ accountMappings: mappings });
}

// ── Sync status ───────────────────────────────────────────────────────────────

async function renderSyncStatus() {
  const { lastSyncDates = {}, lastSyncCounts = {}, lastSyncMetrics = {}, syncErrors = {} } =
    await chrome.storage.local.get(["lastSyncDates", "lastSyncCounts", "lastSyncMetrics", "syncErrors"]);

  for (const el of document.querySelectorAll("[id^='sub-']")) {
    const key = el.id.replace("sub-", "");
    const row = el.closest(".account-row");
    const progress = activeProgress.get(key);
    if (progress) {
      applyProgressState(row, key, progress);
      continue;
    }
    if (syncErrors[key]) {
      el.textContent = syncErrors[key];
      el.className = "account-sub error";
      row?.classList.remove("is-syncing");
    } else {
      const date = lastSyncDates[key];
      if (date) {
        const count = lastSyncCounts[key];
        const countStr = formatTransactionCount(count);
        const statusText = countStr ? `Synced ${formatDate(date)} • ${countStr}` : `Synced ${formatDate(date)}`;
        el.className = "account-sub synced";
        row?.classList.remove("is-syncing");
        const net = lastSyncMetrics[key]?.net;
        if (net) {
          const sign = net > 0 ? "+" : "−";
          const amountHtml = net < 0
            ? `<span class="amount-neg">${sign}${escapeHtml(formatCurrency(Math.abs(net)))}</span>`
            : `${sign}${escapeHtml(formatCurrency(net))}`;
          el.innerHTML = `${escapeHtml(statusText)} • ${amountHtml}`;
        } else {
          el.textContent = statusText;
        }
      } else {
        el.textContent = "";
        el.className = "account-sub";
        row?.classList.remove("is-syncing");
      }
    }
  }

  sortAccountRows(lastSyncMetrics);

  const anyUnsynced = Array.from(document.querySelectorAll("select[data-mapping-key]"))
    .some(sel => sel.value && !lastSyncDates[sel.dataset.mappingKey]);
  $("sync-from-section").style.display = anyUnsynced ? "block" : "none";
  updateSyncFromControl(anyUnsynced);
  await renderSyncSummary();
}

function metricSortKey(key, metrics) {
  if (activeProgress.has(key)) return -3e15;
  const net = metrics?.net;
  if (!net) return 2e15;
  if (net < 0) return net;
  return 1e15 - net;
}

function sortAccountRows(lastSyncMetrics) {
  const list = $("accounts-list");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll(".account-row"));
  if (rows.length < 2) return;
  rows.sort((a, b) => metricSortKey(a.dataset.rowKey, lastSyncMetrics[a.dataset.rowKey]) - metricSortKey(b.dataset.rowKey, lastSyncMetrics[b.dataset.rowKey]));
  for (const row of rows) list.appendChild(row);
}

async function renderSyncSummary() {
  const {
    accountMappings = {},
    lastSyncDates = {},
    lastSyncMetrics = {},
    activeSyncSummary = null,
    nextScheduledSyncAt = null,
  } = await chrome.storage.local.get([
    "accountMappings",
    "lastSyncDates",
    "lastSyncMetrics",
    "activeSyncSummary",
    "nextScheduledSyncAt",
  ]);

  const mappedKeys = Object.keys(accountMappings);
  const summaryEl = $("sync-summary");

  if (!mappedKeys.length && !nextScheduledSyncAt) {
    summaryEl.style.display = "none";
    return;
  }

  $("summary-next-alarm").textContent = nextScheduledSyncAt
    ? `Next auto sync ${formatDateTime(nextScheduledSyncAt)}`
    : "Auto sync not scheduled";

  const liveSummary = activeSyncSummary?.sessionId && (activeSyncSummary.syncedAccounts || activeSyncSummary.transactionCount) ? activeSyncSummary : null;

  if (liveSummary) {
    $("summary-accounts").textContent = `${liveSummary.syncedAccounts || 0} accounts done`;
    $("summary-transactions").textContent = `${liveSummary.transactionCount || 0} transactions added`;
    $("summary-cashflow").innerHTML = formatCashflowSummary(liveSummary.inflow || 0, liveSummary.outflow || 0);
  } else {
    const syncedAccounts = mappedKeys.filter(k => lastSyncDates[k]).length;
    if (syncedAccounts > 0) {
      const totals = mappedKeys.reduce((acc, k) => {
        const m = lastSyncMetrics[k];
        if (!m) return acc;
        return {
          transactionCount: acc.transactionCount + (m.count || 0),
          inflow: acc.inflow + (m.inflow || 0),
          outflow: acc.outflow + (m.outflow || 0),
        };
      }, { transactionCount: 0, inflow: 0, outflow: 0 });
      $("summary-accounts").textContent = `${syncedAccounts} accounts synced`;
      $("summary-transactions").textContent = `${totals.transactionCount} transactions added`;
      $("summary-cashflow").innerHTML = formatCashflowSummary(totals.inflow, totals.outflow);
    } else {
      $("summary-accounts").textContent = `${mappedKeys.length} mapped`;
      $("summary-transactions").textContent = "No recent sync run";
      $("summary-cashflow").innerHTML = "";
    }
  }
  summaryEl.style.display = "grid";
}

function updateSyncFromControl(anyUnsynced) {
  const input = $("sync-from-date");
  input.readOnly = !anyUnsynced;
  input.title = anyUnsynced ? "" : "Add or reset an unsynced account to change this";
}

function formatDate(isoStr) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (isoStr === yesterday.toISOString().split("T")[0]) return "today";
  const [year, month, day] = isoStr.split("-");
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

function formatCashflowSummary(inflow, outflow) {
    const net = inflow - outflow;
    const parts = [];
    if (inflow > 0) {
      parts.push(`<span class="summary-flow income"><span class="summary-flow-label">In</span><span>+${escapeHtml(formatCurrency(inflow))}</span></span>`);
    }
    if (outflow > 0) {
      parts.push(`<span class="summary-flow outflow"><span class="summary-flow-label">Out</span><span>-${escapeHtml(formatCurrency(outflow))}</span></span>`);
    }
  if (inflow > 0 || outflow > 0) {
      const prefix = net >= 0 ? "+" : "-";
      parts.push(`<span class="summary-flow net"><span class="summary-flow-label">Net</span><span>${prefix}${escapeHtml(formatCurrency(Math.abs(net)))}</span></span>`);
    }
  if (!parts.length) {
      parts.push('<span class="summary-flow empty">No cash flow</span>');
    }
  return parts.join("");
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

function getSettings() {
  return chrome.storage.sync.get(["actualUrl", "actualPassword", "actualSyncId", "actualFilePassword"]);
}

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
  const textEl = row.querySelector(`#sub-${key}`);
  const barEl = row.querySelector(`#progress-${key}`);
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

async function runSyncFromPopup(options, pendingMessage) {
  const syncBtn = $("sync-btn");
  const forceSyncBtn = $("force-sync-btn");
  syncBtn.disabled = true;
  forceSyncBtn.disabled = true;
  for (const btn of document.querySelectorAll(".force-sync")) btn.disabled = true;

  showStatus(pendingMessage, "");
  const res = await sendMessage({ type: "RUN_SYNC", options });
  if (res.error) {
    showStatus(`Sync failed: ${res.error}`, "error");
  } else {
    const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
    if (options.forceDays) {
      showStatus(`Forced last-day sync finished ${lastSyncTime ? formatDateTime(lastSyncTime) : ""}`.trim(), "ok");
    } else if (lastSyncTime) {
      showStatus(`Last synced ${formatDateTime(lastSyncTime)}`, "");
    }
  }

  syncBtn.disabled = false;
  forceSyncBtn.disabled = false;
  for (const btn of document.querySelectorAll(".force-sync")) btn.disabled = false;
}

// ── Messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
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
      sortAccountRows({});
      renderSyncSummary();
    } else {
      activeProgress.delete(msg.key);
      row.classList.remove("is-syncing");
      renderSyncStatus();
      renderSyncSummary();
    }
  }
});

init();
