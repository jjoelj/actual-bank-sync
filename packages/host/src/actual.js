import { spawn } from "child_process";

export async function getAccounts(settings) {
  return runScript(settings, "getAccounts", {});
}

export async function importTransactions(settings, accountId, transactions) {
  return runScript(settings, "importTransactions", { accountId, transactions });
}

export async function testConnection(settings) {
  return runScript(settings, "testConnection", {});
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
