/**
 * Create a public demo treasury on testnet with real activity, for the README.
 *
 *   npm run build && node scripts/demo-testnet.ts
 *
 * Prints the treasury id and transaction links as JSON. Accounts are fresh
 * and friendbot-funded; their secrets are not printed.
 */
import { readFileSync } from "node:fs";
import {
  Address,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  type rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  keypairSigner,
  monthlyPeriod,
  NETWORKS,
  parseAmount,
  StellarSafeClient,
} from "@stellarsafe/sdk";

const explorer = (kind: string, id: string) =>
  `https://stellar.expert/explorer/testnet/${kind}/${id}`;
const client = new StellarSafeClient({ network: "testnet" });
const submit = { timeoutMs: 90_000 };

const [admin, approver, proposer, vendor] = [0, 1, 2, 3].map(() => Keypair.random()) as [
  Keypair,
  Keypair,
  Keypair,
  Keypair,
];
for (const kp of [admin, approver, proposer, vendor]) {
  const res = await fetch(`${NETWORKS.testnet.friendbotUrl}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot: ${await res.text()}`);
}

const wasm = new Uint8Array(readFileSync("test/fixtures/stellarsafe_treasury.wasm"));
const { result: wasmHash } = await (
  await client.uploadWasm(wasm, { source: admin.publicKey() })
).signAndSubmit(keypairSigner(admin), submit);

const xlm = Asset.native().contractId(client.networkPassphrase);
const { closeTime } = await client.getLedgerTime();
const deployed = await (
  await client.deployTreasury({
    wasmHash,
    admin: admin.publicKey(),
    name: "StellarSafe Demo Treasury",
    members: [
      { address: approver.publicKey(), role: "Approver" },
      { address: proposer.publicKey(), role: "Proposer" },
    ],
    policy: {
      defaultApprovals: 1,
      thresholds: [{ minAmount: parseAmount("25"), approvals: 2 }],
      recipientAllowlistEnabled: true,
      allowedRecipients: [vendor.publicKey()],
      allowedTokens: [xlm],
      departmentLimits: [{ department: "ops", token: xlm, limit: parseAmount("100") }],
      period: monthlyPeriod(closeTime),
      maxProposalTtl: 7n * 86_400n,
    },
  })
).signAndSubmit(keypairSigner(admin), submit);
const treasuryId = deployed.result;

// Fund the treasury with 200 XLM: a plain transfer through the native asset contract.
const adminAccount = await client.rpc.getAccount(admin.publicKey());
const transferTx = new TransactionBuilder(adminAccount, {
  fee: "100000",
  networkPassphrase: client.networkPassphrase,
})
  .addOperation(
    new Contract(xlm).call(
      "transfer",
      new Address(admin.publicKey()).toScVal(),
      new Address(treasuryId).toScVal(),
      nativeToScVal(parseAmount("200"), { type: "i128" }),
    ),
  )
  .setTimeout(300)
  .build();
const preparedTransfer = await (client.rpc as rpc.Server).prepareTransaction(transferTx);
preparedTransfer.sign(admin);
const sent = await client.rpc.sendTransaction(preparedTransfer);
const fundedResult = await (client.rpc as rpc.Server).pollTransaction(sent.hash, { attempts: 30 });
if (fundedResult.status !== "SUCCESS") throw new Error(`funding failed: ${fundedResult.status}`);
const funded = { hash: sent.hash };

const safe = client.treasury(treasuryId);
const asProposer = safe.connect(keypairSigner(proposer), submit);
const asApprover = safe.connect(keypairSigner(approver), submit);
const asAdmin = safe.connect(keypairSigner(admin), submit);

const request = (amount: string, memo: string) => ({
  token: xlm,
  recipient: vendor.publicKey(),
  amount: parseAmount(amount),
  department: "ops",
  memo,
  expiresAt: closeTime + 6n * 86_400n,
});

// 1. Small payment: one approval, executed.
const p1 = await asProposer.proposePayment(request("10", "Invoice #1001 – hosting"));
await asApprover.approvePayment({ proposalId: p1.result });
const e1 = await asApprover.executePayment({ proposalId: p1.result });

// 2. Large payment: two approvals, executed.
const p2 = await asProposer.proposePayment(request("30", "Invoice #1002 – audit deposit"));
await asApprover.approvePayment({ proposalId: p2.result });
await asAdmin.approvePayment({ proposalId: p2.result });
const e2 = await asApprover.executePayment({ proposalId: p2.result });

// 3. Left pending with one of two approvals, so the dashboard has something to show.
const p3 = await asProposer.proposePayment(request("40", "Invoice #1003 – contractor"));
await asApprover.approvePayment({ proposalId: p3.result });

console.log(
  JSON.stringify(
    {
      treasuryId,
      treasury: explorer("contract", treasuryId),
      wasmHash,
      deployTx: explorer("tx", deployed.hash),
      fundTx: explorer("tx", funded.hash),
      executedSmallPaymentTx: explorer("tx", e1.hash),
      executedTwoApprovalPaymentTx: explorer("tx", e2.hash),
      pendingProposalId: p3.result.toString(),
      members: {
        admin: admin.publicKey(),
        approver: approver.publicKey(),
        proposer: proposer.publicKey(),
        vendor: vendor.publicKey(),
      },
    },
    null,
    2,
  ),
);
