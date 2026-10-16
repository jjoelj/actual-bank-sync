// Run: node src/banks/venmoGroups.test.mjs
import assert from "node:assert";
import { allocate, buildGroupSplits, normalizeSettlement, pageReachedBack, buildCategorizedPayload, matchSureEntry } from "./venmoGroups.js";

// ── matchSureEntry: match a settlement to a Sure entry by signed amount + date,
//    reject ambiguous or wrong-sign candidates ─────────────────────────────────
{
    const idx = (entries) => { const m = new Map(); for (const e of entries) { const k = Math.abs(e.signed_amount_cents); (m.get(k) ?? m.set(k, []).get(k)).push(e); } return m; };

    const one = idx([{ id: "a", signed_amount_cents: 1878, date: "2026-05-19" }]);
    assert.equal(matchSureEntry(one, 1878, "2026-05-19")?.id, "a", "exact amount+date");
    assert.equal(matchSureEntry(one, 1878, "2026-05-20")?.id, "a", "one day off still matches (tz rounding)");
    assert.equal(matchSureEntry(one, 1878, "2026-05-25"), null, "too far → no match");
    assert.equal(matchSureEntry(one, -1878, "2026-05-19"), null, "wrong sign → no match");

    // two same-amount, same-day entries → ambiguous → skip rather than guess
    const two = idx([
        { id: "a", signed_amount_cents: 5000, date: "2026-05-19" },
        { id: "b", signed_amount_cents: 5000, date: "2026-05-19" },
    ]);
    assert.equal(matchSureEntry(two, 5000, "2026-05-19"), null, "ambiguous → null");
}

// ── buildCategorizedPayload: fill child categories by expenseId ───────────────
{
    const raw = [{ importedId: "venmo-1", subtransactions: [
        { expenseId: "e1", note: "Costco", amountCents: 500 },
        { expenseId: "e2", note: "Pizza", amountCents: 300 },
    ] }];
    const out = buildCategorizedPayload(raw, { e1: "Groceries" });
    assert.deepEqual(out, [{ importedId: "venmo-1", subtransactions: [
        { note: "Costco", amountCents: 500, category: "Groceries" },
        { note: "Pizza", amountCents: 300, category: undefined }, // unset expense → no category
    ] }]);
}

// ── pageReachedBack: stop paging only on a real older date, never a dateless
//    node (a memberJoined activity has a null date; "" must not trip the stop) ─
{
    assert.equal(pageReachedBack(["2026-05-01", "2026-04-01"], "2025-01-01"), false, "all newer → keep paging");
    assert.equal(pageReachedBack(["2026-05-01", "2024-12-01"], "2025-01-01"), true, "a real older date → stop");
    assert.equal(pageReachedBack(["2026-05-01", ""], "2025-01-01"), false, "dateless node must not stop paging");
    assert.equal(pageReachedBack(["2026-05-01"], undefined), false, "no cutoff → never stop");
}

// ── allocate: FIFO across shares, exact reconciliation ────────────────────────
{
    const shares = [
        { id: "e1", note: "Costco", date: "2026-01-01", cents: 1000 },
        { id: "e2", note: "Pizza",  date: "2026-01-05", cents: 500 },
        { id: "e3", note: "Dave's", date: "2026-01-09", cents: 300 },
    ];
    const settlements = [
        { date: "2026-01-06", cents: 1200 }, // clears e1 (1000) + 200 of e2
        { date: "2026-01-10", cents: 400 },  // rest of e2 (300) + 100 of e3
    ];
    assert.equal(allocate(shares, settlements), 200, "e3 has 200 still owed");

    assert.deepEqual(settlements[0].slices, [
        { expenseId: "e1", note: "Costco", cents: 1000 },
        { expenseId: "e2", note: "Pizza", cents: 200 },
    ]);
    assert.equal(settlements[0].unallocated, 0);
    assert.deepEqual(settlements[1].slices, [
        { expenseId: "e2", note: "Pizza", cents: 300 },
        { expenseId: "e3", note: "Dave's", cents: 100 },
    ]);
    // Invariant: every settlement's slices + unallocated == its amount.
    for (const s of settlements) {
        assert.equal(s.slices.reduce((a, x) => a + x.cents, 0) + s.unallocated, s.cents, "slices reconcile");
    }
}

// ── overpayment surfaces as unallocated, not misassigned ──────────────────────
{
    const shares = [{ id: "e1", note: "Costco", date: "2026-01-01", cents: 500 }];
    const settlements = [{ date: "2026-01-02", cents: 800 }];
    assert.equal(allocate(shares, settlements), 0, "nothing still owed");
    assert.deepEqual(settlements[0].slices, [{ expenseId: "e1", note: "Costco", cents: 500 }]);
    assert.equal(settlements[0].unallocated, 300, "overpayment is unallocated, not forced onto e1");
}

// ── normalizeSettlement direction & p2p id extraction ─────────────────────────
{
    const ME = "me";
    const incoming = normalizeSettlement(
        { type: "venmoP2pSettlement", id: "p2p-999", transactionDate: "2026-01-01T00:00:00Z",
          amount: { value: 12.34 }, activityUser: { id: "them" }, involvedUser: { id: ME } }, ME);
    assert.equal(incoming.direction, "in");
    assert.equal(incoming.counterparty, "them");
    assert.equal(incoming.importedId, "venmo-999");
    assert.equal(incoming.cents, 1234);

    const outgoing = normalizeSettlement(
        { type: "venmoP2pSettlement", id: "p2p-1", transactionDate: "2026-01-01T00:00:00Z",
          amount: { value: 5 }, activityUser: { id: ME }, involvedUser: { id: "them" } }, ME);
    assert.equal(outgoing.direction, "out");

    assert.equal(normalizeSettlement({ type: "expenseAdded" }, ME), null, "non-settlement ignored");
}

