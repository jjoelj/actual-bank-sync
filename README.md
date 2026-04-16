# actual-bank-sync

Automatically syncs bank transactions to [Actual Budget](https://actualbudget.org) via a Chrome/Edge extension + native messaging host.

## Supported Banks

These are the specific cards/accounts this has been tested with. Similar accounts at the same institutions may work, but are untested.

| Institution | Account |
|---|---|
| SoFi | Checking, Savings, Credit Card |
| Wells Fargo | Autograph Card |
| Capital One | Savor Card |
| Fidelity | Visa Signature Card |
| BILT | BILT Mastercard |
| Target | Circle Card |
| Venmo | Venmo Cash |

## Requirements

- Chrome or Edge
- [Node.js](https://nodejs.org)
- A running [Actual Budget](https://actualbudget.org) server

## Setup

### 1. Install host dependencies

```bash
npm install
```

### 2. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `packages/extension`
4. Copy the **Extension ID** shown on the card

### 3. Register the native messaging host

Copy the config template and fill in your extension ID:

```bash
cp packages/host/config.example.json packages/host/config.json
```

Edit `packages/host/config.json`:

```json
{
  "extensionId": "your-extension-id-here"
}
```

Then run:

```bash
cd packages/host
node src/install.js
```

This registers the host with Chrome/Edge so the extension can communicate with Node.js locally.

### 4. Connect to Actual

Click the extension icon and enter your Actual Budget settings:

- **Server URL** — e.g. `http://localhost:5006`
- **Password** — your Actual server password

Click **Connect**, then enter your:

- **Sync ID** — found in Actual → Settings → Sync
- **File Password** — only if your budget file is encrypted

Click **Save Settings**.

### 5. Add accounts

Click **+ Add account**, select a bank, and map it to the corresponding account in Actual. Repeat for each account you want to sync.

Set a **start date** for any accounts that haven't been synced before.

### 6. Sync

Click **Sync Now** to run immediately, or let it run automatically once per day when Chrome is open.

## How it works

1. A daily alarm fires when Chrome starts
2. For each mapped account, the background script opens the bank's page, waits for it to load, and downloads transactions
3. Transactions are sent to the native messaging host (a local Node.js process)
4. The host uses `@actual-app/api` to import them into Actual Budget
5. Actual deduplicates by `imported_id` — safe to run multiple times

Transaction data is cached locally at:
- **Windows**: `%APPDATA%\actual-bank-sync`
- **Mac**: `~/Library/Application Support/actual-bank-sync`
- **Linux**: `~/.config/actual-bank-sync`

## Notes

- The extension opens bank tabs in the background to fetch transactions. Some banks may require you to be logged in first.
- This uses screen-scraping and CSV exports, not official bank APIs. Banks can change their websites at any time and break things.
- Using automated scripts to access bank accounts may violate your bank's terms of service. Use at your own risk.
