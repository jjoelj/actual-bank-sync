# Sure split transactions — reverse-engineering notes

Sure's public API (`/api/v1`, `X-Api-Key`) can't create split transactions —
there's no create/update transaction endpoint at all, let alone splits. Splitting
is a **web-app** action behind the user's cookie session and Rails CSRF.
Recovered from a captured browser request plus the upstream source
(`we-promise/sure`).

**It must run same-origin.** Sure's session cookie is `SameSite=Lax`, so a
cross-site `fetch` from the extension's background service worker doesn't carry
it — Rails then rejects the POST with a **422** (CSRF: `ApplicationController <
ActionController::Base` ⇒ `protect_from_forgery with: :exception`). Every
*logical* failure in `SplitsController` is a 302 redirect instead, so a 422 is a
reliable "CSRF/not-authenticated" signal. The extension therefore runs the split
fetches inside a Sure page via `executeScript` (reusing an open Sure tab, else a
transient background one), where the cookie and the page's CSRF token are valid —
the same approach `venmo.js` uses for the Venmo tab. `executeSplitsInSureTab` in
`sure.js`.

## Endpoint

Singular nested resource (`config/routes.rb`: `resource :split`):

| Method | Path | Action |
|---|---|---|
| POST | `/transactions/:entryId/split` | create (only if not already split) |
| PATCH | `/transactions/:entryId/split` | update — `unsplit! + split!` (replace) |
| DELETE | `/transactions/:entryId/split` | destroy — un-split |

`:entryId` is the **Entry id** (`SplitsController#set_entry` does
`Current.accessible_entries.find(params[:transaction_id])`).

**The id trap:** `/api/v1/transactions` returns `transaction.id` — the
**Transaction (entryable) id**, *not* the Entry id (`family.transactions.joins(:entry)`,
`json.id transaction.id`). Posting the API id to the split route 404s. The API
exposes no entry id, so we recover it from the account's activity HTML, which we
can fetch same-origin from the Sure tab: each row renders
`<turbo-frame id="entry_<E>">` wrapping `<turbo-frame id="transaction_<T>">`, so
scanning `/accounts/:id?tab=activity&page=N` in source order maps transaction id
`T` → entry id `E`. (The selection checkbox id is `selection_entry_…`, which the
`entry_<uuid>` / `transaction_<uuid>` pattern deliberately doesn't match.)

## Request

- Cookie session (`credentials: "include"`) + CSRF. The token from the app
  shell's `<meta name="csrf-token">` authorizes both the `X-CSRF-Token` header
  and the form's `authenticity_token` field.
- `Content-Type: application/x-www-form-urlencoded`.
- Body:
  ```
  authenticity_token=<csrf>
  split[splits][0][name]=<string>
  split[splits][0][amount]=<signed dollars>
  split[splits][0][category_id]=<uuid or empty>
  split[splits][1][...]
  ```

## Sign convention (the gotcha)

The controller does `amount: s[:amount].to_d * -1` — it **negates** what you
send. The form uses the app's inflows-positive convention (the same one the CSV
import declares): **outflows negative, inflows positive**. So a debit's children
are submitted negative; an income transaction's children are submitted positive.
Child amounts must sum to the parent. In this repo that's just
`amountCents / 100` with its sign preserved (incoming reimbursements are
positive, outgoing settlements negative).

## Idempotency

`/api/v1` exposes no split flag (`_transaction.json.jbuilder` has `id`, `date`,
`signed_amount_cents`, `name`, `category`, `external_id`, `classification` — no
parent/child marker), and the web endpoints return redirects with a flash
notice/alert (both success and failure are 302s), so there's no clean success
signal to read. The extension therefore:

- **Matches** a settlement to its Sure entry by `signed_amount_cents` + date
  (±1 day, since the statement CSV's local date can differ from the settlement's
  UTC date). CSV imports set no `external_id`, so there's no exact key like
  Actual's `imported_id`. Ambiguous matches (same amount + day) are skipped.
- **Tracks** what it has split in `venmoSureSplitState` (entryId -> content
  hash): POST a new split, PATCH a changed one, skip an unchanged one. This
  keeps it content-idempotent without reading Sure's split state. See
  `applySureSplits` in `packages/extension/src/banks/venmoGroups.js` and
  `executeSplitsInSureTab` in `sure.js`.
