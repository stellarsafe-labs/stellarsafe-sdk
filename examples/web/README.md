# StellarSafe browser wallet example

A small Vite + TypeScript app (no UI framework) that uses `@stellarsafe/sdk`
with a browser wallet on **testnet**:

1. Connect a wallet through [Stellar Wallets Kit](https://stellarwalletskit.dev)
   (Freighter, plus other wallets that implement SEP-43 in full).
2. Load a treasury by contract id and show its policy, members and pending
   proposals (`client.getTreasury`).
3. Propose a payment or approve a proposal. The app shows the simulated
   result and fee **before** the wallet is asked to sign.
4. Show contract errors by name (for example `RecipientNotAllowed`) with
   `isContractError`, and handle a rejected signature (`SIGNING_FAILED`)
   without breaking the page.

There are no secret keys in this app. Every signature comes from the wallet.

| File                             | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`src/wallet.ts`](src/wallet.ts) | **The wallet adapter.** Maps the kit to the SDK's `TransactionSigner` (`address`, `signTransaction`, `signAuthEntry`). Start here. |
| [`src/main.ts`](src/main.ts)     | Page logic: load, propose, approve, review dialog, relayed-fee flow.                                                               |
| [`src/errors.ts`](src/errors.ts) | Turns SDK and wallet errors into messages for the user.                                                                            |

> **Freighter is listed as "Varial"** in Stellar Wallets Kit 2.8+ (Freighter's
> new name). The kit's Varial module is the Freighter extension.

## Setup

You need Node.js ≥ 22.12 and the [Freighter](https://freighter.app) browser
extension, switched to **Testnet** and funded
(Freighter → _Fund with Friendbot_).

The example uses the SDK from this repository (`"@stellarsafe/sdk": "file:../.."`),
not from npm, so build the SDK first:

```sh
# from the repository root
npm ci
npm run build

cd examples/web
npm ci
npm run dev        # http://localhost:5173
```

`npm run build` type-checks and writes a static site to `dist/`.

If you change the SDK, run `npm run build` at the repository root again and
restart `npm run dev`.

### A treasury to try it on

To propose or approve, your wallet account must be a member of the treasury.
Deploy a test treasury that includes your Freighter address as an Approver:

```sh
# from the repository root, after npm run build
WALLET_MEMBERS=G…your-freighter-address… node examples/deploy-treasury.ts
```

It prints the treasury id, the token id (testnet XLM) and the one recipient
the policy allows. Paste the treasury id into the app, or open
`http://localhost:5173/?treasury=C…`.

Optional defaults can go in `examples/web/.env.local` (see
[`.env.example`](.env.example)). Everything in a `VITE_*` variable ends up
in the page, so only put public values there.

## Walkthrough

| Step                       | What to do                                                                         | What you should see                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Connect                 | Click **Connect wallet**, then pick Freighter (Varial).                            | Your address in the header. A warning if the wallet is not on Testnet.                                                                                                                                      |
| 2. Load                    | Paste the treasury id and click **Load**.                                          | Name, policy (approvals, thresholds, allowlist, limits), members (yours is marked "(you)"), pending proposals.                                                                                              |
| 3. Propose                 | Fill in token, the allowed recipient, `10`, `ops`, then click **Review proposal**. | A dialog with the new proposal id and the max fee (inclusion + resources), before any wallet prompt. Click **Sign with wallet**, approve in Freighter. You get a link to the transaction on stellar.expert. |
| 4. Approve                 | Click **Approve** next to a pending proposal.                                      | The same review dialog, then the wallet prompt. The approval count goes up.                                                                                                                                 |
| 5. Contract error          | Propose to a recipient that is not on the allowlist.                               | Before signing: `Contract rejected the call: RecipientNotAllowed`. Nothing is signed.                                                                                                                       |
| 6. Reject signature        | Click **Sign with wallet**, then **Reject** in Freighter.                          | `The wallet did not sign (SIGNING_FAILED). Nothing was submitted; you can try again.` Buttons stay usable.                                                                                                  |
| 7. Relayed fees (optional) | Put a second Freighter account in **Fee payer**, then propose or approve.          | Freighter first asks you to sign an _authorization entry_ (`signAuthEntry`). Then switch Freighter to the fee-payer account and sign the envelope.                                                          |

<!--
  TODO before merge: add screenshots (or a short screen recording) of each
  step on testnet with Freighter, e.g. docs/1-connect.png … docs/7-relayed-fees.png,
  and link them here.
-->

## How signing works

```ts
import { walletSigner } from "./wallet";

const tx = await client.treasury(id).approvePayment({ approver: address, proposalId });
console.log(tx.result, tx.fee.total); // show these before asking to sign
await tx.signAndSubmit(walletSigner(address));
```

`signAndSubmit` sends the envelope to the wallet. Before submitting, the SDK
checks that the wallet returned **the same transaction** (identical hash)
with a new signature. If the wallet changed anything, or returned it
unsigned, you get `SIGNING_FAILED` and nothing is sent.

With a separate fee payer, the member signs only their authorization:

```ts
const tx = await safe.approvePayment({ approver: member, proposalId }, { source: feePayer });
const authorized = await tx.signAuthEntries(walletSigner(member)); // wallet: signAuthEntry
await authorized.signAndSubmit(walletSigner(feePayer)); // wallet: signTransaction
```
