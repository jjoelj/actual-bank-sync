// popup.js

import { ACCOUNT_TYPES } from "./accounts.js";

const $ = (id) => document.getElementById(id);

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

// sofi-banking can produce multiple rows (one per detected account)

let actualAccounts = [];
let addedTypes = new Set(); // tracks which types have been added

// ── Init ─────────────────────────────────────────────────────────────────────

function isValidKey(key) {
  return key in ACCOUNT_TYPES || key.startsWith("sofi-");
}

async function purgeStaleKeys() {
  const { accountMappings = {}, lastSyncDates = {}, syncErrors = {}, addedAccountTypes = [] } =
    await chrome.storage.local.get(["accountMappings", "lastSyncDates", "syncErrors", "addedAccountTypes"]);

  const cleanMappings = Object.fromEntries(Object.entries(accountMappings).filter(([k]) => isValidKey(k)));
  const cleanDates    = Object.fromEntries(Object.entries(lastSyncDates).filter(([k]) => isValidKey(k)));
  const cleanErrors   = Object.fromEntries(Object.entries(syncErrors).filter(([k]) => isValidKey(k)));
  const cleanTypes    = addedAccountTypes.filter(t => t in ACCOUNT_TYPES);

  await chrome.storage.local.set({
    accountMappings: cleanMappings,
    lastSyncDates:   cleanDates,
    syncErrors:      cleanErrors,
    addedAccountTypes: cleanTypes,
  });
}

async function init() {
  await purgeStaleKeys();
  const settings = await chrome.storage.sync.get([
    "actualUrl",
    "actualPassword",
    "actualSyncId",
    "actualFilePassword",
  ]);

  if (settings.actualUrl) $("actual-url").value = settings.actualUrl;
  if (settings.actualPassword) $("actual-password").value = settings.actualPassword;
  if (settings.actualSyncId) $("actual-sync-id").value = settings.actualSyncId;
  if (settings.actualFilePassword) $("actual-file-password").value = settings.actualFilePassword;

  if (settings.actualUrl && settings.actualPassword) {
    $("connect-btn").style.display = "none";
    $("budget-fields").style.display = "block";
  }

  const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
  if (lastSyncTime) {
    $("status").textContent = `Last sync: ${new Date(lastSyncTime).toLocaleString()}`;
  }

  // Restore cached state
  const { cachedActualAccounts, accountMappings = {}, addedAccountTypes = [] } =
      await chrome.storage.local.get(["cachedActualAccounts", "accountMappings", "addedAccountTypes", "cachedBankAccounts"]);

  if (cachedActualAccounts && cachedActualAccounts.length > 0) {
    setAccountsVisible(true);
  }

  if (cachedActualAccounts) {
    actualAccounts = cachedActualAccounts;
  }

  if (cachedActualAccounts) {
    $("settings-body").style.display = "none";
    $("settings-chevron").textContent = "▸";
  }

  const { syncFromDate, lastSyncDates = {} } = await chrome.storage.local.get(["syncFromDate", "lastSyncDates"]);

  // Show the earliest effective sync date across all banks
  if (syncFromDate) $("sync-from-date").value = syncFromDate;

  if (Object.keys(lastSyncDates).length > 0) {
    $("sync-from-date").readOnly = true;
    $("sync-from-date").title = "Reset last sync dates to change this";
  }

  // Re-render saved accounts
  for (const type of addedAccountTypes) {
    if (type === "sofi-banking") {
      const { cachedBankAccounts = [] } = await chrome.storage.local.get("cachedBankAccounts");
      addSoFiBankingRows(cachedBankAccounts, accountMappings);
    } else {
      addAccountRow(type, accountMappings);
    }
  }

  populateDropdown();
  updateDropdownOptions();
  updateUsedOptions();

  await renderSyncStatus();
  updateSyncBtn();
}

// ── Settings ─────────────────────────────────────────────────────────────────

