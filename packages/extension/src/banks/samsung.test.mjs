// Run: node src/banks/samsung.test.mjs
import assert from "node:assert";
import { parseSamsungTransactions, parseMoney } from "./samsung.js";

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
