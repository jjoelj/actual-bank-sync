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
| Samsung (Barclays) | Galaxy Card |

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

Click **Sync Now** to run immediately, or let it run automatically once a day while the browser is running.

To keep scheduled syncs running when no browser window is open, turn on
**Continue running background extensions and apps when … is closed**
(`edge://settings/system` or `chrome://settings/system`). In Edge, also turn on
**Startup boost** so it starts in the background when you sign in to Windows.

### 7. Save your bank logins (optional, Windows)

Sign in to each bank once by hand, in any tab. The extension saves that login
and uses it to sign in by itself on later syncs. See [Saved logins](#saved-logins).

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

## Saved logins

When you sign in to a supported bank by hand, the extension saves the username
and password. During a sync, if the bank asks you to sign in, it types them for
you and submits. If that fails, or the bank asks for something it can't do (a
texted code, an email link), the sync window comes up and you finish signing in
yourself; the sync then carries on. Your manual sign-in also updates the saved
login, so a changed password fixes itself.

| Bank | Signs in by itself | Notes |
|---|---|---|
| Samsung (Barclays), Capital One, Fidelity, Target, SoFi, Venmo | Yes | |
| US Bank, Wells Fargo | Yes, up to the texted code | The window comes up at the code screen; you enter the code |
| BILT | No | Signs in by texted code and email link |

How it works:

- **Storage:** logins are encrypted with Windows' DPAPI, tied to your Windows
  account, by the native host. The extension only stores the encrypted blob
  (`savedLogins` in its local storage). Anything running as your Windows user
  can decrypt them, the same as the browser's own saved passwords. Saved logins
  are Windows-only.
- **Typing:** the extension uses the `debugger` permission to send real
  keystrokes, so the bank sees normal typing. While it signs in, the browser
  shows a "started debugging this browser" bar for a few seconds. It checks
  every field before submitting and never submits a mistyped password.
- **Hidden windows:** syncs run in their own minimized window, which only comes
  up when you're needed. Bank pages are told they're visible so they keep
  loading while minimized.

To see which banks have a saved login, or forget one, run this in the
extension's service-worker console (`edge://extensions` → **Inspect views:
service worker**):

```js
Object.keys((await chrome.storage.local.get("savedLogins")).savedLogins || {})

const { savedLogins = {} } = await chrome.storage.local.get("savedLogins");
delete savedLogins.fidelity;   // the bank to forget
await chrome.storage.local.set({ savedLogins });
```

## How it works

1. A daily alarm fires while the browser is running (around noon the day after the last sync), or at its next start if it was missed (or run **Sync Now** manually)
2. For each mapped account, the background script opens the bank's page in a minimized window, signs in with the saved login if needed, and downloads transactions (from the account's last-transaction watermark to today)
3. Transactions are delivered to every app the account is mapped to:
   - **Actual** — via the native messaging host (a local Node.js process) using `@actual-app/api`; deduplicated by `imported_id`, and an account's first sync also imports a synthetic **Starting Balance** transaction so its balance matches the bank
   - **Sure** — via its REST API as a CSV import; deduplicated by date and amount (not payee, since Sure renames merchants after import), with categories applied per transaction afterward
4. Bank categories you haven't mapped yet hold their transactions back (see the 🏷 view); once mapped, held transactions import automatically. Mappings store category *names*, resolved per app at import time
5. Re-running a sync is safe in both apps

Transaction data is cached locally at:
- **Windows**: `%APPDATA%\actual-bank-sync`
- **Mac**: `~/Library/Application Support/actual-bank-sync`
- **Linux**: `~/.config/actual-bank-sync`

## Notes

- The extension opens bank pages in a minimized window to fetch transactions. If a bank needs you (a sign-in it can't complete, a texted code), that window comes up.
- This uses screen-scraping and CSV exports, not official bank APIs. Banks can change their websites at any time and break things.
- Using automated scripts to access bank accounts may violate your bank's terms of service. Use at your own risk.
