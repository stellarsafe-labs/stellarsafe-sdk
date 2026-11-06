# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through
[GitHub Security Advisories](https://github.com/stellarsafe-labs/stellarsafe-sdk/security/advisories/new).
Include steps to reproduce, affected versions and impact. We aim to
acknowledge reports within 3 business days and to agree on a disclosure
timeline with you.

Vulnerabilities in the on-chain contracts belong in
[`stellarsafe-contracts`](https://github.com/stellarsafe-labs/stellarsafe-contracts/security).

## Supported versions

Until 1.0, only the latest minor release receives security fixes.

## Deployment status

The StellarSafe contracts have **not** been audited. Use testnet only. Do not
deposit real assets until an independent security review is published.

## SDK threat model

The SDK runs on the user's side (browser, backend or script). It is **not**
a trust anchor: the treasury contract enforces every rule, and a confirmed
transaction is the only source of truth.

| Threat                                                                           | Mitigation in the SDK                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet or signing service returns a different transaction than the user approved | `PreparedTransaction.sign()` and `submit()` compare the signed envelope's hash with the prepared one and refuse to submit on mismatch.                        |
| RPC endpoint on the wrong network (e.g. mainnet instead of testnet)              | Before the first write, the RPC's network passphrase is compared with the client's configuration (`NETWORK_MISMATCH`).                                        |
| Plain-text RPC traffic tampered in transit                                       | `http://` RPC URLs are rejected unless `allowHttp` is set explicitly.                                                                                         |
| Malicious or buggy RPC returns malformed contract data                           | All contract values are decoded strictly, field by field; mismatches raise `DecodeError` instead of yielding partial objects.                                 |
| Malicious RPC lies about state or simulation results                             | Not preventable client-side. Simulation results are previews; the contract re-checks all rules on execution. Use an RPC provider you trust, or your own node. |
| Floating-point rounding of amounts                                               | Amounts are `bigint`; decimal conversion uses exact string arithmetic and rejects excess precision.                                                           |
| A call silently needs another party's authorization                              | Preparation fails with `AUTH_NOT_SUPPORTED` if simulation records auth from anyone other than the transaction source.                                         |
| Secret key exposure                                                              | The SDK never asks for keys. `keypairSigner` exists for server-side use; browsers should use a wallet.                                                        |
| Local policy checks treated as authoritative                                     | `checkPayment`/`getProposalState` are documented as advisory; writes always simulate on-chain first.                                                          |
| Supply-chain compromise of the published package                                 | Releases are built in CI and published with npm provenance. Runtime dependencies are limited to `@stellar/stellar-sdk`.                                       |
