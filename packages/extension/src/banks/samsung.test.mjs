// Run: node src/banks/samsung.test.mjs
import assert from "node:assert";
import { parseSamsungTransactions, parseMoney, samsungCycleDates } from "./samsung.js";

const tx = (id, type, value, date, merchant) => ({
    id,
    attributes: { transactionType: type, amount: { value }, transactionDate: date, merchantInfo: merchant ? { merchantName: merchant, merchantCategoryType: "RESTAURANTS_AND_ENTERTAINMENT" } : undefined, description: "DESC" },
});

const rows = parseSamsungTransactions([
    tx("a", "PURCHASE", 14.39, "2026-07-26", "OTTER"),
    tx("b", "PAYMENT", 50, "2026-07-25"),
    tx("c", "PURCHASE", 9.99, "2026-07-01"),   // before startDate → dropped
    tx("d", "PURCHASE", 0, "2026-07-26"),      // zero amount → dropped
], "2026-07-10");

assert.equal(rows.length, 2, "startDate + zero filters");
assert.equal(rows[0].amount, -1439, "purchase is an outflow");
assert.equal(rows[0].payee_name, "OTTER");
assert.equal(rows[0].imported_id, "samsung-a");
assert.equal(rows[0].category, "RESTAURANTS_AND_ENTERTAINMENT");
assert.equal(rows[1].amount, 5000, "payment is an inflow");
assert.equal(rows[1].category, undefined, "no merchant → no category");

assert.equal(parseMoney("$30.66"), 3066);
assert.equal(parseMoney("$1,234.50"), 123450);
assert.equal(parseMoney(null), null);

console.log("samsung parse: OK");

// Statement cycles (closes on the 11th): the window must reach back into every
// cycle it overlaps, or a charge from just before a close is never fetched.
assert.deepEqual(samsungCycleDates("2026-10-08", "2026-10-15"), ["9999-12-31", "2026-10-11"], "window spans the Oct 11 close");
assert.deepEqual(samsungCycleDates("2026-10-12", "2026-10-15"), ["9999-12-31"], "window after the close: current cycle only");
assert.deepEqual(samsungCycleDates("2026-10-11", "2026-10-15"), ["9999-12-31", "2026-10-11"], "closing day itself belongs to the closed cycle");
assert.deepEqual(samsungCycleDates("2025-12-20", "2026-02-05"), ["9999-12-31", "2026-01-11"], "year wrap; Dec 11 close predates the window");
assert.deepEqual(samsungCycleDates("2025-12-05", "2026-01-05"), ["9999-12-31", "2025-12-11"], "today before this month's close");
console.log("samsungCycleDates: OK");