$("connect-btn").addEventListener("click", async () => {
  $("connect-btn").disabled = true;
  showStatus("Connecting...", "");

  try {
    const res = await sendMessage({
      type: "TEST_CONNECTION",
      settings: {
        actualUrl: $("actual-url").value.trim(),
        actualPassword: $("actual-password").value,
      },
    });
    if (res.error) throw new Error(res.error);

    const parsed = new URL($("actual-url").value.trim());
    const cleanUrl = parsed.origin; // strips trailing slashes, paths, etc.

    await chrome.storage.sync.set({
      actualUrl: cleanUrl,
      actualPassword: $("actual-password").value,
    });

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
    actualUrl: $("actual-url").value.trim(),
    actualPassword: $("actual-password").value,
    actualSyncId: $("actual-sync-id").value.trim(),
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
    if (actualAccounts) {
      $("settings-body").style.display = "none";
      $("settings-chevron").textContent = "▸";
    }
    await chrome.storage.local.set({ cachedActualAccounts: actualAccounts });
    setAccountsVisible(true);

    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
      refreshSelect(sel, accountMappings[sel.dataset.mappingKey]);
    }
    updateUsedOptions();

    showStatus("Ready.", "ok");
  } catch (err) {
    showStatus(`Error loading accounts: ${err.message}`, "error");
  }
}

function updateSyncBtn() {
  const hasMapping = Array.from(document.querySelectorAll("select[data-mapping-key]"))
      .some(sel => sel.value);
  const syncFromDate = $("sync-from-date").value;
  $("sync-btn").style.display = (hasMapping && syncFromDate) ? "block" : "none";
  if (hasMapping) renderSyncStatus();
}

// ── Add account dropdown ──────────────────────────────────────────────────────

$("add-account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dropdown = $("account-type-dropdown");
  const opening = !dropdown.classList.contains("open");
  dropdown.classList.toggle("open");
  $("accounts-section").style.paddingBottom = opening ? `${dropdown.offsetHeight + 4}px` : "";
});

document.addEventListener("click", () => {
  $("account-type-dropdown").classList.remove("open");
  $("accounts-section").style.paddingBottom = "";
});

$("account-type-dropdown").addEventListener("click", async (e) => {
  const option = e.target.closest(".dropdown-option");
  if (!option || option.classList.contains("disabled")) return;

  const type = option.dataset.type;
  $("account-type-dropdown").classList.remove("open");

  if (type === "sofi-banking") {
    await addSoFiBanking();
  } else {
    addAccountRow(type, {});
    persistAddedTypes();
  }

  updateDropdownOptions();
});

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
    const label = `SoFi ${bank.type.replace("Account", "").trim()}`;
    addMappingRow(key, label, savedMappings[key]);
  }
}

function addAccountRow(type, savedMappings) {
  addedTypes.add(type);
  const { label } = ACCOUNT_TYPES[type];
  addMappingRow(type, label, savedMappings[type]);
}

