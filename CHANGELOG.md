# @stellarsafe/sdk

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
