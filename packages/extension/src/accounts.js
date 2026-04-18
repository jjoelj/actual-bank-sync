// Central registry of account types.
// To add a card from an existing bank: add one entry. The key is also the storage/sync key.
// To add a new bank: add entries here + a new sync function + wire it up in background.js.
//
// Banks with multiple accounts per sync session (sofi, venmo) are handled specially in
// background.js and don't follow the per-key dispatch pattern.

export const ACCOUNT_TYPES = {
  "sofi-banking":      { label: "SoFi Banking",         bank: "sofi" },
  "sofi-credit":       { label: "SoFi Credit Card",      bank: "sofi" },
  "bilt-credit":       { label: "Bilt Blue Card",         bank: "bilt" },
  "venmo-cash":        { label: "Venmo Cash",            bank: "venmo" },
  "venmo-credit":      { label: "Venmo Credit Card",     bank: "venmo" },
  "capitalone-credit": { label: "Capital One Savor",     bank: "capitalone" },
  "fidelity-credit":   { label: "Fidelity Rewards Visa", bank: "fidelity" },
  "target-credit":     { label: "Target Circle Card",    bank: "target" },
  "wf-credit":         { label: "Wells Fargo Autograph", bank: "wf" },
};
