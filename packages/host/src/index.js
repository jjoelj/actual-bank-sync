import { getAccounts, importTransactions, testConnection, closeActual } from "./actual.js";

async function main() {
  process.stdin.resume();

  const msg = await readMessage();
  process.stdin.pause();

  const { id, command, settings, ...rest } = msg;
  let result = null;
  let error = null;

  try {
    if (command === "getAccounts") {
      result = await getAccounts(settings);
    } else if (command === "importTransactions") {
      result = await importTransactions(settings, rest.accountId, rest.transactions);
    } else if (command === "testConnection") {
      result = await testConnection(settings);
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
