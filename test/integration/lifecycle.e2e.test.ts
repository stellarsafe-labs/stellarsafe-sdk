/**
 * End-to-end lifecycle against a real network (testnet by default).
 *
 * Deploys the treasury wasm in test/fixtures, funds it with native XLM via
 * the Stellar Asset Contract, and exercises every contract rule through
 * the public SDK API.
 *
 *   STELLARSAFE_E2E=1 npm run test:integration
 *
 * Env: STELLAR_RPC_URL (optional), STELLARSAFE_NETWORK=testnet|local (default testnet).
 */
import { readFileSync } from "node:fs";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { enc } from "../../src/codec.js";
import {
  ContractError,
  checkPayment,
  getProposalState,
  keypairSigner,
  NETWORKS,
  type PolicyConfig,
  parseAmount,
  StellarSafeClient,
  type StellarSafeEventType,
  type TransactionSigner,
  type TreasuryClient,
} from "../../src/index.js";
import { TransactionPipeline } from "../../src/transaction.js";

const enabled = process.env.STELLARSAFE_E2E === "1";
const networkName = (process.env.STELLARSAFE_NETWORK ?? "testnet") as "testnet" | "local";
const network = NETWORKS[networkName];

const XLM = parseAmount("1");
const DAY = 86_400n;

async function fund(publicKey: string): Promise<void> {
  const url = `${network.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) return;
    const body = await res.text();
    if (body.includes("createAccountAlreadyExist")) return;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`friendbot failed for ${publicKey}`);
}

/** Expect a promise to reject with a specific contract error. */
async function expectContractError(p: Promise<unknown>, name: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ${name}`).toBeInstanceOf(ContractError);
  expect((err as ContractError).contractErrorName).toBe(name);
}

