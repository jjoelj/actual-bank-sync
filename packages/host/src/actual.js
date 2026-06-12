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
  "deleteAllTransactions",
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
      try {
        const lastLine = stdout.trim().split("\n").pop();
        const result = JSON.parse(lastLine);
        if (result.error) reject(new Error(result.error));
        else resolve(result.result);
      } catch {
        reject(new Error("Worker output parse failed: " + stdout));
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
