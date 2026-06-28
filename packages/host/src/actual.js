import { spawn } from "child_process";

// Commands the worker implements; each request spawns a fresh worker so the
// Actual API never shares state across requests.
export const COMMANDS = new Set([
  "testConnection",
  "getAccounts",
  "getAccountBalance",
  "importTransactions",
  "getCategories",
  "createCategory",
  "getLatestTransactionDate",
  "getTransactionCount",
  "getTransactions",
  "deleteAllTransactions",
  "deleteTransactionsFrom",
  "updateTransactionCategory",
]);

export async function runCommand(settings, command, args) {
  return runScript(settings, command, args);
}

export async function closeActual() {}

function runScript(settings, command, args) {
  return new Promise((resolve, reject) => {
    const scriptPath = new URL("../actual-worker.js", import.meta.url).pathname.replace(/^\//, "");
    const input = JSON.stringify({ settings, command, ...args });

    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      // The worker tags its JSON result line with this marker; loot-core's own
      // logging shares stdout, so we find the marked line rather than trust
      // position. (The worker also routes its console output to stderr.)
      const marker = "__ACTUAL_WORKER_RESULT__";
      const line = stdout.split("\n").reverse().find((l) => l.startsWith(marker));
      if (line) {
        try {
          const result = JSON.parse(line.slice(marker.length));
          if (result.error) reject(new Error(result.error));
          else resolve(result.result);
          return;
        } catch {}
      }
      reject(new Error("Worker output parse failed (code " + code + "): " + (stderr || stdout)));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
