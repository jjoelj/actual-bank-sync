import { ACCOUNT_TYPES, BANK_LABELS } from "./accounts.js";
import { pacificDate, offsetDate } from "./utils.js";

const $ = (id) => document.getElementById(id);

let actualAccounts = [];
let addedTypes = new Set();
const activeProgress = new Map();

// ── Startup cleanup ───────────────────────────────────────────────────────────

const KNOWN_LOCAL_KEYS = new Set([
  "accountMappings", "addedAccountTypes",
  "cachedActualAccounts", "cachedSofiAccounts", "cachedCapitalOneAccounts", "cachedUSBankAccounts", "cachedWFAccounts",
  "lastSyncTime", "lastCompletedSyncSessionId", "lastCompletedSyncSummary",
  "activeSyncSessionId", "activeSyncSummary", "nextScheduledSyncAt", "syncFromDate",
  "lastSyncDates", "lastSyncMetrics", "syncErrors",
  "startingBalances", "cumulativeTxSums", "countedTxIds", "balanceDrifts",
]);

const PER_ACCOUNT_KEYS = [
  "lastSyncDates", "lastSyncMetrics", "syncErrors",
  "startingBalances", "cumulativeTxSums", "countedTxIds", "balanceDrifts",
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

  const { cachedActualAccounts, accountMappings = {}, addedAccountTypes = [] } =
    await chrome.storage.local.get(["cachedActualAccounts", "accountMappings", "addedAccountTypes"]);

  if (cachedActualAccounts) actualAccounts = cachedActualAccounts;

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

  showView(cachedActualAccounts?.length > 0 ? "accounts" : "settings");

  populateDropdown();
  updateDropdownOptions();
  updateUsedOptions();
  sortAccountRows();
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
  if (hasMapping) renderSyncStatus();
}

$("sync-btn").addEventListener("click", async () => {
  await runSyncFromPopup({}, "Syncing…");
});

$("sync-from-date").addEventListener("change", () => {
  chrome.storage.local.set({ syncFromDate: $("sync-from-date").value });
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
  $("accounts-view").style.paddingBottom = opening ? `${dropdown.offsetHeight + 4}px` : "";
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
    await chrome.storage.local.set({ cachedSofiAccounts: res.accounts });
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addSoFiBankingRows(res.accounts, accountMappings);
    persistAddedTypes();
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
    await chrome.storage.local.set({ cachedCapitalOneAccounts: res.accounts });
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addCapitalOneCards(res.accounts, accountMappings);
    persistAddedTypes();
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
    await chrome.storage.local.set({ cachedUSBankAccounts: res.accounts });
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addUSBankCards(res.accounts, accountMappings);
    persistAddedTypes();
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
    await chrome.storage.local.set({ cachedWFAccounts: res.accounts });
    const { accountMappings = {} } = await chrome.storage.local.get("accountMappings");
    addWFCards(res.accounts, accountMappings);
    persistAddedTypes();
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

function getBankForKey(key) {
  if (key.startsWith("sofi-")) return "sofi";
  if (key.startsWith("capitalone-")) return "capitalone";
  if (key.startsWith("usbank-")) return "usbank";
  if (key.startsWith("wf-")) return "wf";
  return ACCOUNT_TYPES[key]?.bank ?? null;
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

function addMappingRow(mappingKey, label, selectedId) {
  if (document.querySelector(`select[data-mapping-key="${mappingKey}"]`)) return;

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
      { startingBalances = {} }, { cumulativeTxSums = {} }, { countedTxIds = {} }, { balanceDrifts = {} },
    ] = await Promise.all([
      chrome.storage.local.get("accountMappings"),
      chrome.storage.local.get("lastSyncDates"),
      chrome.storage.local.get("lastSyncMetrics"),
      chrome.storage.local.get("syncErrors"),
      chrome.storage.local.get("startingBalances"),
      chrome.storage.local.get("cumulativeTxSums"),
      chrome.storage.local.get("countedTxIds"),
      chrome.storage.local.get("balanceDrifts"),
    ]);
    for (const obj of [accountMappings, lastSyncDates, lastSyncMetrics, syncErrors, startingBalances, cumulativeTxSums, countedTxIds, balanceDrifts]) {
      delete obj[mappingKey];
    }
    await chrome.storage.local.set({ accountMappings, lastSyncDates, lastSyncMetrics, syncErrors, startingBalances, cumulativeTxSums, countedTxIds, balanceDrifts });
    await renderSyncSummary();
    updateSyncBtn();
  });

  row.appendChild(info);
  row.appendChild(mappingDisplay);
  row.appendChild(select);
  row.appendChild(editBtn);
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
  const { lastSyncDates = {}, lastSyncMetrics = {}, syncErrors = {}, startingBalances = {}, cumulativeTxSums = {} } =
    await chrome.storage.local.get(["lastSyncDates", "lastSyncMetrics", "syncErrors", "startingBalances", "cumulativeTxSums"]);

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
        const count = lastSyncMetrics[key]?.count;
        const countStr = formatTransactionCount(count);
        const statusText = countStr ? `Synced ${formatDate(date)} • ${countStr}` : `Synced ${formatDate(date)}`;
        el.className = "account-sub synced";
        row?.classList.remove("is-syncing");
        const balance = startingBalances[key] != null ? startingBalances[key] + (cumulativeTxSums[key] ?? 0) : null;
        if (balance != null) {
          const balanceHtml = balance < 0
            ? `<span class="amount-neg">${escapeHtml(formatCurrency(balance))}</span>`
            : escapeHtml(formatCurrency(balance));
          el.innerHTML = `${escapeHtml(statusText)} • ${balanceHtml}`;
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
    startingBalances = {},
    cumulativeTxSums = {},
    activeSyncSummary = null,
    lastCompletedSyncSummary = null,
    nextScheduledSyncAt = null,
  } = await chrome.storage.local.get([
    "accountMappings",
    "lastSyncDates",
    "startingBalances",
    "cumulativeTxSums",
    "activeSyncSummary",
    "lastCompletedSyncSummary",
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

  // Net worth — always show if we have balance data
  const balanceKeys = mappedKeys.filter(k => startingBalances[k] != null);
  const netWorthRow = $("summary-net-worth-row");
  if (balanceKeys.length > 0) {
    const netWorth = balanceKeys.reduce((sum, k) => sum + startingBalances[k] + (cumulativeTxSums[k] ?? 0), 0);
    $("summary-net-worth").textContent = formatCurrency(netWorth);
    $("summary-net-worth").className = netWorth < 0 ? "amount-neg" : "";

    const deltaEl = $("summary-net-worth-delta");
    const net = lastCompletedSyncSummary
      ? (lastCompletedSyncSummary.inflow || 0) - (lastCompletedSyncSummary.outflow || 0)
      : null;
    if (net != null && net !== 0) {
      deltaEl.textContent = (net > 0 ? "▲ " : "▼ ") + formatCurrency(Math.abs(net));
      deltaEl.className = net > 0 ? "delta-up" : "delta-down";
    } else {
      deltaEl.textContent = "";
      deltaEl.className = "";
    }

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
  if (isoStr === offsetDate(pacificDate(new Date()), -1)) return "today";
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

  syncBtn.disabled = false;
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
