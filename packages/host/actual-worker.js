import * as actual from "@actual-app/api";
import { mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// loot-core logs breadcrumbs and sync chatter via console.* — which defaults to
// stdout, the same channel the parent reads the JSON result from. Route every
// console method to stderr so stdout carries only the marked result line below.
const RESULT_MARKER = "__ACTUAL_WORKER_RESULT__";
const toStderr = console.error.bind(console);
for (const m of ["log", "info", "warn", "debug"]) console[m] = toStderr;

// loot-core runs background full-syncs that can reject after we've already
// awaited what we need. In Node 23 a stray unhandled rejection kills the worker
// (exit 1) before our try/catch can report a result. Swallow them to stderr —
// every operation we depend on is awaited below and surfaces its own error.
process.on("unhandledRejection", (reason) => toStderr("Unhandled rejection (ignored):", reason));

// Last-resort watchdog. If loot-core ever stops resolving (a sqlite open that
// blocks on a budget locked by another worker, a shutdown that never returns),
// this worker would otherwise live forever HOLDING that same budget lock —
// every later worker then hangs or EPERMs on `My-Finances-*`. Force-exit so the
// OS releases the lock and the next worker can proceed.
// ponytail: 120s clears the slowest legit op (first encrypted download); drop it
// if false kills mid-import ever appear, raise it if big downloads time out.
setTimeout(() => {
    toStderr("Worker watchdog fired — exiting to release the budget lock");
    finish({ error: "Actual didn't respond within 120s. Its sync is stuck re-pulling the same messages without converging (a local cache / server sync-state mismatch). Try 'Reset sync' in the Actual server budget's Advanced settings, then retry; or clear the local cache to force a clean re-download." }, 1);
    // If the event loop is jammed and finish() can't flush, still die so the lock frees.
    setTimeout(() => process.exit(1), 2000).unref();
}, 120_000).unref();

const input = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(JSON.parse(data)));
});

const { settings, command, ...rest } = input;

const ALL_TIME = ["1970-01-01", "9999-12-31"];

async function getAllTransactions(accountId) {
    return actual.getTransactions(accountId, ...ALL_TIME);
}

// Banks attach internal bookkeeping fields (fingerprints, skip flags, raw ids)
// that the Actual API must not see; keep only real transaction fields.
const TX_FIELDS = ["date", "amount", "payee_name", "imported_payee", "imported_id", "notes", "category", "cleared", "transfer_id", "subtransactions"];

function sanitizeTransactions(transactions) {
    return transactions.map((tx) =>
        Object.fromEntries(Object.entries(tx).filter(([k, v]) => TX_FIELDS.includes(k) && v !== undefined))
    );
}

// Map mapped category names on incoming transactions to Actual category ids;
// unknown names import uncategorized (rules may still categorize them).
async function resolveCategories(transactions) {
    if (!transactions.some((tx) => tx.category)) return transactions;
    const cats = await actual.getCategories();
    const idByName = new Map(cats.map((c) => [c.name, c.id]));
    return transactions.map((tx) => {
        if (!tx.category) return tx;
        const id = idByName.get(tx.category);
        const { category, ...restTx } = tx;
        return id ? { ...restTx, category: id } : restTx;
    });
}

