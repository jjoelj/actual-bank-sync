# Venmo mobile/private API — reverse-engineering notes

Everything here was recovered from the Venmo Android app (`com.venmo`,
v26.15.0). None of it is a documented/public API; it can change without notice.
It backs `packages/extension/src/banks/venmo.js` (cash + credit) and
`venmoGroups.js` (group-expense splits).

## How to re-derive it from the APK

No decompiler needed — the endpoint strings and GraphQL documents live in the
dex string pool as plain ASCII. `apktool`/`jadx` are the slow wrong tools here.

1. Download the split bundle (`.apkm`/`.apks`/`.xapk`) from APKMirror. It's a
   zip. Extract it, then extract `base.apk` (also a zip). The dex files are
   `classes*.dex` at the root of `base.apk`.
2. Scan each dex for ASCII runs. Two gotchas:
   - Dex strings are NUL-terminated, so **allow `\n`/`\t` inside a run**
     (`[\x20-\x7e\n\t]{8,}`) or multi-line GraphQL documents get shredded into
     useless fragments.
   - A length prefix glues a stray byte onto the front of each string, so
     **never anchor a search with `^`** (e.g. `credit-card/transactions` shows
     up as `)credit-card/transactions`).
3. Grep the dump. REST paths are stored **relative** (the literal is
   `credit-card/transactions`, not the full URL). GraphQL query documents appear
   verbatim (`query get_group_expenses(...) { ... }`).

The scratch scripts used for this pass (`strings.py`, `gql.py`) are throwaway;
the method above reproduces them in a few lines.

## Two API surfaces

| | Base | Notes |
|---|---|---|
| REST | `https://api.venmo.com/v1/` | Paths stored relative in the dex. |
| GraphQL | `https://api.venmo.com/graphql/` | Venmo's "orchestration layer" — hence the `OL*` type names (`OLRequest`, `OLPaginatedDto`). Body: `{query, variables}`. |

QA/dev hosts also appear in strings (`api.qa.venmo.com`, `api.dev.venmo.com`);
production is `api.venmo.com`.

## Auth

A single bearer token authorizes both surfaces. The extension steals it from the
web app by monkey-patching `window.fetch` in the MAIN world on
`account.venmo.com` and grabbing the first `Authorization: Bearer …` header
(`venmo.js` → `pollForVenmoData`). The same token works for `/v1/*`,
`/graphql/`, and the credit-card endpoints. No separate login per surface.

## REST endpoints in use

- `GET /v1/account` → `data.user.id`, `data.user.username`. This is how we learn
  **our own** Venmo user id; the groups-context GraphQL `Profile` type doesn't
  expose it, and the id here matches the ids in group `distribution`.
- `GET /v1/payments/{id}` → a single P2P payment (`id`, `amount`, `note`,
  `date_created`, `target.user`, `status`). Used to confirm that a group
  settlement's `p2p-<id>` is a real payment id (see Groups below).
- `GET /v1/credit-card/account-summary` → `data.balance` (Venmo Credit balance).
- `GET /v1/credit-card/transactions?page_number=N[&ledger_page_token=…]` →
  paginated credit-card transactions (`id`, `amount`, `created_at`, `status`,
  `merchant.name`, `merchant.category.name`). Paginate via
  `pagination.next_ledger_page_token`.
- `GET /api/statement/download?startDate&endDate&csv=true&profileId&accountType=personal`
  (host `account.venmo.com`, cookie auth) → the cash-account statement CSV. For
  large ranges Venmo builds it asynchronously and returns an **empty body** until
  ready, so poll until non-empty. The CSV's transaction id column is the Venmo
  payment id — the same id used everywhere below.

Other credit-card paths seen in the dex but not used:
`credit-card/transactions/{transaction_id}`,
`credit-card/transactions/{transaction_id}/stories`,
`credit-card/transactions/filters`.

## Groups (GraphQL)

Package `com.venmo.android.groups.service`. Relay-style pagination
(`edges`/`node`/`pageInfo`, `OLPaginated*`). All read queries below are lifted
verbatim from the app.

### Input types

Discovered by triggering the server's own validation errors, which leak the SDL:

- `GetGroupInput { groupId: ID! }`
- `GetGroupExpensesInput { groupId: ID!, pagination: PaginatedInput }`
- `GetGroupExpenseInput { groupId, expenseId, … }`
- `PaginatedInput { first: Int, after: String, … }`

### `get_personal_profile` — list your groups (no input)

```graphql
query { profile { ... on Profile {
  groupsSummary { groupsCount reducedGroups { id name banner } } } } }
```

### `get_group_expenses` — expenses + who paid/owes

