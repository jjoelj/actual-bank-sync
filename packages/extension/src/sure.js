async function getSettings() {
  const { sureApiKey, sureUrl } = await chrome.storage.sync.get(["sureApiKey", "sureUrl"]);
  if (!sureUrl) throw new Error("Sure URL not configured");
  if (!sureApiKey) throw new Error("Sure API key not configured");
  return { apiKey: sureApiKey, baseUrl: sureUrl.replace(/\/+$/, "") + "/api/v1" };
}

async function apiFetch(path, options = {}) {
  const { apiKey, baseUrl } = await getSettings();
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error("Sure API error:", res.status, JSON.stringify(body));
    throw new Error(body.message || body.error || JSON.stringify(body) || `Sure API error: ${res.status}`);
  }
  return res.json();
}

export async function testConnection() {
  await apiFetch("/accounts?page=1&per_page=1");
  return { ok: true };
}

function parseBalanceToCents(balanceStr) {
  if (!balanceStr) return null;
  const cleaned = balanceStr.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const negative = balanceStr.includes("-") || balanceStr.includes("(");
  const cents = Math.round(parseFloat(cleaned) * 100);
  return negative ? -cents : cents;
}

export async function getAccounts() {
  const allAccounts = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(`/accounts?page=${page}&per_page=100`);
    allAccounts.push(...data.accounts);
    if (page >= data.pagination.total_pages) break;
    page++;
  }
  return allAccounts.map(a => {
    const raw = a.balance_cents ?? parseBalanceToCents(a.balance);
    const sign = a.classification === "liability" ? -1 : 1;
    return { id: a.id, name: a.name, balance_cents: raw != null ? raw * sign : null };
  });
}

export async function getCategories() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(`/categories?page=${page}&per_page=100`);
    all.push(...data.categories);
    if (page >= data.pagination.total_pages) break;
    page++;
  }
  return all.map(c => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null }));
}

export async function createCategory(name) {
  const data = await apiFetch("/categories", {
    method: "POST",
    body: JSON.stringify({ category: { name } }),
  });
  return { id: data.id, name: data.name, parent: data.parent?.name ?? null };
}

// Set a transaction's category. The CSV import API ignores the category column
// (it never builds the import mappings that resolve category names), so
// categories are applied here per transaction after the import completes.
export async function setTransactionCategory(transactionId, categoryId) {
  return apiFetch(`/transactions/${transactionId}`, {
    method: "PATCH",
    body: JSON.stringify({ transaction: { category_id: categoryId } }),
  });
}

export async function createCsvImport(accountId, transactions) {
  const header = "date,amount,name,notes";
  const rows = transactions.map(tx => {
    const amount = (tx.amount / 100).toFixed(2);
    return `${tx.date},${amount},${csvEscape(tx.payee_name || "Unknown")},${csvEscape(tx.notes || "")}`;
  });

  const result = await apiFetch("/imports", {
    method: "POST",
    body: JSON.stringify({
      raw_file_content: [header, ...rows].join("\n"),
      type: "TransactionImport",
      account_id: accountId,
      publish: "true",
      date_col_label: "date",
      amount_col_label: "amount",
      name_col_label: "name",
      notes_col_label: "notes",
      signage_convention: "inflows_positive",
      date_format: "%Y-%m-%d",
    }),
  });

  const importId = result.data?.id || result.id || result.import?.id;
  if (importId) await waitForImportComplete(importId);
  else console.warn("CSV import: response had no import id, cannot confirm completion.", JSON.stringify(result));

  return result;
}

