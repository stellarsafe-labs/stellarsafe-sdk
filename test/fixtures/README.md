# Test fixtures

`stellarsafe_treasury.wasm` is the release build of
[`stellarsafe-contracts/contracts/treasury`](https://github.com/stellarsafe-labs/stellarsafe-contracts),
built with `stellar contract build` (stellar-cli 28, soroban-sdk 29.0.1).

It is used by:

- `test/unit/contract-spec.test.ts` — checks the SDK against the interface
  spec embedded in the wasm.
- `test/integration/lifecycle.e2e.test.ts` — deploys it to testnet.

SHA-256: see `stellarsafe_treasury.wasm.sha256`.

To update after a contract change, run from this repository:

```sh
scripts/sync-contract-wasm.sh ../stellarsafe-contracts
```
