import * as actual from "@actual-app/api";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
        await actual.downloadBudget(settings.actualSyncId, {
            password: settings.actualFilePassword,
        });

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
            const groups = await actual.getCategoryGroups();
            const groupName = new Map(groups.map((g) => [g.id, g.name]));
            const cats = await actual.getCategories();
            result = cats.map((c) => ({ id: c.id, name: c.name, parent: groupName.get(c.group_id) ?? null }));
        } else if (command === "createCategory") {
            const groups = await actual.getCategoryGroups();
            let group = groups.find((g) => !g.is_income);
            let group_id = group?.id;
            if (!group_id) group_id = await actual.createCategoryGroup({ name: "Bank Sync" });
            const id = await actual.createCategory({ name: rest.name, group_id });
            result = { id, name: rest.name, parent: group?.name ?? "Bank Sync" };
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
        }
    }

    await actual.shutdown();
    process.stdout.write(JSON.stringify({ result }));
} catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message || JSON.stringify(err) }));
}
