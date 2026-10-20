import { execFile, spawn } from "child_process";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { promisify } from "util";

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
  "applyActualSplits",
]);

export async function runCommand(settings, command, args, onProgress) {
  await matchServerVersion(settings.actualUrl, onProgress);
  return runScript(settings, command, args);
}

// The api must match the server: an older api can't open a budget carrying
// newer db migrations. Every command is its own host process and worker, so
// this runs per command and an install takes effect on this very command.
// Failures fall through to the installed version.
async function matchServerVersion(url, onProgress) {
  if (!url) return;
  try {
    const res = await fetch(new URL("info", url.replace(/\/?$/, "/")), { signal: AbortSignal.timeout(5000) });
    const want = (await res.json())?.build?.version;
    // The version comes from the network and npm on Windows needs a shell, so
    // only a bare x.y.z ever reaches the command line.
    if (!/^\d+\.\d+\.\d+$/.test(want ?? "")) throw new Error(`unexpected server version ${JSON.stringify(want)}`);
    if (want !== installedApiVersion()) {
      onProgress?.(`Updating Actual API to ${want}…`);
      const root = new URL("../../..", import.meta.url).pathname.replace(/^\//, "");
      await promisify(execFile)("npm", ["install", `@actual-app/api@${want}`, "-w", "actual-bank-sync-host", "--save-exact"],
        { cwd: root, shell: true, timeout: 300000 });
    }
  } catch (err) {
    console.error("Could not match @actual-app/api to server version:", err?.message ?? err);
  }
}

// The api's exports map hides its package.json; step up out of dist/.
function installedApiVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve("@actual-app/api");
    return JSON.parse(readFileSync(join(entry, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
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
