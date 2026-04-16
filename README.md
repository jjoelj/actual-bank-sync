# actual-bank-sync

Automatically syncs bank transactions to [Actual Budget](https://actualbudget.org) via a Chrome/Edge extension + native messaging host.

## Structure

```
actual-bank-sync/
  packages/
    extension/          # Chrome MV3 extension (plain JS, no build step)
    host/               # Node.js native messaging host
```

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

Then edit `packages/host/config.json`:

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

This registers the host with Chrome so the extension can talk to it.

### 4. Configure the extension

Click the extension icon → fill in your Actual Budget settings:
- **Server URL**: e.g. `http://localhost:5006`
- **Password**: your Actual server password
- **Budget ID**: found in Actual → Settings → Sync

### 5. Map accounts

Click **Load Bank Accounts** in the popup. This will briefly open a SoFi tab to read your account list, then let you map each SoFi account to an Actual account.

Click **Save Mappings** when done.

### 6. Sync

Click **Sync Now** or wait for the daily automatic sync (triggers when the browser opens each day).

## Supported Banks

- [x] SoFi (checking + savings, CSV export)
- [ ] Wells Fargo (OFX Direct Connect)
- [ ] Fidelity (OFX Direct Connect)
- [ ] Capital One / Savor
- [ ] BILT / Cardless
- [ ] Target Circle
- [ ] Venmo Credit (PDF statements)

## How it works

1. **Daily alarm** fires when Chrome starts
2. Background script opens the bank tab silently, waits for login + data to load
3. Fetches transactions (CSV for SoFi) from last sync date → today
4. Sends transactions to the **native messaging host** (a local Node.js process)
5. Host uses `@actual-app/api` to import into Actual Budget
6. Actual deduplicates via `imported_id` — safe to run multiple times