describe.skipIf(!enabled)(`StellarSafe lifecycle on ${networkName}`, () => {
  const client = new StellarSafeClient({
    network: networkName,
    ...(process.env.STELLAR_RPC_URL ? { rpcUrl: process.env.STELLAR_RPC_URL } : {}),
    retry: { retries: 5 },
  });
  const submit = { timeoutMs: 90_000 };

  const admin = Keypair.random();
  const approver = Keypair.random();
  const approver2 = Keypair.random();
  const proposer = Keypair.random();
  const recipient = Keypair.random();
  const stranger = Keypair.random();
  const signers = {
    admin: keypairSigner(admin),
    approver: keypairSigner(approver),
    approver2: keypairSigner(approver2),
    proposer: keypairSigner(proposer),
    stranger: keypairSigner(stranger),
  };
  const xlmSac = Asset.native().contractId(network.networkPassphrase);

  let policy: PolicyConfig;
  let treasuryId: string;
  let safe: TreasuryClient;
  let startLedger: number;

  const as = (signer: TransactionSigner) => safe.connect(signer, submit);
  const request = async (amount: bigint, overrides: Record<string, unknown> = {}) => {
    const { closeTime } = await client.getLedgerTime();
    return {
      token: xlmSac,
      recipient: recipient.publicKey(),
      amount,
      department: "ops",
      memo: "e2e payment",
      expiresAt: closeTime + DAY,
      ...overrides,
    };
  };

  beforeAll(async () => {
    await client.verifyNetwork();
    for (const kp of [admin, approver, approver2, proposer, recipient, stranger]) {
      await fund(kp.publicKey());
    }
    startLedger = (await client.getLedgerTime()).sequence;

    const wasm = new Uint8Array(
      readFileSync(new URL("../fixtures/stellarsafe_treasury.wasm", import.meta.url)),
    );
    const upload = await client.uploadWasm(wasm, { source: admin.publicKey() });
    const { result: wasmHash } = await upload.signAndSubmit(signers.admin, submit);

    const { closeTime } = await client.getLedgerTime();
    policy = {
      defaultApprovals: 1,
      thresholds: [{ minAmount: 5n * XLM, approvals: 2 }],
      recipientAllowlistEnabled: true,
      allowedRecipients: [recipient.publicKey()],
      allowedTokens: [xlmSac],
      departmentLimits: [{ department: "ops", token: xlmSac, limit: 20n * XLM }],
      period: { anchor: closeTime, length: 30n * DAY },
      maxProposalTtl: 7n * DAY,
    };
    const deploy = await client.deployTreasury({
      wasmHash,
      admin: admin.publicKey(),
      name: "E2E Treasury",
      members: [
        { address: approver.publicKey(), role: "Approver" },
        { address: approver2.publicKey(), role: "Approver" },
        { address: proposer.publicKey(), role: "Proposer" },
      ],
      policy,
    });
    const deployed = await deploy.signAndSubmit(signers.admin, submit);
    treasuryId = deployed.result;
    expect(deployed.events.map((e) => e.type)).toContain("initialized");
    safe = client.treasury(treasuryId);

    // Fund the treasury with 50 XLM through the native Stellar Asset Contract.
    const pipeline = new TransactionPipeline({
      rpc: client.rpc,
      networkPassphrase: client.networkPassphrase,
      retry: {},
    });
    const transfer = await pipeline.prepare(
      xlmSac,
      "transfer",
      [enc.address(admin.publicKey()), enc.address(treasuryId), enc.i128(50n * XLM)],
      () => undefined,
      { source: admin.publicKey() },
    );
    await transfer.signAndSubmit(signers.admin, submit);
  }, 600_000);

  it("reads the deployed treasury", async () => {
    await safe.assertCompatible();
    const snap = await client.getTreasury(treasuryId);
    expect(snap.config).toEqual({ name: "E2E Treasury", proposalCount: 0n, interfaceVersion: 1 });
    expect(snap.policy).toMatchObject({ ...policy, version: 1 });
    expect(new Set(snap.members.map((m) => `${m.role}:${m.address}`))).toEqual(
      new Set([
        `Admin:${admin.publicKey()}`,
        `Approver:${approver.publicKey()}`,
        `Approver:${approver2.publicKey()}`,
        `Proposer:${proposer.publicKey()}`,
      ]),
    );
    expect(snap.pendingProposals).toEqual([]);
    expect(await safe.getRole(stranger.publicKey())).toBeUndefined();
  });

  it("proposes, approves and executes a small payment", async () => {
    const req = await request(2n * XLM);
    const policyNow = await safe.getPolicy();
    expect(checkPayment(policyNow, req, { now: (await client.getLedgerTime()).closeTime })).toEqual(
      [],
    );

    const prepared = await safe.proposePayment({ proposer: proposer.publicKey(), ...req });
    expect(prepared.result).toBe(1n);
    expect(BigInt(prepared.fee.total)).toBeGreaterThan(0n);
    const proposed = await prepared.signAndSubmit(signers.proposer, submit);
    expect(proposed.result).toBe(1n);
    expect(proposed.events[0]).toMatchObject({
      type: "proposed",
      data: { proposalId: 1n, amount: 2n * XLM },
    });

    const approved = await as(signers.approver).approvePayment({ proposalId: 1n });
    expect(approved.events[0]).toMatchObject({ type: "approved", data: { approvals: 1 } });

    const executed = await as(signers.approver).executePayment({ proposalId: 1n });
    expect(executed.events.map((e) => e.type)).toEqual(["executed"]);
    expect(executed.feeCharged).toBeGreaterThan(0n);

    const p = await safe.getProposal(1n);
    expect(p.status).toBe("Executed");
    expect(p.closedAt).toBeDefined();
    const spending = await safe.getSpending("ops", xlmSac);
    expect(spending.spent).toBe(2n * XLM);
    expect(spending.remaining).toBe(18n * XLM);
  });

  it("prevents executing the same payment twice", async () => {
    await expectContractError(
      safe.executePayment({ executor: approver.publicKey(), proposalId: 1n }),
      "ProposalNotPending",
    );
  });

  it("requires two approvals above the threshold", async () => {
    const { result: id } = await as(signers.proposer).proposePayment(await request(6n * XLM));
    expect((await safe.getProposal(id)).requiredApprovals).toBe(2);
    await as(signers.approver).approvePayment({ proposalId: id });
    await expectContractError(
      safe.executePayment({ executor: approver.publicKey(), proposalId: id }),
      "InsufficientApprovals",
    );
    await expectContractError(
      safe.approvePayment({ approver: approver.publicKey(), proposalId: id }),
      "AlreadyApproved",
    );
    await as(signers.approver2).approvePayment({ proposalId: id });
    await as(signers.approver).executePayment({ proposalId: id });
    expect((await safe.getSpending("ops", xlmSac)).spent).toBe(8n * XLM);
  });

  it("enforces roles and membership", async () => {
    await expectContractError(
      safe.proposePayment({ proposer: stranger.publicKey(), ...(await request(XLM)) }),
      "NotMember",
    );
    const { result: id } = await as(signers.proposer).proposePayment(await request(XLM));
    await expectContractError(
      safe.approvePayment({ approver: proposer.publicKey(), proposalId: id }),
      "Unauthorized",
    );
    await expectContractError(
      safe.addMember({ caller: approver.publicKey(), member: stranger.publicKey(), role: "Admin" }),
      "Unauthorized",
    );
    await expectContractError(
      safe.removeMember({ caller: admin.publicKey(), member: admin.publicKey() }),
      "LastAdmin",
    );
    await as(signers.admin).cancelPayment({ proposalId: id });
  });

  it("enforces recipient, token and spending limits", async () => {
    await expectContractError(
      safe.proposePayment({
        proposer: proposer.publicKey(),
        ...(await request(XLM, { recipient: stranger.publicKey() })),
      }),
      "RecipientNotAllowed",
    );
    await expectContractError(
      safe.proposePayment({
        proposer: proposer.publicKey(),
        ...(await request(XLM, { token: treasuryId })),
      }),
      "TokenNotAllowed",
    );
    await expectContractError(
      safe.proposePayment({
        proposer: proposer.publicKey(),
        ...(await request(XLM, { department: "marketing" })),
      }),
      "SpendingLimitExceeded",
    );
    // 8 XLM spent of 20: 13 XLM does not fit.
    await expectContractError(
      safe.proposePayment({ proposer: proposer.publicKey(), ...(await request(13n * XLM)) }),
      "SpendingLimitExceeded",
    );
    const { closeTime } = await client.getLedgerTime();
    await expectContractError(
      safe.proposePayment({
        proposer: proposer.publicKey(),
        ...(await request(XLM, { expiresAt: closeTime + 8n * DAY })),
      }),
      "InvalidExpiry",
    );
  });

  it("revokes approvals and lets the proposer cancel", async () => {
    const { result: id } = await as(signers.proposer).proposePayment(await request(XLM));
    await as(signers.approver).approvePayment({ proposalId: id });
    const revoked = await as(signers.approver).revokeApproval({ proposalId: id });
    expect(revoked.events[0]).toMatchObject({ type: "approval_revoked", data: { approvals: 0 } });
    await expectContractError(
      safe.executePayment({ executor: approver.publicKey(), proposalId: id }),
      "InsufficientApprovals",
    );
    await as(signers.proposer).cancelPayment({ proposalId: id });
    expect((await safe.getProposal(id)).status).toBe("Cancelled");
  });

  it("voids approvals when the policy changes", async () => {
    const { result: id } = await as(signers.proposer).proposePayment(await request(XLM));
    await as(signers.approver).approvePayment({ proposalId: id });
    const { result: version } = await as(signers.admin).setPolicy({ policy });
    expect(version).toBe(2);
    const [proposal, current, { closeTime }] = await Promise.all([
      safe.getProposal(id),
      safe.getPolicy(),
      client.getLedgerTime(),
    ]);
    expect(getProposalState(proposal, closeTime, current.version)).toBe("stale");
    await expectContractError(
      safe.executePayment({ executor: approver.publicKey(), proposalId: id }),
      "PolicyVersionMismatch",
    );
    await as(signers.admin).cancelPayment({ proposalId: id });
  });

  it("drops a removed member's approvals", async () => {
    const { result: id } = await as(signers.proposer).proposePayment(await request(6n * XLM));
    await as(signers.approver).approvePayment({ proposalId: id });
    await as(signers.approver2).approvePayment({ proposalId: id });
    await as(signers.admin).removeMember({ member: approver2.publicKey() });
    expect((await safe.getProposal(id)).approvals).toEqual([approver.publicKey()]);
    await expectContractError(
      safe.executePayment({ executor: approver.publicKey(), proposalId: id }),
      "InsufficientApprovals",
    );
    await as(signers.admin).addMember({ member: approver2.publicKey(), role: "Approver" });
    await as(signers.admin).cancelPayment({ proposalId: id });
  });

  it("lets a relayer pay fees while the member authorizes", async () => {
    const { result: id } = await as(signers.proposer).proposePayment(await request(XLM));
    // The admin account submits and pays; the approver only signs an auth entry.
    const prepared = await safe.approvePayment(
      { approver: approver.publicKey(), proposalId: id },
      { source: admin.publicKey() },
    );
    expect(prepared.authRequired).toEqual([approver.publicKey()]);
    const authorized = await prepared.signAuthEntries(signers.approver);
    expect(authorized.authRequired).toEqual([]);
    const res = await authorized.signAndSubmit(signers.admin, submit);
    expect(res.events[0]).toMatchObject({
      type: "approved",
      data: { approver: approver.publicKey(), approvals: 1 },
    });
    await as(signers.approver).executePayment({ proposalId: id });
  });

  it("indexes the full history from events", async () => {
    const seen: StellarSafeEventType[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.getEvents({
        contractIds: [treasuryId],
        ...(cursor ? { cursor } : { startLedger }),
        limit: 200,
      });
      seen.push(...res.events.map((e) => e.type));
      for (const e of res.events) expect(e.meta.contractId).toBe(treasuryId);
      if (res.scanned === 0) break;
      cursor = res.cursor;
    }
    for (const type of [
      "initialized",
      "member_added",
      "member_removed",
      "policy_updated",
      "proposed",
      "approved",
      "approval_revoked",
      "executed",
      "cancelled",
    ] as const) {
      expect(seen, `missing ${type}`).toContain(type);
    }
    const proposals = await safe.listProposals({ start: 1n, limit: 100 });
    expect(proposals.filter((p) => p.status === "Executed")).toHaveLength(3);
    expect(await safe.getPendingProposals()).toEqual([]);
  });
});
