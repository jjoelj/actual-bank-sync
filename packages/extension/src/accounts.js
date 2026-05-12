// Central registry of account types.
// To add a card from an existing bank: add one entry. The key is also the storage/sync key.
// To add a new bank: add entries here + a new sync function + wire it up in background.js.
//
// Banks with multiple accounts per sync session (sofi, venmo) are handled specially in
// background.js and don't follow the per-key dispatch pattern.

export const BANK_LABELS = {
  sofi:        "SoFi",
  bilt:        "Bilt",
  venmo:       "Venmo",
  capitalone:  "Capital One",
  fidelity:    "Fidelity",
  target:      "Target",
  usbank:      "US Bank",
  wf:          "Wells Fargo",
};

export const ACCOUNT_TYPES = {
  "sofi-banking":        { label: "Banking",       bank: "sofi" },
  "sofi-credit":         { label: "Credit Card",   bank: "sofi",       optional: true },
  "bilt-credit":         { label: "Blue Card",     bank: "bilt" },
  "venmo-cash":          { label: "Cash",          bank: "venmo" },
  "venmo-credit":        { label: "Credit Card",   bank: "venmo",      optional: true },
  "capitalone-cards":    { label: "Cards",         bank: "capitalone" },
  "fidelity-credit":   { label: "Rewards Visa",  bank: "fidelity" },
  "target-credit":     { label: "Circle Card",   bank: "target" },
  "usbank-cards":      { label: "Cards",         bank: "usbank" },
  "wf-cards":          { label: "Cards",         bank: "wf" },
};