async function waitForImportComplete(importId, timeoutMs = 120000) {
  const start = Date.now();
  let seen = false; // have we observed the import in the listing yet?
  while (Date.now() - start < timeoutMs) {
    const data = await apiFetch(`/imports?per_page=100`);
    const list = data.imports || data.data || [];
    const imp = list.find(i => i.id === importId);
    if (imp) {
      seen = true;
      if (imp.status === "complete") return;
      if (imp.status === "failed") throw new Error(`Import ${importId} failed`);
    } else if (seen) {
      // It was listed and is now gone — treat as complete (the list drops it).
      return;
    }
    // Not yet listed (indexing lag): keep waiting rather than assuming complete.
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn(`Import ${importId}: timed out waiting for completion`);
}

// The api/v1 surface (X-Api-Key) can't create splits or apply rules — those are
// web-app endpoints behind the user's cookie session and Rails CSRF. Grab the
// CSRF token from the app shell's <meta> tag; the same token authorizes both the
// X-CSRF-Token header and the form's authenticity_token param.
async function getCsrfContext() {
  const { baseUrl } = await getSettings();
  const rootUrl = baseUrl.replace(/\/api\/v1$/, "");
  const page = await fetch(rootUrl, { credentials: "include" });
  const html = await page.text();
  const match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!match) throw new Error("Could not find CSRF token");
  return { rootUrl, csrf: match[1] };
}

export async function applyRules() {
  const { rootUrl, csrf } = await getCsrfContext();
  const res = await fetch(rootUrl + "/rules/apply_all", {
    method: "POST",
    credentials: "include",
    headers: {
      "X-CSRF-Token": csrf,
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Rules apply failed: ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

// Split transactions via the web endpoint. This MUST run same-origin: Sure's
// session cookie is SameSite=Lax, so a cross-site fetch from the background
// service worker doesn't carry it and Rails rejects the POST with a 422 CSRF
// error. So we run the fetches inside a Sure page (reusing an open tab, else a
// transient background one) via executeScript, where the cookie and the page's
// CSRF token are valid — the same trick venmo.js uses for the Venmo tab.
//
// ops: [{ transactionId, method: "POST"|"PATCH", children: [{ name, amount, category_id }] }].
// transactionId is the /api/v1 transaction id — but the split route needs the
// Entry id, which the API doesn't expose, so the in-page runner resolves it from
// the account's activity HTML (each row nests entry_<E> > transaction_<T>).
// amount is a signed dollar string in the inflows-positive convention (Sure
// negates it server-side); children must sum to the parent. Returns
// [{ transactionId, ok, status?, error? }].
export async function executeSplitsInSureTab(accountId, ops) {
  if (!ops.length) return [];
  const { sureUrl } = await chrome.storage.sync.get("sureUrl");
  if (!sureUrl) throw new Error("Sure URL not configured");
  const origin = new URL(sureUrl).origin;

  const [existing] = await chrome.tabs.query({ url: origin + "/*" });
  let tabId, opened = false;
  if (existing) {
    tabId = existing.id;
  } else {
    const tab = await chrome.tabs.create({ url: origin, active: false });
    tabId = tab.id;
    opened = true;
    await waitForTabComplete(tabId);
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [{ accountId, ops }],
      func: inPageSplitRunner,
    });
    return result ?? [];
  } finally {
    if (opened) chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Sure tab load timed out")); }, timeoutMs);
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(() => {});
  });
}

// Runs in the Sure page (content-script context, so same-origin): resolves each
// transaction id to its entry id from the account's activity HTML, then
// POST/PATCHes each split. Standalone — executeScript serializes the source, so
// it can't reference anything outside itself.
async function inPageSplitRunner({ accountId, ops }) {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrf) return ops.map((o) => ({ transactionId: o.transactionId, ok: false, error: "no CSRF token (Sure not logged in?)" }));

  // Map transaction id -> entry id by scanning the account's activity pages.
  // Each row renders <turbo-frame id="entry_E"> wrapping <turbo-frame
  // id="transaction_T">, so in source order an entry_ frame is followed by its
  // transaction_ frame. (The selection checkbox id is "selection_entry_…", which
  // this pattern doesn't match.)
  const need = new Set(ops.map((o) => o.transactionId));
  const t2e = {};
  const FRAME = /id="(entry|transaction)_([0-9a-f-]{36})"/g;
  for (let page = 1; page <= 100 && need.size; page++) {
    let html;
    try {
      const res = await fetch(`/accounts/${accountId}?tab=activity&page=${page}`, { credentials: "include", headers: { Accept: "text/html" } });
      if (!res.ok) break;
      html = await res.text();
    } catch { break; }
    let m, lastEntry = null, rows = 0;
    while ((m = FRAME.exec(html))) {
      if (m[1] === "entry") { lastEntry = m[2]; rows++; }
      else if (lastEntry) { t2e[m[2]] = lastEntry; need.delete(m[2]); lastEntry = null; }
    }
    if (rows === 0) break; // no transaction rows on this page → past the end
  }

  const out = [];
  for (const op of ops) {
    const entryId = t2e[op.transactionId];
    if (!entryId) { out.push({ transactionId: op.transactionId, ok: false, error: "entry id not found in activity" }); continue; }
    try {
      const body = new URLSearchParams();
      body.set("authenticity_token", csrf);
      op.children.forEach((c, i) => {
        body.append(`split[splits][${i}][name]`, c.name ?? "");
        body.append(`split[splits][${i}][amount]`, String(c.amount));
        body.append(`split[splits][${i}][category_id]`, c.category_id ?? "");
      });
      const res = await fetch(`/transactions/${entryId}/split`, {
        method: op.method,
        credentials: "include",
        headers: {
          "X-CSRF-Token": csrf,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "text/vnd.turbo-stream.html, text/html, application/xhtml+xml",
        },
        body: body.toString(),
      });
      out.push({ transactionId: op.transactionId, ok: res.ok, status: res.status });
    } catch (e) {
      out.push({ transactionId: op.transactionId, ok: false, error: String(e?.message || e) });
    }
  }
  return out;
}