try {
    const dataDir = process.platform === "win32"
        ? join(process.env.APPDATA, "actual-bank-sync")
        : process.platform === "darwin"
            ? join(homedir(), "Library", "Application Support", "actual-bank-sync")
            : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "actual-bank-sync");
    mkdirSync(dataDir, { recursive: true });

    let result;
    await actual.init({
        serverURL: settings.actualUrl,
        password: settings.actualPassword,
        dataDir,
    });
    if (command === "testConnection") {
        result = {ok: true};
    } else {
        const dlOpts = { password: settings.actualFilePassword || undefined };
        try {
            await actual.downloadBudget(settings.actualSyncId, dlOpts);
        } catch (err) {
            // Recover by releasing the db, wiping the local cache, and
            // re-downloading a clean copy from the server. This applies to
            // loot-core's message-less key-test failures AND to an out-of-sync
            // SyncError (the local cached budget diverged) — both are fixed by
            // discarding the local copy. Anything else is a real error.
            const recoverable = !err?.message || err?.reason === "out-of-sync" || /out-of-sync/i.test(err.message);
            if (!recoverable) throw err;
            await actual.shutdown();
            for (const entry of readdirSync(dataDir)) {
                rmSync(join(dataDir, entry), { recursive: true, force: true });
            }
            await actual.init({ serverURL: settings.actualUrl, password: settings.actualPassword, dataDir });
            try {
                await actual.downloadBudget(settings.actualSyncId, dlOpts);
            } catch (retryErr) {
                if (!retryErr?.message) throw new Error("Could not open budget — sync or decryption failed after cache reset. Check the Sync ID and File Password in settings.");
                throw retryErr;
            }
        }

        if (command === "getAccounts") {
            const accounts = await actual.getAccounts();
            result = [];
            for (const a of accounts.filter((a) => !a.closed)) {
                let balance_cents = null;
                try {
                    balance_cents = await actual.getAccountBalance(a.id);
                } catch {
                    // balance is informational; the account list must not fail
                }
                result.push({ id: a.id, name: a.name, balance_cents });
            }
        } else if (command === "importTransactions") {
            const added = [], updated = [];
            let addedSum = 0;
            const transactions = await resolveCategories(sanitizeTransactions(rest.transactions));
            for (const tx of transactions) {
                const r = await actual.importTransactions(rest.accountId, [tx], {
                    defaultCleared: true,
                    reimportDeleted: true,
                });
                if (r?.added?.length) {
                    added.push(...r.added);
                    addedSum += tx.amount;
                }
                if (r?.updated) updated.push(...r.updated);
            }
            result = { added, updated, addedSum };
        } else if (command === "getAccountBalance") {
            result = await actual.getAccountBalance(rest.accountId);
        } else if (command === "getCategories") {
            // Plain names only — Actual's groups are budgeting structure, not
            // part of the category identity used for mapping.
            const cats = await actual.getCategories();
            result = cats.map((c) => ({ id: c.id, name: c.name, parent: null }));
        } else if (command === "createCategory") {
            const groups = await actual.getCategoryGroups();
            const group = groups.find((g) => !g.is_income);
            let group_id = group?.id;
            if (!group_id) group_id = await actual.createCategoryGroup({ name: "Bank Sync" });
            const id = await actual.createCategory({ name: rest.name, group_id });
            result = { id, name: rest.name, parent: null };
        } else if (command === "getLatestTransactionDate") {
            // Transfers (e.g. card payments) can be dated later than the last
            // real bank transaction, so they're excluded from the watermark.
            const txs = await getAllTransactions(rest.accountId);
            let maxDate = null;
            for (const tx of txs) {
                if (tx.transfer_id) continue;
                if (maxDate == null || tx.date > maxDate) maxDate = tx.date;
            }
            result = maxDate;
        } else if (command === "getTransactions") {
            result = await actual.getTransactions(rest.accountId, rest.startDate, rest.endDate);
        } else if (command === "getTransactionCount") {
            const txs = await getAllTransactions(rest.accountId);
            result = txs.length;
        } else if (command === "deleteAllTransactions") {
            const txs = await getAllTransactions(rest.accountId);
            let deleted = 0;
            for (const tx of txs) {
                await actual.deleteTransaction(tx.id);
                deleted++;
            }
            result = deleted;
        } else if (command === "deleteTransactionsFrom") {
            // Delete transactions dated on or after startDate; used by reconcile
            // to roll an account back before a resync re-pulls the gap. Transfers
            // are skipped — deleting a transfer leg cascades to its counterpart on
            // the paired account, which this account-scoped reset must not touch.
            const txs = await getAllTransactions(rest.accountId);
            let deleted = 0;
            for (const tx of txs) {
                if (tx.date < rest.startDate) continue;
                if (tx.transfer_id) continue;
                await actual.deleteTransaction(tx.id);
                deleted++;
            }
            result = deleted;
        } else if (command === "updateTransactionCategory") {
            // Set (or clear, when categoryName is null) one transaction's
            // category, creating the named category if it doesn't exist yet.
            let categoryId = null;
            if (rest.categoryName) {
                const cats = await actual.getCategories();
                const found = cats.find((c) => c.name === rest.categoryName);
                if (found) {
                    categoryId = found.id;
                } else {
                    const groups = await actual.getCategoryGroups();
                    const group = groups.find((g) => !g.is_income);
                    let group_id = group?.id;
                    if (!group_id) group_id = await actual.createCategoryGroup({ name: "Bank Sync" });
                    categoryId = await actual.createCategory({ name: rest.categoryName, group_id });
                }
            }
            await actual.updateTransaction(rest.transactionId, { category: categoryId });
            result = { ok: true };
        }
    }

    await actual.shutdown();
    finish({ result }, 0);
} catch (err) {
    finish({ error: errorText(err) }, 1);
}

// Write the marked result line, then exit explicitly: loot-core can leave sync
// timers on the event loop that would otherwise keep this short-lived worker
// alive (hanging the parent). The callback guarantees the write is flushed
// before exit so the result line is never truncated.
function finish(payload, code) {
    process.stdout.write(RESULT_MARKER + JSON.stringify(payload) + "\n", () => process.exit(code ?? 0));
}

// loot-core throws a mix of Errors, Error subclasses with extra fields
// (reason/meta), and plain objects — produce something readable for all of them.
function errorText(err) {
    if (typeof err === "string") return err;
    const parts = [];
    if (err?.message) parts.push(err.message);
    if (err?.reason) parts.push(`reason: ${err.reason}`);
    if (err?.type) parts.push(`type: ${err.type}`);
    if (parts.length) return parts.join(" — ");
    try {
        const json = JSON.stringify({ ...err });
        if (json && json !== "{}") return json;
    } catch {}
    return err?.stack?.split("\n")[0] || String(err);
}
