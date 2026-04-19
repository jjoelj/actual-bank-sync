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
            result = accounts.map((a) => ({id: a.id, name: a.name}));
        } else if (command === "importTransactions") {
            const added = [], updated = [];
            for (const tx of rest.transactions) {
                const r = await actual.importTransactions(rest.accountId, [tx], {
                    defaultCleared: true,
                    reimportDeleted: true,
                });
                if (r?.added) added.push(...r.added);
                if (r?.updated) updated.push(...r.updated);
            }
            result = { added, updated };
        }
    }

    await actual.shutdown();
    process.stdout.write(JSON.stringify({ result }));
} catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message || JSON.stringify(err) }));
}
