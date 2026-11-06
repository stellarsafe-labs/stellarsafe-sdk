---
"@stellarsafe/sdk": minor
---

Read treasury token balances. `TreasuryClient.getBalances()` returns `{ token, balance }` for every distinct token in the policy's `allowedTokens` and `departmentLimits` (or for the tokens you pass), read in parallel by simulating `balance()` on each token contract. A token whose call fails is reported with an `error` instead of failing the whole read. `TreasurySnapshot` (from `getSnapshot()` / `client.getTreasury()`) gains a `balances` field.