```graphql
query($input: GetGroupExpensesInput!){
  getGroupExpenses(input: $input) { ... on GroupExpensesPage {
    pageInfo { startCursor endCursor hasNextPage hasPreviousPage }
    edges { node {
      id groupId note amount { value } createdAt createdByUserId
      createdByUser { id handle firstName lastName displayName avatar { url } }
      distribution {
        user { id handle firstName lastName displayName avatar { url } }
        paid { value }
        owed { value }
      }
    } } } }
}
```

`distribution` is the money shot: per member, `paid` (what they fronted on this
expense) and `owed` (their share). Your true cost of an expense is your own
`owed`; `paid - owed` for your entry is what others reimburse you.

### `get_group_activities` — the feed, incl. settlements

```graphql
query($input: GetGroupInput!, $feedInput: PaginatedInput!){
  getGroup(input: $input) { ... on Group { id name activities(input: $feedInput) {
    pageInfo { startCursor endCursor hasNextPage hasPreviousPage }
    edges { node {
      id createdAt type operationId note transactionDate amount { value }
      activityUser { id firstName avatar { url } }
      involvedUser { id firstName avatar { url } }
    } } } } }
}
```

Activity `type` values seen: `expenseAdded`, `expenseEdited`, `memberJoined`,
`venmoP2pSettlement`.

### The linchpin: settlement → real transaction

A **`venmoP2pSettlement`** activity has `id` = `p2p-<venmoPaymentId>`. The part
after `p2p-` is a real Venmo payment id (confirmed via `GET /v1/payments/{id}`),
which is exactly the id the statement CSV imports as `venmo-<id>`. So every group
settlement maps **directly** onto the transaction already in Actual — no fuzzy
date/amount matching.

`activityUser` = who paid, `involvedUser` = the other party. Incoming (someone
paying you) has `involvedUser = you`; outgoing has `activityUser = you`.

Caveat: settling a group debt **manually** (a "Payment" expense entry with
`paid = 0`) is *not* a P2P transaction, so it has no imported transaction to
split. Only real Venmo P2P settlements do.

### Why allocation is needed

A settlement pays down a member's **net balance**, not a specific expense —
Venmo doesn't record which expense a payment cleared, and group debt
simplification means the member who sends a payment is effectively a router (they
may be covering someone else's portion). So we FIFO-allocate settlements across
expenses, oldest first, and carry each expense's category onto the slice.

Allocation is **pooled per direction**, not per person (`venmoGroups.js` →
`buildGroupSplits`). Your net position on an expense is `paid - owed`: positive
means others owe you that much (an incoming settlement pays it back), negative
means you owe it (an outgoing settlement pays it). All incoming settlements draw
from the single pool of what you're owed; all outgoing from what you owe. Slices
sum back to each settlement exactly; only a genuine overpayment across the whole
relationship leaves an unallocated remainder. Pooling (vs. matching each payment
to its sender's own share) maximizes correct categorization and reflects that the
sender identity isn't meaningful once Venmo has simplified the debts.

Only expenses/settlements at or after the caller's sync-from date are considered
— their transactions are the ones imported into the app, and pre-window expenses
aren't tracked so a payment toward one correctly falls out as unallocated.

### Other group operations in the dex (not used)

Reads: `get_group`, `get_expense`, `get_link_group_with_state`. Mutations:
`create_group`, `update_group`, `delete_group`, `create_group_expense`,
`update_group_expense`, `delete_group_expense`, `add_group_members`,
`remove_group_member`, `add_group_settlement`, `create_group` invite-link and
join-request flows. Full list under
`com.venmo.android.groups.service.declarations.*`.

## How the extension uses this

`venmoGroups.js` fetches groups + expenses + activities, builds one split
descriptor per settlement (`buildGroupSplits`), and hands them to the host
worker's `applyActualSplits` command, which converts the flat `venmo-<id>`
transaction into an Actual split whose children carry each expense's amount and
category. See `allocate`/`buildGroupSplits` and their test `venmoGroups.test.mjs`
for the reconciliation invariant.

Categories are chosen per expense in the popup's Categories view. The sync caches
the expense list (`venmoGroupExpenses`) and the raw splits (`venmoGroupSplits`),
so assigning a category writes `venmoExpenseCategories[expenseId]` and re-applies
the splits (`applyVenmoGroupCategories` -> `applyActualSplits`) without another
Venmo fetch. `applyActualSplits` is content-idempotent: a settlement whose split
already matches is skipped; a changed breakdown or category is re-split.

**Sure:** splits go through Sure's web (Hotwire) split endpoint, not `/api/v1`
(which has no split-create). See [sure-splits.md](sure-splits.md).