// ── buildGroupSplits: both directions, signed, reconciling ────────────────────
{
    const ME = "me";
    const expenses = [
        // I fronted; they owe 700 -> incoming side.
        { id: "e1", note: "Costco", createdAt: "2026-01-01T00:00:00Z",
          distribution: [
            { user: { id: ME }, paid: { value: 20 }, owed: { value: 13 } },
            { user: { id: "them" }, paid: { value: 0 }, owed: { value: 7 } },
          ] },
        // They fronted; I owe 4 -> outgoing side.
        { id: "e2", note: "Pizza", createdAt: "2026-01-03T00:00:00Z",
          distribution: [
            { user: { id: ME }, paid: { value: 0 }, owed: { value: 4 } },
            { user: { id: "them" }, paid: { value: 10 }, owed: { value: 6 } },
          ] },
    ];
    const activities = [
        { type: "venmoP2pSettlement", id: "p2p-in", transactionDate: "2026-01-02T00:00:00Z",
          amount: { value: 7 }, activityUser: { id: "them" }, involvedUser: { id: ME } },
        { type: "venmoP2pSettlement", id: "p2p-out", transactionDate: "2026-01-04T00:00:00Z",
          amount: { value: 4 }, activityUser: { id: ME }, involvedUser: { id: "them" } },
    ];

    const splits = buildGroupSplits(expenses, activities, ME);
    const byId = Object.fromEntries(splits.map((s) => [s.importedId, s]));

    const incoming = byId["venmo-in"];
    assert.equal(incoming.direction, "in");
    assert.equal(incoming.amountCents, 700, "money in is positive");
    assert.deepEqual(incoming.subtransactions, [{ expenseId: "e1", note: "Costco", amountCents: 700 }]);

    const outgoing = byId["venmo-out"];
    assert.equal(outgoing.direction, "out");
    assert.equal(outgoing.amountCents, -400, "money out is negative");
    assert.deepEqual(outgoing.subtransactions, [{ expenseId: "e2", note: "Pizza", amountCents: -400 }]);

    // Invariant: subtransactions + unallocated == parent, per split.
    for (const s of splits) {
        const sub = s.subtransactions.reduce((a, x) => a + x.amountCents, 0);
        assert.equal(sub + s.unallocatedCents, s.amountCents, `${s.importedId} reconciles`);
    }
}

// ── pooled allocation: a payment covers expenses across the pool, not just the
//    payer's own portion, oldest expense first ──────────────────────────────
{
    const ME = "me";
    const expense = (id, note, date, paid, owed) => ({
        id, note, createdAt: date,
        distribution: [{ user: { id: ME }, paid: { value: paid }, owed: { value: owed } }],
    });
    const settle = (pid, date, amt) => ({
        type: "venmoP2pSettlement", id: `p2p-${pid}`, transactionDate: date,
        amount: { value: amt }, activityUser: { id: "someone" }, involvedUser: { id: ME },
    });
    const expenses = [
        expense("e1", "Costco", "2026-01-01T00:00:00Z", 100, 40), // net +60 due to me
        expense("e2", "Pizza",  "2026-01-05T00:00:00Z", 50, 20),  // net +30 due to me
    ];
    const activities = [
        settle("A", "2026-01-02T00:00:00Z", 70), // pays e1 fully (60) + part of e2 (10)
        settle("B", "2026-01-06T00:00:00Z", 20), // pays rest of e2 (20)
    ];
    const byId = Object.fromEntries(buildGroupSplits(expenses, activities, ME).map((s) => [s.importedId, s]));

    assert.deepEqual(byId["venmo-A"].subtransactions, [
        { expenseId: "e1", note: "Costco", amountCents: 6000 },
        { expenseId: "e2", note: "Pizza", amountCents: 1000 },
    ], "one settlement spans both expenses, oldest first");
    assert.equal(byId["venmo-A"].unallocatedCents, 0);
    assert.deepEqual(byId["venmo-B"].subtransactions, [
        { expenseId: "e2", note: "Pizza", amountCents: 2000 },
    ], "later settlement finishes the remaining expense");
}

// ── startDate filter: expenses and settlements before it are ignored ──────────
{
    const ME = "me";
    const expenses = [
        { id: "old", note: "2024 thing", createdAt: "2024-06-01T00:00:00Z",
          distribution: [{ user: { id: ME }, paid: { value: 100 }, owed: { value: 50 } }] },
        { id: "new", note: "2026 thing", createdAt: "2026-02-01T00:00:00Z",
          distribution: [{ user: { id: ME }, paid: { value: 100 }, owed: { value: 50 } }] },
    ];
    const activities = [
        { type: "venmoP2pSettlement", id: "p2p-old", transactionDate: "2024-06-02T00:00:00Z",
          amount: { value: 50 }, activityUser: { id: "x" }, involvedUser: { id: ME } },
        { type: "venmoP2pSettlement", id: "p2p-new", transactionDate: "2026-02-02T00:00:00Z",
          amount: { value: 50 }, activityUser: { id: "x" }, involvedUser: { id: ME } },
    ];
    const splits = buildGroupSplits(expenses, activities, ME, "2026-01-01");
    assert.equal(splits.length, 1, "only the post-cutoff settlement survives");
    assert.equal(splits[0].importedId, "venmo-new");
    assert.deepEqual(splits[0].subtransactions, [{ expenseId: "new", note: "2026 thing", amountCents: 5000 }]);
}

console.log("venmoGroups: all assertions passed");