function csvEscape(str) {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function getTransactionCount(accountId) {
  const data = await apiFetch(`/transactions?account_id=${accountId}&page=1&per_page=1`);
  return data.pagination?.total_count ?? data.transactions?.length ?? 0;
}

// Delete an account's transactions. With { startDate } only rows dated on or
// after startDate are removed (reconcile's date-bounded reset); without it,
// every transaction is deleted.
export async function deleteAllTransactions(accountId, { startDate } = {}) {
  const { apiKey, baseUrl } = await getSettings();
  let deleted = 0;
  const MAX_PASSES = 100; // safety bound; each pass strictly reduces what remains

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const fetched = await getTransactions(accountId, startDate ? { startDate } : {});
    // Date-bounded reset (reconcile) skips transfers: deleting a transfer leg
    // makes Sure remove its paired entry on the other account, which an
    // account-scoped reset must not touch. A full wipe still deletes everything.
    const transactions = startDate ? fetched.filter(tx => !isTransfer(tx)) : fetched;
    if (transactions.length === 0) return deleted;

    let progressed = false;
    for (const tx of transactions) {
      const res = await fetch(`${baseUrl}/transactions/${tx.id}`, {
        method: "DELETE",
        headers: { "X-Api-Key": apiKey },
      });
      if (res.ok) { deleted++; progressed = true; continue; }

      const body = await res.json().catch(() => ({}));
      const msg = body.message || body.error || `Delete failed: ${res.status}`;
      // A row from our snapshot can already be gone — e.g. Sure auto-removes a
      // transfer's paired entry when its counterpart is deleted. Skip it and let
      // the next pass re-fetch a fresh list, restarting the delete rather than
      // aborting the whole operation.
      if (res.status === 404 || /not found/i.test(msg)) continue;
      // A split child can't be deleted on its own; deleting its parent cascades
      // and removes it. Skip it here — once the parent is deleted (in this pass
      // or a later one) the child disappears from the next fetch.
      if (/split child/i.test(msg)) continue;
      // Any other error is real and propagates.
      throw new Error(msg);
    }

    // The list is non-empty but nothing could be deleted this pass — every
    // remaining row is a split child with no deletable parent, or hits an error
    // we keep skipping. Bail out clearly instead of spinning to MAX_PASSES.
    if (!progressed) {
      throw new Error(`Delete stalled with ${transactions.length} transaction(s) left that could not be removed (likely orphaned split children).`);
    }
  }
  throw new Error(`Delete did not finish after ${MAX_PASSES} passes — transactions keep reporting "not found".`);
}


const PER_PAGE = 100;

