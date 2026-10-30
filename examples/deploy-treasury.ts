/**
 * Deploy a new StellarSafe treasury on testnet with fresh, friendbot-funded
 * accounts, then print its state.
 *
 *   npm run build
 *   node examples/deploy-treasury.ts [path/to/stellarsafe_treasury.wasm]
 */
import { readFileSync } from "node:fs";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import {
  keypairSigner,
  monthlyPeriod,
  NETWORKS,
  parseAmount,
  StellarSafeClient,
} from "@stellarsafe/sdk";

const wasmPath = process.argv[2] ?? "test/fixtures/stellarsafe_treasury.wasm";
const client = new StellarSafeClient({ network: "testnet" });

const admin = Keypair.random();
const approver = Keypair.random();
const vendor = Keypair.random();
for (const kp of [admin, approver, vendor]) {
  const res = await fetch(`${NETWORKS.testnet.friendbotUrl}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot: ${await res.text()}`);
}
const wallet = keypairSigner(admin);

const upload = await client.uploadWasm(new Uint8Array(readFileSync(wasmPath)), {
  source: admin.publicKey(),
});
const { result: wasmHash } = await upload.signAndSubmit(wallet);
console.log("wasm hash:", wasmHash);

const xlm = Asset.native().contractId(client.networkPassphrase);
const { closeTime } = await client.getLedgerTime();
const deploy = await client.deployTreasury({
  wasmHash,
  admin: admin.publicKey(),
  name: "Example Treasury",
  members: [{ address: approver.publicKey(), role: "Approver" }],
  policy: {
    defaultApprovals: 1,
    thresholds: [{ minAmount: parseAmount("100"), approvals: 2 }],
    recipientAllowlistEnabled: true,
    allowedRecipients: [vendor.publicKey()],
    allowedTokens: [xlm],
    departmentLimits: [{ department: "ops", token: xlm, limit: parseAmount("1000") }],
    period: monthlyPeriod(closeTime),
    maxProposalTtl: 7n * 86_400n,
  },
});
const { result: treasuryId, hash } = await deploy.signAndSubmit(wallet);
console.log("treasury:", treasuryId);
console.log(`https://stellar.expert/explorer/testnet/tx/${hash}`);
console.log(await client.getTreasury(treasuryId));
console.log("admin secret (testnet only):", admin.secret());
