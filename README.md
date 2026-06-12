# actual-bank-sync

Automatically syncs bank transactions to [Actual Budget](https://actualbudget.org) and/or [Sure](https://github.com/we-promise/sure) via a Chrome/Edge extension + native messaging host.

Each bank account can be mapped independently to a Sure account, an Actual account, or both — one bank scrape feeds both imports. Actual is reached through the native messaging host (`@actual-app/api`); Sure is reached directly over its REST API.

## Supported Banks

These are the specific cards/accounts this has been tested with. Similar accounts at the same institutions may work, but are untested.

| Institution | Account |
|---|---|
| SoFi | Checking, Savings, Credit Card |
| Wells Fargo | Credit Cards |
| Capital One | Credit Cards |
| Fidelity | Rewards Visa |
| US Bank | Credit Cards |
| BILT | BILT Mastercard |
| Target | Circle Card |
| Venmo | Venmo Cash, Venmo Credit Card |

## Requirements

- Chrome or Edge
- [Node.js](https://nodejs.org)
- A running [Actual Budget](https://actualbudget.org) server and/or a running [Sure](https://github.com/we-promise/sure) instance (at least one)

Steps 1, 3, and the Actual part of step 4 are only needed if you sync to Actual.

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

### 4. Connect your budget app(s)

Click the extension icon to open settings. Configure either app, or both:

**Sure**

- **Sure URL** — e.g. `https://sure.example.com`
- **API Key** — created in Sure under Settings → API Keys

Click **Connect**. The first time, approve the host-permission prompt for your
Sure origin, then click Connect again.

**Actual Budget**

- **Server URL** — e.g. `http://localhost:5006`
- **Password** — your Actual server password

Click **Connect**, then enter your:

- **Sync ID** — found in Actual → Settings → Sync
- **File Password** — only if your budget file is encrypted

Click **Save Settings**.

### 5. Add accounts

Click **+ Add account**, select a bank, and map it to the corresponding account in Sure, Actual, or both (each row has one dropdown per app). Repeat for each account you want to sync.

Set a **start date** for any accounts that haven't been synced before.

### 6. Sync

Click **Sync Now** to run immediately, or let it run automatically once per day when Chrome is open.

## SoFi internal transfers (required rule setup)

SoFi posts both sides of an internal transfer (e.g. Checking → Vault) instantly:
a "To <account>" outflow and a "From <account>" inflow. Importing both raw rows
and relying on the budget app's auto-matching proved unreliable, so the sync
handles transfers deterministically instead:

- When a "From …" row has a matching "To …" row in a *different* synced SoFi
  account (same date, opposite amount), the "From …" side is **dropped**.
- The "To …" side is imported first, and a **rule you create in the budget app**
  must convert it into a transfer — that's what creates the counterpart in the
  destination account.

This means: **without the rules, the destination account never receives the
inflow.** Create one rule per SoFi account that can receive transfers. Example
(Sure, but the same structure works in Actual):

> **Rule: "To Real Savings Vault"**
> - IF transaction name equals `To Real Savings Vault`
> - AND transaction account is any of: `SoFi Checking`, `SoFi Savings`,
>   `SoFi Emergency Fund Vault` (every other SoFi account)
> - THEN **Set as transfer or payment** → `SoFi Real Savings Vault`

A "From …" row with no matching "To …" (e.g. the source account isn't synced)
is kept and imported as a regular inflow.

## How it works

1. A weekly alarm fires when Chrome starts (or run **Sync Now** manually)
2. For each mapped account, the background script opens the bank's page, waits for it to load, and downloads transactions (from the account's last-transaction watermark to today)
3. Transactions are delivered to every app the account is mapped to:
   - **Actual** — via the native messaging host (a local Node.js process) using `@actual-app/api`; deduplicated by `imported_id`, and an account's first sync also imports a synthetic **Starting Balance** transaction so its balance matches the bank
   - **Sure** — via its REST API as a CSV import; deduplicated by date/amount/payee fingerprint, with categories applied per transaction afterward
4. Bank categories you haven't mapped yet hold their transactions back (see the 🏷 view); once mapped, held transactions import automatically. Mappings store category *names*, resolved per app at import time
5. Re-running a sync is safe in both apps

Transaction data is cached locally at:
- **Windows**: `%APPDATA%\actual-bank-sync`
- **Mac**: `~/Library/Application Support/actual-bank-sync`
- **Linux**: `~/.config/actual-bank-sync`

## Notes

- The extension opens bank tabs in the background to fetch transactions. Some banks may require you to be logged in first.
- This uses screen-scraping and CSV exports, not official bank APIs. Banks can change their websites at any time and break things.
- Using automated scripts to access bank accounts may violate your bank's terms of service. Use at your own risk.
