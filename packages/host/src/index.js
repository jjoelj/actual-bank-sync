import { execFileSync } from "child_process";
import { COMMANDS, runCommand, closeActual } from "./actual.js";

// Saved bank logins are encrypted with Windows DPAPI (CurrentUser scope): the
// blob lives in extension storage, but only this Windows account can decrypt it.
// Base64 on the wire keeps non-ASCII passwords safe from console code pages, and
// stdin (not argv) keeps them out of process listings.
// Plain .NET (no cmdlets): Windows PowerShell can't autoload its modules when it
// inherits PowerShell 7's PSModulePath.
// ponytail: Windows-only; macOS would need `security add-generic-password`.
function dpapi(method, base64In) {
  if (process.platform !== "win32") throw new Error("Saved logins are only supported on Windows");
  const script = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security');" +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}(` +
    "[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()), $null, 'CurrentUser'))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: base64In, encoding: "utf8", windowsHide: true }).trim();
}

const LOCAL_COMMANDS = {
  protect: ({ text }) => dpapi("Protect", Buffer.from(text, "utf8").toString("base64")),
  unprotect: ({ blob }) => Buffer.from(dpapi("Unprotect", blob), "base64").toString("utf8"),
};

async function main() {
  process.stdin.resume();

  const msg = await readMessage();
  process.stdin.pause();

  const { id, command, settings, ...rest } = msg;
  let result = null;
  let error = null;

  try {
    if (LOCAL_COMMANDS[command]) {
      result = LOCAL_COMMANDS[command](rest);
    } else if (COMMANDS.has(command)) {
      result = await runCommand(settings, command, rest);
    } else {
      error = `Unknown command: ${command}`;
    }
  } catch (err) {
    error = err.message;
  } finally {
    await closeActual();
  }

  writeMessage({ id, result, error });
  process.exit(0);
}

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = null;

    process.stdin.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      if (length === null && buf.length >= 4) {
        length = buf.readUInt32LE(0);
      }

      if (length !== null && buf.length >= 4 + length) {
        try {
          resolve(JSON.parse(buf.slice(4, 4 + length).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      }
    });

    process.stdin.on("error", reject);
  });
}

function writeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

main().catch(() => {
  process.exit(1);
});
