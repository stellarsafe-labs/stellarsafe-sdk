# @stellarsafe/sdk

## 0.2.0

### Minor Changes

- 9739b39: Export readable contract error descriptions and a helper to look them up by name or code.
- 550b881: Read treasury token balances. `TreasuryClient.getBalances()` returns `{ token, balance }` for every distinct token in the policy's `allowedTokens` and `departmentLimits` (or for the tokens you pass), read in parallel by simulating `balance()` on each token contract. A token whose call fails is reported with an `error` instead of failing the whole read. `TreasurySnapshot` (from `getSnapshot()` / `client.getTreasury()`) gains a `balances` field.

### Patch Changes

- 1f5c343: Fix stale reads after a confirmed write on load-balanced RPC endpoints. Clients now wait for the RPC to reach the ledger of their last write before reading or simulating, never reuse a sequence number from a lagging node, and accept an explicit `minLedger` read option.

## 0.1.0

Initial release.

- `StellarSafeClient` with network presets (testnet, mainnet, futurenet, local, custom), retries, timeouts and network pinning.
- `TreasuryClient` typed reads: config, policy, members, roles, proposals, spending, snapshots.
- Typed writes for every contract function, returning simulated `PreparedTransaction`s with fee estimates.
- Signed-envelope integrity checks; SEP-43 wallet compatibility; `keypairSigner` and `connect()` for servers.
- Contract event decoding, paginated `getEvents` and resumable `streamEvents`.
- Advisory policy helpers: `checkPayment`, `requiredApprovals`, `getProposalState`, spending periods.
- Exact `parseAmount` / `formatAmount`.
- Typed error hierarchy with contract error code mapping, including errors from transactions that fail on-chain (`TransactionError.contractError`).
- `deployTreasury` and `uploadWasm`: constructor-based deployment (no front-runnable `initialize`).
- Relayed/sponsored fees: `PreparedTransaction.authRequired` and `signAuthEntries()` (SEP-43 `signAuthEntry`).
- `prepareRestore()` for archived contract state.
- Contract conformance tests against the compiled contract spec, and a testnet end-to-end suite.
