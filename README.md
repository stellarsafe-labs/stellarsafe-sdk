# @stellarsafe/sdk

TypeScript SDK for **StellarSafe**, an open-source **spending-policy engine**
for Stellar. Treasuries, DAOs and payroll apps hold funds in a Soroban
contract that enforces approval thresholds, recipient and token allowlists,
department spending limits and approval expiry **on-chain**. This SDK lets any
app, not just the StellarSafe dashboard, read policies, prepare and simulate
payments, sign with any Stellar wallet and index contract events.

[![CI](https://github.com/stellarsafe-labs/stellarsafe-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/stellarsafe-labs/stellarsafe-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@stellarsafe/sdk.svg)](https://www.npmjs.com/package/@stellarsafe/sdk)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Status: pre-1.0, testnet only.** The StellarSafe contracts have not been
> audited. Do not hold real funds in a StellarSafe treasury until they have.

## Live demo on testnet

A demo treasury deployed with this SDK (`scripts/demo-testnet.ts`):

|                                |                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Treasury                       | [`CCDNZXL2…G2QRR`](https://stellar.expert/explorer/testnet/contract/CCDNZXL2PRPWTN7H6QF7HIRTFZXX73FG3VV7VB4EU2MWG6C2VXYG2QRR) |
| Policy                         | 1 approval by default, 2 for ≥ 25 XLM; allowlisted vendor only; `ops` limited to 100 XLM per 30 days                          |
| Deployment (constructor setup) | [tx](https://stellar.expert/explorer/testnet/tx/16644bf61ef89efc0e9fa7a2fa525065a347dde80507c5eae1c2ff498206352e)             |
| 10 XLM payment, 1 approval     | [executed](https://stellar.expert/explorer/testnet/tx/b4334922d260da9c567e960ae58f16f104c51a628a545126380990a00d7375fe)       |
| 30 XLM payment, 2 approvals    | [executed](https://stellar.expert/explorer/testnet/tx/0b25f8ea66b0c2e8e08a672195e88c2efc1d3af01588ee5706859fc3c28c8411)       |
| Proposal #3, 40 XLM            | pending, 1 of 2 approvals                                                                                                     |

Read it yourself:

```sh
npm run build
STELLARSAFE_TREASURY_ID=CCDNZXL2PRPWTN7H6QF7HIRTFZXX73FG3VV7VB4EU2MWG6C2VXYG2QRR node examples/read-treasury.ts
```

Testnet is reset periodically; rerun `node scripts/demo-testnet.ts` to recreate it.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Reading a treasury](#reading-a-treasury)
- [Writing: prepare → sign → submit](#writing-prepare--sign--submit)
- [Deploying a treasury](#deploying-a-treasury)
- [Wallets and signers](#wallets-and-signers)
- [Policy helpers](#policy-helpers)
- [Events](#events)
- [Amounts](#amounts)
- [Errors](#errors)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Development](#development)

## Install

```sh
npm install @stellarsafe/sdk
```

Requires Node.js ≥ 22.12 or a modern browser/bundler. `@stellar/stellar-sdk`
is a dependency and is installed automatically. Ships ESM, CommonJS and
TypeScript declarations.

## Quick start

```ts
import { StellarSafeClient } from "@stellarsafe/sdk";

const client = new StellarSafeClient({ network: "testnet" });

const treasury = await client.getTreasury("CBX…TREASURY_CONTRACT_ID");

console.log(treasury.policy);
console.log(treasury.pendingProposals);
```

## Reading a treasury

Reads simulate a contract call. They need no account, signature or fee.

```ts
const safe = client.treasury("CBX…");

await safe.getConfig(); // { name, proposalCount, interfaceVersion }
await safe.getPolicy(); // thresholds, allowlists, limits, version …
await safe.getMembers(); // [{ address, role }]
await safe.getRole("GABC…"); // "Admin" | "Approver" | "Proposer" | undefined
await safe.getProposal(12n); // one proposal
await safe.getPendingProposals(); // all with status Pending
await safe.listProposals({ start: 1n, limit: 50 });
await safe.getSpending("ops", USDC); // { spent, limit, remaining, periodIndex }
await safe.getSnapshot(); // config + policy + members + pending, in parallel

await safe.assertCompatible(); // throws if the contract's interface version differs
```

## Writing: prepare → sign → submit

Every write returns a `PreparedTransaction`: built, **simulated** against the
current ledger, and assembled with resources and fees. Nothing is sent until
you sign and submit, so you can show the user the outcome and fee first.

```ts
import { keypairSigner, parseAmount } from "@stellarsafe/sdk";

const { closeTime } = await client.getLedgerTime();

const tx = await safe.proposePayment({
  proposer: "GPROPOSER…",
  token: USDC_CONTRACT_ID,
  recipient: "GVENDOR…",
  amount: parseAmount("750", 7), // 750 USDC → 7_500_000_000n
  department: "ops",
  memo: "Invoice #1042",
  expiresAt: closeTime + 3n * 86_400n, // 3 days, in ledger time
});

console.log(tx.result); // the proposal id this call will return
console.log(tx.fee); // { inclusion, resource, total } in stroops

const { result: proposalId, hash, events } = await tx.signAndSubmit(signer);
```

Other writes follow the same shape: `approvePayment`, `revokeApproval`,
`executePayment`, `cancelPayment`, `addMember`, `removeMember` and
`setPolicy`. The acting member is the transaction source by default.

If a contract rule would be broken, preparation throws a `ContractError`
**before** anything is signed:

```ts
import { isContractError } from "@stellarsafe/sdk";

try {
  await safe.executePayment({ executor: me, proposalId });
} catch (err) {
  if (isContractError(err, "InsufficientApprovals")) {
    /* show approval progress */
  }
}
```

### Bound signer

For scripts and backends, `connect()` returns a client whose writes sign and
submit immediately:

```ts
const ops = client.treasury("CBX…").connect(keypairSigner(process.env.APPROVER_SECRET!));
await ops.approvePayment({ proposalId: 12n });
await ops.executePayment({ proposalId: 12n });
```

### External or multisig signing

```ts
const tx = await safe.approvePayment({ approver: me, proposalId: 12n });
const xdr = tx.toXDR(); // hand to any signer
// … later …
await tx.submit(signedXdr); // verifies it is the same transaction
```

### Relayers and sponsored fees

Another account can pay the fee while the member only authorizes the call.
Preparation lists who still has to authorize; each of them signs an
authorization entry, then the fee payer signs the transaction:

```ts
const tx = await safe.approvePayment(
  { approver: memberAddress, proposalId: 12n },
  { source: relayerAddress }, // relayer pays
);
tx.authRequired; // [memberAddress]
const authorized = await tx.signAuthEntries(memberWallet); // SEP-43 signAuthEntry
await authorized.signAndSubmit(relayerSigner);
```

`signAuthEntries` re-simulates with the signatures enforced, so fees stay
accurate. `sign()` refuses to run while `authRequired` is non-empty.

## Deploying a treasury

Setup runs in the contract constructor, in the same transaction as the
deployment, so nobody can claim a treasury between deploy and setup.

```ts
import { monthlyPeriod, parseAmount } from "@stellarsafe/sdk";

// Once per network (uploading identical wasm again is harmless):
const { result: wasmHash } = await (await client.uploadWasm(wasm, { source: me })).signAndSubmit(
  wallet,
);

const { closeTime } = await client.getLedgerTime();
const tx = await client.deployTreasury({
  wasmHash,
  admin: me,
  name: "Acme Ops",
  members: [
    { address: cfo, role: "Approver" },
    { address: ops, role: "Proposer" },
  ],
  policy: {
    defaultApprovals: 1,
    thresholds: [{ minAmount: parseAmount("500"), approvals: 2 }],
    recipientAllowlistEnabled: true,
    allowedRecipients: [vendor],
    allowedTokens: [USDC],
    departmentLimits: [{ department: "ops", token: USDC, limit: parseAmount("10000") }],
    period: monthlyPeriod(closeTime), // 30-day windows
    maxProposalTtl: 7n * 86_400n,
  },
});
const { result: treasuryId } = await tx.signAndSubmit(wallet);
```

The policy is validated locally first (for example, thresholds must be
reachable by the initial approvers).

### Archived state

Soroban archives contract data that is not touched for a long time. If a call
hits archived state, the SDK throws `RestoreRequiredError`; restore and retry:

```ts
try {
  await safe.getPolicy();
} catch (err) {
  if (err instanceof RestoreRequiredError) {
    await (await client.prepareRestore(err, { source: me })).signAndSubmit(wallet);
  }
}
```

## Wallets and signers

Any object with `address` and a SEP-43 `signTransaction` works — Freighter,
[Stellar Wallets Kit](https://stellarwalletskit.dev), or `@stellar/stellar-sdk`'s
`contract.Signer`:

```ts
const signer = {
  address: await kit.getAddress().then((a) => a.address),
  signTransaction: (xdr, opts) => kit.signTransaction(xdr, opts),
};
```

Before submitting, the SDK checks that the wallet returned **the same
transaction** (identical hash) with a new signature, so a misbehaving wallet
cannot swap in a different payment.

To authorize as a member while someone else pays fees, the signer also needs
SEP-43 `signAuthEntry` (Freighter provides it).

`keypairSigner(secret)` is provided for servers, scripts and tests. It
implements both methods and refuses to sign authorizations for another network.

## Policy helpers

Pure functions that mirror the contract's rules, so UIs can explain a
failure before the user pays a fee. They are advisory — the contract decides.

```ts
import { checkPayment, getProposalState, requiredApprovals, periodBounds } from "@stellarsafe/sdk";

const { policy, members, pendingProposals } = await client.getTreasury(id);
const { closeTime: now } = await client.getLedgerTime();

requiredApprovals(policy, parseAmount("750")); // → 2
checkPayment(policy, request, { now, spent }); // → [{ code: "RecipientNotAllowed", message }]
getProposalState(proposal, now, policy.version); // "pending" | "ready" | "stale" | "expired" | …
periodBounds(policy.period, now); // { index, start, end } of the spending period
```

Use **ledger time** (`getLedgerTime().closeTime`) for `now`, not `Date.now()`.

## Events

```ts
// One page
const page = await client.getEvents({ contractIds: [id], startLedger: 1_000_000 });

// Continuous stream, resumable by cursor
const ac = new AbortController();
for await (const event of client.streamEvents({
  contractIds: [id],
  startLedger,
  signal: ac.signal,
})) {
  switch (event.type) {
    case "approved":
      console.log(`${event.data.approver} approved #${event.data.proposalId}`);
      break;
    case "executed":
      console.log(`paid ${event.data.amount} to ${event.data.recipient}`, event.meta.txHash);
      break;
  }
}
```

Events are a typed discriminated union: `event.data` is narrowed by
`event.type`. `decodeEvent()` is exported for decoding events from other
sources. Unknown or non-StellarSafe events are skipped, so indexers keep
working when the contract adds new event types.

## Amounts

Token amounts are `bigint` in the token's smallest unit, exactly as on-chain.
Convert with exact string arithmetic — never floats:

```ts
parseAmount("500.25", 7); // 5_002_500_000n
formatAmount(5_002_500_000n, 7); // "500.25"
parseAmount("0.00000001", 7); // throws: too many decimal places (no silent rounding)
```

## Errors

Everything the SDK throws is a `StellarSafeError` with a stable `code`:

| Class                  | `code`                                                                             | When                                                     |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ValidationError`      | `INVALID_ARGUMENT`                                                                 | Bad input, caught before any network call                |
| `ContractError`        | `CONTRACT_ERROR`                                                                   | The contract rejected the call; see `contractErrorName`  |
| `SimulationError`      | `SIMULATION_FAILED`                                                                | Simulation failed for another reason                     |
| `RestoreRequiredError` | `RESTORE_REQUIRED`                                                                 | Contract state is archived and must be restored          |
| `TransactionError`     | `SUBMISSION_FAILED`, `TRANSACTION_FAILED`, `TRANSACTION_TIMEOUT`                   | Includes `hash`                                          |
| `RpcError`             | `RPC_ERROR`                                                                        | RPC unreachable after retries                            |
| `DecodeError`          | `DECODE_ERROR`                                                                     | Contract returned data that does not match the interface |
| `StellarSafeError`     | `SIGNING_FAILED`, `NETWORK_MISMATCH`, `AUTH_REQUIRED`, `INVALID_CONFIG`, `ABORTED` |                                                          |

A `TRANSACTION_TIMEOUT` means the transaction _may still land_: check its
status by hash before resubmitting.

If state changes between simulation and inclusion (for example another
approver executed first), the transaction fails on-chain. When the RPC
reports the cause, `err.contractError` holds it:

```ts
catch (err) {
  if (err instanceof TransactionError && err.contractError?.is("ProposalNotPending")) { … }
}
```

## Configuration

```ts
new StellarSafeClient({
  network: "testnet", // "testnet" | "mainnet" | "futurenet" | "local" | "custom"
  rpcUrl: "https://…", // required for mainnet and custom
  networkPassphrase: "…", // required for custom
  headers: { Authorization: "Bearer …" },
  timeoutMs: 30_000,
  retry: { retries: 3, baseDelayMs: 250, maxDelayMs: 5_000 },
  allowHttp: false, // only for local development
  rpc: myRpcServer, // bring your own rpc.Server (or a test double)
});
```

**Read-your-writes.** Public RPC endpoints are load-balanced, so a read
right after a write can reach a node that is a ledger behind. After a client
confirms one of its transactions, its later reads and simulations wait until
the RPC has caught up to that ledger, and it never reuses an account sequence
number a lagging node reports. For writes made elsewhere (another client, a
backend), pass the ledger explicitly: `safe.getProposal(id, { minLedger })`.

Transient RPC failures (network errors, 429, 5xx) are retried with
exponential backoff and jitter. Before the first write the client checks the
RPC server's network passphrase matches its configuration.

All network methods accept an `AbortSignal`.

## Security model

- **The contract is the authority.** The SDK never treats local checks,
  backend records or simulation as final. Only a confirmed transaction is.
- **No key custody.** The SDK never asks for secret keys except through the
  optional `keypairSigner` helper for server-side use.
- **Signed-transaction integrity.** Signed envelopes are verified against the
  prepared transaction hash before submission.
- **Network pinning.** Writes are refused if the RPC server is on a different
  network than configured. `http://` RPC URLs are refused unless opted in.
- **Strict decoding.** Contract responses are validated field-by-field.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and the SDK
threat model, and [docs/CONTRACT_INTERFACE.md](docs/CONTRACT_INTERFACE.md)
for the contract interface the SDK targets.

## Development

```sh
npm ci
npm run ci          # lint, typecheck, unit tests with coverage, build, package checks
npm test            # unit tests
npm run docs        # API reference into docs/api
```

### How the SDK is tested

- **Unit tests** (`npm test`) run offline against a fake RPC server, with ≥ 95% coverage.
- **Contract conformance** (`test/unit/contract-spec.test.ts`) reads the interface
  spec embedded in the real contract build (`test/fixtures/stellarsafe_treasury.wasm`)
  and checks every SDK call, argument encoding, return type, error code and
  event against it. Contract/SDK drift fails CI.
- **End-to-end** (`npm run test:e2e`) deploys the contract to **testnet** with
  fresh friendbot-funded accounts and runs the full lifecycle: deploy, fund,
  propose, approve, execute, double-execution, thresholds, roles, allowlists,
  spending limits, expiry bounds, revocation, policy-version voiding, member
  removal, relayed fees and event indexing. It needs no secrets.
- **Browser bundle** (`npm run check:browser`) ensures no Node-only imports.

To check a treasury you already deployed (read-only):

```sh
STELLARSAFE_TREASURY_ID=C… npm run test:integration
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Runnable examples live in
[`examples/`](https://github.com/stellarsafe-labs/stellarsafe-sdk/tree/main/examples).

## License

[Apache-2.0](LICENSE)
