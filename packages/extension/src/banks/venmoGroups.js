// Venmo group expenses -> categorized Actual/Sure split transactions.
//
// A Venmo group settlement (someone paying you back, or you paying them) is a
// real P2P transaction that the Venmo statement sync already imports as
// `venmo-<p2pId>`. Settlements pay down a *net balance*, not specific expenses,
// so we FIFO-allocate each counterparty's settlements across the shares that
// side owes, oldest expense first — each slice carrying its expense's category.
// The slices for one settlement sum to it, which is exactly what Actual and Sure
// require of a split's subtransactions.
//
// The GraphQL surface here was recovered from the Venmo Android app
// (com.venmo.android.groups.service, v26.15.0); the `graphql/` endpoint is its
// "orchestration layer" (hence the OL* type names). Auth reuses the same bearer
// token venmo.js already captures for the credit-card sync.
//
// This module is pure data + fetch; writing the splits and prompting for
// per-expense categories lives with the sync/popup code that calls it.

import { sendToHost } from "../host.js";
import { getTransactions as getSureTransactions, getCategories as getSureCategories, executeSplitsInSureTab } from "../sure.js";

const GQL_URL = "https://api.venmo.com/graphql/";

// Convert an ISO timestamp to a Pacific YYYY-MM-DD — the same calendar day the
// statement CSV import used, so a settlement lines up with its Sure entry.
function pacificDay(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

async function gql(bearerToken, query, variables) {
    const res = await fetch(GQL_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Venmo groups GraphQL ${res.status}`);
    const body = await res.json();
    if (body.errors) throw new Error(`Venmo groups: ${JSON.stringify(body.errors)}`);
    return body.data;
}

// The groups-context Profile type only exposes groupsSummary, so identity comes
// from REST /v1/account — its user.id matches the GraphQL distribution ids.
export async function fetchVenmoUserId(bearerToken) {
    const res = await fetch("https://api.venmo.com/v1/account", {
        headers: { authorization: `Bearer ${bearerToken}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Venmo account lookup ${res.status}`);
    const body = await res.json();
    const id = body?.data?.user?.id;
    if (id == null) throw new Error("Venmo account: user id missing");
    return String(id);
}

const GROUPS_Q = `query { profile { ... on Profile {
  groupsSummary { reducedGroups { id name banner } } } } }`;

export async function fetchVenmoGroups(bearerToken) {
    const data = await gql(bearerToken, GROUPS_Q, {});
    return data.profile?.groupsSummary?.reducedGroups ?? [];
}

const EXPENSES_Q = `query($input: GetGroupExpensesInput!){
  getGroupExpenses(input: $input) { ... on GroupExpensesPage {
    pageInfo { endCursor hasNextPage }
    edges { node {
      id note amount { value } createdAt createdByUserId
      distribution { user { id displayName } paid { value } owed { value } }
    } }
  } }
}`;

export async function fetchGroupExpenses(bearerToken, groupId, sinceDate) {
    const out = [];
    let after = null;
    do {
        const input = after ? { groupId, pagination: { after } } : { groupId };
        const page = (await gql(bearerToken, EXPENSES_Q, { input })).getGroupExpenses;
        for (const e of page.edges) out.push(e.node);
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        // Newest-first: stop once a page reaches past the start date.
        // buildGroupSplits still filters authoritatively, so a partial trailing
        // page is fine.
        if (pageReachedBack(page.edges.map((e) => e.node.createdAt ?? ""), sinceDate)) break;
    } while (after);
    return out;
}

const ACTIVITIES_Q = `query($input: GetGroupInput!, $feedInput: PaginatedInput!){
  getGroup(input: $input) { ... on Group { activities(input: $feedInput) {
    pageInfo { endCursor hasNextPage }
    edges { node {
      id type transactionDate amount { value }
      activityUser { id } involvedUser { id }
    } }
  } } }
}`;

export async function fetchGroupActivities(bearerToken, groupId, sinceDate) {
    const out = [];
    let after = null;
    do {
        const feedInput = after ? { first: 60, after } : { first: 60 };
        const page = (await gql(bearerToken, ACTIVITIES_Q, { input: { groupId }, feedInput })).getGroup.activities;
        for (const e of page.edges) out.push(e.node);
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        // Newest-first: stop once a page reaches past the start date. Activities
        // include dateless nodes (memberJoined), which pageReachedBack ignores.
        if (pageReachedBack(page.edges.map((e) => e.node.transactionDate ?? ""), sinceDate)) break;
    } while (after);
    return out;
}

// True once a newest-first page reaches back past the cutoff, so paging can
// stop. Dateless nodes (e.g. a memberJoined activity has a null date) must NOT
// trip this — an empty string sorts before every real date and would falsely
// stop paging on the first page, dropping every settlement beyond it.
export function pageReachedBack(dates, sinceDate) {
    if (!sinceDate) return false;
    return dates.some((d) => d && d.slice(0, 10) < sinceDate);
}

const toCents = (v) => Math.round((v ?? 0) * 100);

// Normalize a raw getGroupExpenses node into { id, note, date, dist: {userId: {paid, owed}} }.
export function normalizeExpense(node) {
    const dist = {};
    for (const d of node.distribution ?? []) {
        dist[d.user.id] = { paid: toCents(d.paid?.value), owed: toCents(d.owed?.value), name: d.user.displayName };
    }
    return { id: node.id, note: node.note ?? "", date: node.createdAt ?? "", dist };
}

// Normalize a venmoP2pSettlement activity into a directed settlement, or null.
// direction: "in" = someone paid me (money in), "out" = I paid someone.
export function normalizeSettlement(node, myId) {
    if (node.type !== "venmoP2pSettlement") return null;
    const payer = node.activityUser?.id, payee = node.involvedUser?.id;
    let direction, counterparty;
    if (payee === myId && payer !== myId) { direction = "in"; counterparty = payer; }
    else if (payer === myId && payee !== myId) { direction = "out"; counterparty = payee; }
    else return null;
    const p2pId = node.id?.startsWith("p2p-") ? node.id.slice(4) : null;
    return {
        direction, counterparty, p2pId,
        importedId: p2pId ? `venmo-${p2pId}` : null,
        date: node.transactionDate ?? "",
        cents: toCents(node.amount?.value), // magnitude
    };
}

// FIFO-allocate chronological settlement magnitudes across chronological owed
// shares. Mutates each settlement, setting `slices` ([{expenseId, note, cents}])
// and `unallocated` (payment with no owed share left — prepay/overpay). Returns
// the still-owed remainder.  ponytail: greedy two-pointer — the only allocation
// that reconciles when Venmo won't tell us which expense a payment cleared.
export function allocate(shares, settlements) {
    shares = shares.slice().sort((a, b) => a.date.localeCompare(b.date));
    settlements = settlements.slice().sort((a, b) => a.date.localeCompare(b.date));
    let si = 0, shareLeft = shares[0] ? shares[0].cents : 0;
    for (const s of settlements) {
        s.slices = [];
        let pay = s.cents;
        while (pay > 0 && si < shares.length) {
            if (shareLeft === 0) { si++; shareLeft = shares[si] ? shares[si].cents : 0; continue; }
            const take = Math.min(pay, shareLeft);
            s.slices.push({ expenseId: shares[si].id, note: shares[si].note, cents: take });
            pay -= take; shareLeft -= take;
        }
        s.unallocated = pay;
    }
    return (si < shares.length ? shareLeft : 0) + shares.slice(si + 1).reduce((a, s) => a + s.cents, 0);
}

// Turn one group's expenses + activities into split descriptors, one per
// settlement transaction. Each descriptor:
//   { importedId, p2pId, direction, amountCents (signed), unallocatedCents,
//     subtransactions: [{ expenseId, note, amountCents (signed) }] }
// Sign convention: "in" is positive (money in, offsets spend), "out" negative
// (money out, your spend). Slices inherit the settlement's sign.
//
// Allocation is POOLED per direction, not per person. My net position on an
// expense is `paid - owed`: positive means others owe me that much (an incoming
// settlement pays it back), negative means I owe it (an outgoing settlement
// pays it). Because Venmo group debts are simplified, the member who actually
// sends a settlement is just a router — what matters is that money received
// pays down the total I'm owed, oldest expense first, and each slice carries
// that expense's category. Only settlements at/after startDate are considered
// (their transactions are the ones imported into the app).
export function buildGroupSplits(rawExpenses, rawActivities, myId, startDate) {
    let expenses = rawExpenses.map(normalizeExpense);
    let settlements = rawActivities.map((a) => normalizeSettlement(a, myId)).filter(Boolean);
    if (startDate) {
        expenses = expenses.filter((e) => e.date.slice(0, 10) >= startDate);
        settlements = settlements.filter((s) => s.date.slice(0, 10) >= startDate);
    }

    const dueToMe = [];  // expenses others owe me on (I fronted more than my share)
    const owedByMe = []; // expenses I owe on (I paid less than my share)
    for (const e of expenses) {
        const me = e.dist[myId];
        if (!me) continue;
        const net = me.paid - me.owed;
        if (net > 0) dueToMe.push({ id: e.id, note: e.note, date: e.date, cents: net });
        else if (net < 0) owedByMe.push({ id: e.id, note: e.note, date: e.date, cents: -net });
    }

    const incoming = settlements.filter((s) => s.direction === "in");
    const outgoing = settlements.filter((s) => s.direction === "out");
    allocate(dueToMe, incoming);
    allocate(owedByMe, outgoing);

    const splits = [];
    for (const [group, sign] of [[incoming, 1], [outgoing, -1]]) {
        for (const s of group) {
            splits.push({
                importedId: s.importedId,
                p2pId: s.p2pId,
                direction: s.direction,
                settledAt: s.date, // raw transactionDate — used to match the Sure entry
                amountCents: sign * s.cents,
                unallocatedCents: sign * s.unallocated,
                subtransactions: s.slices.map((sl) => ({ expenseId: sl.expenseId, note: sl.note, amountCents: sign * sl.cents })),
            });
        }
    }
    return splits;
}

// Fetch every group's expenses + settlements, build the splits, and apply them
// to the Actual venmo-cash account (settlements are venmo-cash transactions).
// expenseCategories maps expenseId -> category name (set in the popup); a child
// with no mapping imports uncategorized. Sure is intentionally not handled — its
// API has no split-create endpoint (see docs/reverse-engineering/venmo-api.md).
// Fill each cached split's children with the category chosen for its expense
// (keyed by expenseId) and shape them for the applyActualSplits worker command.
export function buildCategorizedPayload(rawSplits, expenseCategories = {}) {
    return rawSplits.map((s) => ({
        importedId: s.importedId,
        subtransactions: s.subtransactions.map((sub) => ({
            note: sub.note,
            amountCents: sub.amountCents,
            category: expenseCategories[sub.expenseId] || undefined,
        })),
    }));
}

const EMPTY_RESULT = { split: 0, updated: 0, already: 0, skipped: 0, missing: 0 };

export async function syncVenmoGroups(bearerToken, settings, actualAccountId, expenseCategories = {}, startDate, sureAccountId) {
    const myId = await fetchVenmoUserId(bearerToken);
    const groups = await fetchVenmoGroups(bearerToken);

    let splits = [];
    const expenseInfo = {}; // expenseId -> { id, note, group, date, cents } for the popup
    for (const g of groups) {
        const [expenses, activities] = await Promise.all([
            fetchGroupExpenses(bearerToken, g.id, startDate),
            fetchGroupActivities(bearerToken, g.id, startDate),
        ]);
        const groupSplits = buildGroupSplits(expenses, activities, myId, startDate);
        splits = splits.concat(groupSplits);

        const dateById = {};
        for (const e of expenses) dateById[e.id] = (e.createdAt ?? "").slice(0, 10);
        for (const s of groupSplits) for (const sub of s.subtransactions) {
            const info = (expenseInfo[sub.expenseId] ??= { id: sub.expenseId, note: sub.note, group: g.name, date: dateById[sub.expenseId] ?? "", cents: 0 });
            info.cents += Math.abs(sub.amountCents);
        }
    }

    // Only settlements that map to a real imported transaction can be split.
    const rawSplits = splits
        .filter((s) => s.importedId && s.subtransactions.length)
        .map((s) => ({ importedId: s.importedId, settledAt: s.settledAt, amountCents: s.amountCents, subtransactions: s.subtransactions.map((sub) => ({ expenseId: sub.expenseId, note: sub.note, amountCents: sub.amountCents })) }));

    // Cache for the popup's per-expense category UI: the expense list to show,
    // and the raw splits so categories can be (re)applied later — from the popup
    // when the user assigns one — without another Venmo fetch.
    await chrome.storage.local.set({
        venmoGroupExpenses: Object.values(expenseInfo).sort((a, b) => b.date.localeCompare(a.date)),
        venmoGroupSplits: rawSplits,
        venmoGroupActualId: actualAccountId ?? null,
        venmoGroupSureId: sureAccountId ?? null,
    });

    return applyToApps(settings, rawSplits, expenseCategories, actualAccountId, sureAccountId);
}

// Apply the splits to whichever apps venmo-cash targets. Actual runs in the host
// worker; Sure runs here (web endpoint). A failure in one app is logged and does
// not block the other.
async function applyToApps(settings, rawSplits, expenseCategories, actualAccountId, sureAccountId) {
    const result = { actual: null, sure: null };
    if (!rawSplits.length) return result;
    if (actualAccountId) {
        try {
            result.actual = await sendToHost("applyActualSplits", { settings, accountId: actualAccountId, splits: buildCategorizedPayload(rawSplits, expenseCategories) });
        } catch (err) { console.error("Venmo Groups (Actual) failed:", err.message); }
    }
    if (sureAccountId) {
        try {
            result.sure = await applySureSplits(sureAccountId, rawSplits, expenseCategories);
        } catch (err) { console.error("Venmo Groups (Sure) failed:", err.message); }
    }
    return result;
}

// Re-apply the current per-expense categories to the already-computed splits,
// no Venmo fetch — driven by the popup when the user picks an expense category.
export async function applyVenmoGroupCategories(settings) {
    const { venmoGroupSplits = [], venmoGroupActualId, venmoGroupSureId, venmoExpenseCategories = {} } =
        await chrome.storage.local.get(["venmoGroupSplits", "venmoGroupActualId", "venmoGroupSureId", "venmoExpenseCategories"]);
    return applyToApps(settings, venmoGroupSplits, venmoExpenseCategories, venmoGroupActualId, venmoGroupSureId);
}

// Apply splits to Sure. Sure has no imported_id and its web split endpoint
// returns redirects (no clean success signal), so: match the settlement to a
// Sure entry by signed amount + date (±1 day for the statement's tz rounding),
// and track what we've split in storage (venmoSureSplitState: entryId -> hash)
// to stay content-idempotent — POST a new split, PATCH a changed one, skip an
// unchanged one — without reading Sure's split state.
async function applySureSplits(sureAccountId, rawSplits, expenseCategories) {
    if (!rawSplits.length) return { ...EMPTY_RESULT };
    const [txs, cats, stored] = await Promise.all([
        getSureTransactions(sureAccountId),
        getSureCategories(),
        chrome.storage.local.get("venmoSureSplitState"),
    ]);
    const state = stored.venmoSureSplitState ?? {};
    const catIdByName = new Map(cats.map((c) => [c.name, c.id]));

    // Index Sure entries by |cents| for amount matching.
    const byAbs = new Map();
    for (const t of txs) {
        const cents = t.signed_amount_cents;
        if (cents == null) continue;
        (byAbs.get(Math.abs(cents)) ?? byAbs.set(Math.abs(cents), []).get(Math.abs(cents))).push(t);
    }

    const result = { ...EMPTY_RESULT };
    const ops = []; // { transactionId, method, children, hash, update }
    for (const s of rawSplits) {
        const tx = matchSureEntry(byAbs, s.amountCents, pacificDay(s.settledAt));
        if (!tx) { result.missing++; continue; }

        const children = [];
        let sum = 0;
        for (const sub of s.subtransactions) {
            sum += sub.amountCents;
            const catName = expenseCategories[sub.expenseId];
            children.push({ name: sub.note || "Venmo group", amount: (sub.amountCents / 100).toFixed(2), category_id: (catName && catIdByName.get(catName)) || "" });
        }
        const remainder = s.amountCents - sum;
        if (remainder !== 0) children.push({ name: "Venmo group: unallocated", amount: (remainder / 100).toFixed(2), category_id: "" });

        const hash = JSON.stringify(children);
        const prev = state[tx.id]; // keyed by api transaction id
        if (prev === hash) { result.already++; continue; }
        ops.push({ transactionId: tx.id, method: prev != null ? "PATCH" : "POST", children, hash, update: prev != null });
    }

    if (ops.length) {
        // POST/PATCH (and the entry-id lookup) must run same-origin — Sure's
        // session cookie is SameSite=Lax. executeSplitsInSureTab does both in a
        // Sure tab. Only record state for the ones that actually succeeded, so
        // failures retry next run.
        const results = await executeSplitsInSureTab(sureAccountId, ops.map(({ transactionId, method, children }) => ({ transactionId, method, children })));
        const byTx = new Map(results.map((r) => [r.transactionId, r]));
        for (const op of ops) {
            const r = byTx.get(op.transactionId);
            if (r?.ok) {
                state[op.transactionId] = op.hash;
                if (op.update) result.updated++; else result.split++;
            } else {
                console.warn(`Sure split ${op.transactionId}: ${r?.status || r?.error || "no result"}`);
                result.skipped++;
            }
        }
        await chrome.storage.local.set({ venmoSureSplitState: state });
    }
    return result;
}

// A settlement matches a Sure entry with the same signed amount and a date
// within a day (the statement CSV's local date can differ from the settlement's
// UTC date by one). Ambiguous matches (more than one candidate) are skipped by
// returning null so we never split the wrong transaction.
export function matchSureEntry(byAbs, amountCents, day) {
    const candidates = (byAbs.get(Math.abs(amountCents)) ?? [])
        .filter((t) => Math.sign(t.signed_amount_cents) === Math.sign(amountCents))
        .filter((t) => !day || !t.date || Math.abs(dayDiff(t.date, day)) <= 1);
    return candidates.length === 1 ? candidates[0] : null;
}

function dayDiff(a, b) {
    return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}