// Sure's offset pagination is lossy: when a result set spans more than one page,
// its LIMIT/OFFSET ordering isn't stable across the boundary, so exactly one row
// per multi-page window silently never appears on any page (confirmed: 610/611).
// Re-paging can't recover it. The only reliable fix is to never cross a page
// boundary — fetch the range, and whenever a window holds more than one page,
// split it in half by date and recurse, so every kept response is a single
// complete page. Used by the paths where completeness matters (reconcile, import
// dedup, delete); getLatestTransactionDate uses the cheaper paged path below.
export async function getTransactions(accountId, { startDate, endDate } = {}) {
  const byId = new Map();
  await fetchRange(accountId, startDate || "1970-01-01", endDate || isoToday(), byId);
  return [...byId.values()];
}

async function fetchRange(accountId, startDate, endDate, byId) {
  const data = await fetchTxPage(accountId, startDate, endDate, 1);
  for (const tx of data.transactions) byId.set(tx.id, tx);
  // If the count is missing, a full page means there's probably more — force a
  // split rather than assume this single page is the whole window.
  const total = data.pagination.total_count
    ?? (data.transactions.length >= PER_PAGE ? Infinity : data.transactions.length);
  if (total <= PER_PAGE) return; // whole window fits in this one page — done

  if (startDate === endDate) {
    // A single day with more than one page of rows can't be split by date; page
    // through it (best effort) and accept the API's drop if it occurs.
    for (let page = 2; page <= data.pagination.total_pages; page++) {
      const more = await fetchTxPage(accountId, startDate, endDate, page);
      for (const tx of more.transactions) byId.set(tx.id, tx);
    }
    console.warn(`getTransactions(${accountId}): ${total} rows on a single day (${startDate}); pagination may drop one.`);
    return;
  }

  // Split the date range so no kept window spans a page boundary.
  let mid = midpointDate(startDate, endDate);
  if (mid === null) mid = startDate; // adjacent days: peel the first off
  await fetchRange(accountId, startDate, mid, byId);
  await fetchRange(accountId, nextDay(mid), endDate, byId);
}

function fetchTxPage(accountId, startDate, endDate, page) {
  let url = `/transactions?account_id=${accountId}&page=${page}&per_page=${PER_PAGE}`;
  if (startDate) url += `&start_date=${startDate}`;
  if (endDate) url += `&end_date=${endDate}`;
  return apiFetch(url);
}

function isoToday() { return new Date().toISOString().slice(0, 10); }
function dayMs(d) { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); }
function isoFromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }
function nextDay(d) { return isoFromMs(dayMs(d) + 86400000); }
function midpointDate(start, end) {
  const days = Math.round((dayMs(end) - dayMs(start)) / 86400000);
  if (days < 2) return null; // 0 or 1 day apart: nothing strictly interior
  return isoFromMs(dayMs(start) + Math.floor(days / 2) * 86400000);
}

// Cheap full-history fetch for callers that don't need every row — plain offset
// paging with id-dedupe. Inherits Sure's one-row-per-window drop, which is
// harmless for a max-date lookup but unsafe for completeness checks.
async function fetchAllPagesLossy(accountId, { startDate, endDate } = {}) {
  const byId = new Map();
  let page = 1, totalPages = 1;
  do {
    const data = await fetchTxPage(accountId, startDate, endDate, page);
    for (const tx of data.transactions) byId.set(tx.id, tx);
    totalPages = data.pagination.total_pages;
    page++;
  } while (page <= totalPages);
  return [...byId.values()];
}

// A transaction is part of a transfer when Sure links it via `transfer`, or
// classifies it as one. Transfers (e.g. card payments) can be dated later than
// the last real bank transaction, so they must be excluded from the sync
// watermark or the next sync skips the gap between them.
function isTransfer(tx) {
  return Boolean(tx.transfer) || tx.classification === "transfer";
}

export async function getLatestTransactionDate(accountId) {
  const txs = await fetchAllPagesLossy(accountId);
  let maxDate = null;
  for (const tx of txs) {
    if (isTransfer(tx)) continue;
    if (maxDate == null || tx.date > maxDate) maxDate = tx.date;
  }
  return maxDate;
}