function addMappingRow(mappingKey, label, selectedId) {
  if (document.querySelector(`select[data-mapping-key="${mappingKey}"]`)) return;

  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.rowKey = mappingKey;

  const leftCol = document.createElement("div");
  leftCol.style.cssText = "flex:1;min-width:0;";

  const labelEl = document.createElement("span");
  labelEl.className = "account-label";
  labelEl.textContent = label;

  const subEl = document.createElement("div");
  subEl.className = "account-sub";
  subEl.id = `sub-${mappingKey}`;

  leftCol.appendChild(labelEl);
  leftCol.appendChild(subEl);

  const select = document.createElement("select");
  select.dataset.mappingKey = mappingKey;
  refreshSelect(select, selectedId);
  select.addEventListener("change", () => {
    saveMappings();
    updateUsedOptions();
    updateSyncBtn();
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove";
  removeBtn.addEventListener("click", async () => {
    row.remove();
    const type = getTypeForKey(mappingKey);
    if (type) addedTypes.delete(type);
    updateDropdownOptions();
    persistAddedTypes();

    const [{ accountMappings = {} }, { lastSyncDates = {} }, { syncErrors = {} }] = await Promise.all([
      chrome.storage.local.get("accountMappings"),
      chrome.storage.local.get("lastSyncDates"),
      chrome.storage.local.get("syncErrors"),
    ]);
    delete accountMappings[mappingKey];
    delete lastSyncDates[mappingKey];
    delete syncErrors[mappingKey];
    await chrome.storage.local.set({ accountMappings, lastSyncDates, syncErrors });

    updateSyncBtn();
  });

  row.appendChild(leftCol);
  row.appendChild(select);
  row.appendChild(removeBtn);
  $("accounts-list").appendChild(row);
  updateUsedOptions();
}

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

function getTypeForKey(mappingKey) {
  if (mappingKey.startsWith("sofi-") && mappingKey !== "sofi-credit") return "sofi-banking";
  return ACCOUNT_TYPES[mappingKey] ? mappingKey : null;
}

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

function persistAddedTypes() {
  chrome.storage.local.set({ addedAccountTypes: [...addedTypes] });
}

$("sync-from-date").addEventListener("change", () => {
  chrome.storage.local.set({ syncFromDate: $("sync-from-date").value });
  updateSyncBtn();
});

// ── Manual sync ──────────────────────────────────────────────────────────────

$("sync-btn").addEventListener("click", async () => {
  $("sync-btn").disabled = true;
  showStatus("Syncing...", "");

  const res = await sendMessage({ type: "RUN_SYNC" });

  if (res.error) {
    showStatus(`Sync failed: ${res.error}`, "error");
  } else {
    const { lastSyncTime } = await chrome.storage.local.get("lastSyncTime");
    showStatus(`Synced at ${new Date(lastSyncTime).toLocaleString()}`, "ok");
  }

  $("sync-btn").disabled = false;
});

$("settings-toggle").addEventListener("click", () => {
  const body = $("settings-body");
  const chevron = $("settings-chevron");
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "block" : "none";
  chevron.textContent = collapsed ? "▾" : "▸";
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSettings() {
  return chrome.storage.sync.get([
    "actualUrl",
    "actualPassword",
    "actualSyncId",
    "actualFilePassword",
  ]);
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || { error: chrome.runtime.lastError?.message });
    });
  });
}

function showStatus(msg, type) {
  const el = $("status");
  el.textContent = msg;
  el.className = type || "";
}

function setAccountsVisible(visible) {
  $("accounts-section").style.display = visible ? "block" : "none";
}

async function renderSyncStatus() {
  const { lastSyncDates = {}, syncErrors = {} } = await chrome.storage.local.get(["lastSyncDates", "syncErrors"]);

  for (const el of document.querySelectorAll("[id^='sub-']")) {
    const key = el.id.replace("sub-", "");
    if (syncErrors[key]) {
      el.textContent = syncErrors[key];
      el.style.color = "#e94560";
    } else {
      const date = lastSyncDates[key];
      el.textContent = date ? `last synced ${formatDate(date)}` : "";
      el.style.color = "";
    }
  }

  const anyUnsynced = Array.from(document.querySelectorAll("select[data-mapping-key]"))
      .some(sel => sel.value && !lastSyncDates[sel.dataset.mappingKey]);

  $("sync-from-section").style.display = anyUnsynced ? "block" : "none";
}

function formatDate(isoStr) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  if (isoStr === yesterdayStr) return "today";
  const [year, month, day] = isoStr.split("-");
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function saveMappings() {
  const mappings = {};
  for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
    if (sel.value) mappings[sel.dataset.mappingKey] = sel.value;
  }
  await chrome.storage.local.set({ accountMappings: mappings });
}

function updateUsedOptions() {
  const usedIds = new Set(
      Array.from(document.querySelectorAll("select[data-mapping-key]"))
          .map(s => s.value)
          .filter(Boolean)
  );

  for (const sel of document.querySelectorAll("select[data-mapping-key]")) {
    for (const opt of sel.options) {
      if (!opt.value) continue;
      opt.disabled = usedIds.has(opt.value) && opt.value !== sel.value;
    }
  }
}

init();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SYNC_UPDATED") {
    renderSyncStatus();
    if (msg.lastSyncTime) {
      $("status").textContent = `Last sync: ${new Date(msg.lastSyncTime).toLocaleString()}`;
    }
  }
});
