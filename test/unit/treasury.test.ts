import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { dec, enc, encodeMember, encodeRole } from "../../src/codec.js";
import {
  ContractError,
  encodePolicy,
  encodeProposal,
  encodeTreasuryConfig,
  keypairSigner,
  type PolicyConfig,
  RestoreRequiredError,
  SimulationError,
  StellarSafeClient,
  StellarSafeError,
  TransactionError,
  type TransactionSigner,
  ValidationError,
} from "../../src/index.js";
import {
  ContractFailure,
  contractErrorEvent,
  type FakeRpc,
  fakeRpc,
  VOID,
} from "../helpers/fake-rpc.js";
import {
  ADMIN,
  APPROVER,
  makePolicy,
  makeProposal,
  NOW,
  PROPOSER,
  RECIPIENT,
  TREASURY_ID,
  USDC,
} from "../helpers/fixtures.js";

const policy = makePolicy();
const { version: _v, updatedAt: _u, ...policyConfig } = policy;
const proposal = makeProposal();

let rpc: FakeRpc;
let client: StellarSafeClient;

beforeEach(() => {
  rpc = fakeRpc({
    handlers: {
      get_config: () =>
        encodeTreasuryConfig({ name: "Acme", proposalCount: 1n, interfaceVersion: 1 }),
      get_policy: () => encodePolicy(policy),
      get_members: () =>
        enc.vec(
          [
            { address: ADMIN.publicKey(), role: "Admin" as const },
            { address: APPROVER.publicKey(), role: "Approver" as const },
          ],
          encodeMember,
        ),
      get_role: (args) =>
        args[0] && dec.address(args[0], "a") === ADMIN.publicKey() ? encodeRole("Admin") : VOID,
      get_proposal: (args) => {
        if (args[0] && dec.u64(args[0], "id") !== 1n) throw new ContractFailure(6);
        return encodeProposal(proposal);
      },
      get_pending_proposals: () => enc.vec([proposal], encodeProposal),
      get_proposals: () => enc.vec([proposal], encodeProposal),
      get_spent: () => enc.struct({ period_index: enc.u64(3n), spent: enc.i128(4_000_000_000n) }),
      propose_payment: () => enc.u64(2n),
      approve_payment: () => VOID,
      revoke_approval: () => VOID,
      execute_payment: () => VOID,
      cancel_payment: () => VOID,
      add_member: () => VOID,
      remove_member: () => VOID,
      set_policy: () => enc.u32(2),
    },
  });
  client = new StellarSafeClient({ network: "testnet", rpc, retry: { retries: 0 } });
});

const treasury = () => client.treasury(TREASURY_ID);

describe("reads", () => {
  it("getTreasury returns a full snapshot", async () => {
    const snap = await client.getTreasury(TREASURY_ID);
    expect(snap.contractId).toBe(TREASURY_ID);
    expect(snap.config.name).toBe("Acme");
    expect(snap.policy).toEqual(policy);
    expect(snap.members).toHaveLength(2);
    expect(snap.pendingProposals).toEqual([proposal]);
    expect(snap.ledger).toBe(1000);
  });

  it("simulates reads from the null account without fetching it", async () => {
    await treasury().getPolicy();
    expect(rpc.calls.map((c) => c.method)).toEqual(["get_policy"]);
  });

  it("getRole", async () => {
    expect(await treasury().getRole(ADMIN.publicKey())).toBe("Admin");
    expect(await treasury().getRole(RECIPIENT)).toBeUndefined();
  });

  it("getProposal accepts number, string and bigint ids", async () => {
    for (const id of [1, "1", 1n]) {
      expect(await treasury().getProposal(id)).toEqual(proposal);
    }
  });

  it("maps contract errors", async () => {
    const err = await treasury()
      .getProposal(9)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect(err.contractErrorName).toBe("ProposalNotFound");
  });

  it("listProposals validates paging", async () => {
    expect(await treasury().listProposals()).toEqual([proposal]);
    const call = rpc.calls.at(-1);
    expect(call?.args.map((a) => a.type)).toEqual(["scvU64", "scvU32"]);
    await expect(treasury().listProposals({ limit: 0 })).rejects.toThrow(ValidationError);
    await expect(treasury().listProposals({ limit: 101 })).rejects.toThrow(ValidationError);
  });

  it("getSpending combines on-chain spend with the policy limit", async () => {
    const s = await treasury().getSpending("ops", USDC);
    expect(s).toEqual({
      department: "ops",
      token: USDC,
      periodIndex: 3n,
      spent: 4_000_000_000n,
      limit: 10_000_000_000n,
      remaining: 6_000_000_000n,
    });
    const none = await treasury().getSpending("other", USDC);
    expect(none.limit).toBe(0n);
    expect(none.remaining).toBe(0n);
  });

  it("assertCompatible checks the interface version", async () => {
    await expect(treasury().assertCompatible()).resolves.toBeUndefined();
    rpc.handlers.get_config = () =>
      encodeTreasuryConfig({ name: "x", proposalCount: 0n, interfaceVersion: 2 });
    await expect(treasury().assertCompatible()).rejects.toThrow(/interface v2/);
  });

  it("wraps simulation failures", async () => {
    rpc.rawSimError = "HostError: Error(Budget, ExceededLimit)";
    await expect(treasury().getPolicy()).rejects.toBeInstanceOf(SimulationError);
  });

  it("surfaces archived state and builds the restore transaction", async () => {
    rpc.restore = true;
    const err = await treasury()
      .getPolicy()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RestoreRequiredError);
    expect(err.minResourceFee).toBe("777");
    expect(typeof err.transactionData).toBe("string");

    const restore = await client.prepareRestore(err, { source: ADMIN.publicKey(), fee: 200 });
    expect(restore.transaction.operations[0]?.type).toBe("restoreFootprint");
    expect(restore.fee.total).toBe("977");
    expect(restore.authRequired).toEqual([]);
    rpc.restore = false;
    const res = await restore.signAndSubmit(keypairSigner(ADMIN), { pollIntervalMs: 1 });
    expect(res.result).toBeUndefined();
  });

  it("wraps decode failures with field paths", async () => {
    rpc.handlers.get_policy = () => enc.u32(1);
    await expect(treasury().getPolicy()).rejects.toMatchObject({ code: "DECODE_ERROR" });
  });
});

describe("writes", () => {
  const request = {
    token: USDC,
    recipient: RECIPIENT,
    amount: 1_000_000_000n,
    department: "ops",
    memo: "Invoice #42",
    expiresAt: NOW + 3_600n,
  };

  it("prepares a proposal with simulated result and fees", async () => {
    const tx = await treasury().proposePayment({ proposer: PROPOSER.publicKey(), ...request });
    expect(tx.result).toBe(2n);
    expect(tx.fee.inclusion).toBe("100000");
    expect(tx.fee.resource).toBe("54321");
    expect(tx.simulatedAtLedger).toBe(1000);
    expect(tx.transaction.source).toBe(PROPOSER.publicKey());
    expect(tx.hash).toMatch(/^[0-9a-f]{64}$/);
    const call = rpc.calls.at(-1);
    expect(call?.method).toBe("propose_payment");
    expect(call?.args[0] && dec.address(call.args[0], "a")).toBe(PROPOSER.publicKey());
  });

  it("respects fee, timeout and source overrides", async () => {
    const tx = await treasury().approvePayment(
      { approver: APPROVER.publicKey(), proposalId: 1 },
      { fee: 500, timeoutSeconds: 60, source: ADMIN.publicKey() },
    );
    expect(tx.fee.inclusion).toBe("500");
    expect(tx.transaction.source).toBe(ADMIN.publicKey());
    expect(tx.transaction.timeBounds?.maxTime).not.toBe("0");
  });

  it("signs, submits and decodes the result and events", async () => {
    rpc.txEvents = [
      {
        topics: [enc.symbol("stellarsafe"), enc.symbol("proposed"), enc.u64(2n)],
        data: enc.struct({
          proposer: enc.address(PROPOSER.publicKey()),
          token: enc.address(USDC),
          recipient: enc.address(RECIPIENT),
          amount: enc.i128(request.amount),
          department: enc.symbol("ops"),
          expires_at: enc.u64(request.expiresAt),
        }),
      },
      { topics: [enc.symbol("transfer")], data: VOID },
    ];
    rpc.txStatuses = ["NOT_FOUND", "SUCCESS"];
    const tx = await treasury().proposePayment({ proposer: PROPOSER.publicKey(), ...request });
    const res = await tx.signAndSubmit(keypairSigner(PROPOSER), { pollIntervalMs: 1 });
    expect(res.result).toBe(2n);
    expect(res.hash).toBe(tx.hash);
    expect(res.ledger).toBe(1001);
    expect(res.feeCharged).toBe(12345n);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.type).toBe("proposed");
    expect(res.events[0]?.meta.contractId).toBe(TREASURY_ID);
    expect(res.events[0]?.meta.txHash).toBe(tx.hash);
    expect(rpc.submitted).toHaveLength(1);
    expect(rpc.submitted[0]?.signatures).toHaveLength(1);
  });

  it.each([
    ["approvePayment", { approver: APPROVER.publicKey(), proposalId: 1n }, "approve_payment"],
    ["revokeApproval", { approver: APPROVER.publicKey(), proposalId: 1n }, "revoke_approval"],
    ["executePayment", { executor: APPROVER.publicKey(), proposalId: 1n }, "execute_payment"],
    ["cancelPayment", { caller: ADMIN.publicKey(), proposalId: 1n }, "cancel_payment"],
    ["addMember", { caller: ADMIN.publicKey(), member: RECIPIENT, role: "Proposer" }, "add_member"],
    ["removeMember", { caller: ADMIN.publicKey(), member: RECIPIENT }, "remove_member"],
  ] as const)("%s calls %s", async (fn, params, method) => {
    const t = treasury() as unknown as Record<string, (p: unknown) => Promise<{ result: unknown }>>;
    const tx = await t[fn]?.(params);
    expect(tx?.result).toBeUndefined();
    expect(rpc.calls.at(-1)?.method).toBe(method);
  });

  it("setPolicy validates locally and returns the new version", async () => {
    const tx = await treasury().setPolicy({ caller: ADMIN.publicKey(), policy: policyConfig });
    expect(tx.result).toBe(2);
    const bad: PolicyConfig = { ...policyConfig, defaultApprovals: 0 };
    await expect(treasury().setPolicy({ caller: ADMIN.publicKey(), policy: bad })).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([
    [{ amount: 0n }, /amount/],
    [{ amount: 1 as unknown as bigint }, /amount/],
    [{ recipient: "bad" }, /recipient/],
    [{ department: "no spaces" }, /department/],
    [{ memo: "x".repeat(300) }, /memo/],
  ])("rejects invalid payment requests (%#)", async (overrides, msg) => {
    await expect(
      treasury().proposePayment({ proposer: PROPOSER.publicKey(), ...request, ...overrides }),
    ).rejects.toThrow(msg);
    expect(rpc.calls).toHaveLength(0);
  });

  it("requires an account (G…) as the acting member", async () => {
    await expect(treasury().approvePayment({ approver: USDC, proposalId: 1n })).rejects.toThrow(
      /account address/,
    );
    await expect(
      treasury().approvePayment(
        { approver: APPROVER.publicKey(), proposalId: 1n },
        { source: USDC },
      ),
    ).rejects.toThrow(/source must be an account/);
  });

  it("maps contract errors during preparation", async () => {
    rpc.handlers.execute_payment = () => {
      throw new ContractFailure(11);
    };
    const err = await treasury()
      .executePayment({ executor: APPROVER.publicKey(), proposalId: 1n })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect(err.is("InsufficientApprovals")).toBe(true);
  });

  it("lets a relayer pay while the member authorizes (auth entries)", async () => {
    rpc = fakeRpc({ handlers: rpc.handlers, authFor: [APPROVER.publicKey()] });
    client = new StellarSafeClient({ network: "testnet", rpc });
    const tx = await treasury().approvePayment(
      { approver: APPROVER.publicKey(), proposalId: 1n },
      { source: ADMIN.publicKey() },
    );
    expect(tx.authRequired).toEqual([APPROVER.publicKey()]);
    await expect(tx.sign(keypairSigner(ADMIN))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    // Only the pending signer may authorize.
    await expect(tx.signAuthEntries(keypairSigner(PROPOSER))).rejects.toThrow(
      /no pending authorization/,
    );

    const authorized = await tx.signAuthEntries(keypairSigner(APPROVER));
    expect(authorized.authRequired).toEqual([]);
    expect(authorized.hash).not.toBe(tx.hash);
    expect(authorized.transaction.source).toBe(ADMIN.publicKey());
    expect(authorized.transaction.sequence).toBe(tx.transaction.sequence);
    expect(rpc.simAuthModes.at(-1)).toBe("enforce");

    const op = authorized.transaction.operations[0];
    if (op?.type !== "invokeHostFunction") throw new Error("expected invoke");
    const cred = op.auth?.[0]?.credentials;
    expect(cred?.type).toBe("sorobanCredentialsAddress");
    if (cred?.type === "sorobanCredentialsAddress") {
      expect(cred.address.signature.type).not.toBe("scvVoid");
      expect(cred.address.signatureExpirationLedger).toBe(1100);
    }

    const res = await authorized.signAndSubmit(keypairSigner(ADMIN), { pollIntervalMs: 1 });
    expect(res.hash).toBe(authorized.hash);
  });

  it("signAuthEntries surfaces signer problems", async () => {
    rpc = fakeRpc({ handlers: rpc.handlers, authFor: [APPROVER.publicKey()] });
    client = new StellarSafeClient({ network: "testnet", rpc });
    const tx = await treasury().approvePayment(
      { approver: APPROVER.publicKey(), proposalId: 1n },
      { source: ADMIN.publicKey() },
    );
    const base = keypairSigner(APPROVER);
    const noAuth: TransactionSigner = {
      address: base.address,
      signTransaction: base.signTransaction,
    };
    await expect(tx.signAuthEntries(noAuth)).rejects.toThrow(/does not implement signAuthEntry/);
    await expect(
      tx.signAuthEntries({
        ...base,
        signAuthEntry: async () => ({ signedAuthEntry: "", error: "nope" }),
      }),
    ).rejects.toThrow(/nope/);
    await expect(
      tx.signAuthEntries({
        ...base,
        signAuthEntry: async () => {
          throw new Error("locked");
        },
      }),
    ).rejects.toThrow(/locked/);
    // A forged signature from the wrong key is rejected by authorizeEntry's verification.
    const evil = keypairSigner(PROPOSER);
    await expect(
      tx.signAuthEntries({ ...base, signAuthEntry: (p, o) => evil.signAuthEntry?.(p, o) as never }),
    ).rejects.toMatchObject({ code: "SIGNING_FAILED", message: expect.stringMatching(/invalid/) });
  });

  it("refuses to run against the wrong network", async () => {
    rpc = fakeRpc({ handlers: rpc.handlers, passphrase: Networks.PUBLIC });
    client = new StellarSafeClient({ network: "testnet", rpc });
    await expect(
      treasury().approvePayment({ approver: APPROVER.publicKey(), proposalId: 1n }),
    ).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  });
});

describe("signing safeguards", () => {
  const prepare = () =>
    treasury().approvePayment({ approver: APPROVER.publicKey(), proposalId: 1n });

  const signer = (fn: TransactionSigner["signTransaction"]): TransactionSigner => ({
    address: APPROVER.publicKey(),
    signTransaction: fn,
  });

  it("rejects a wallet that swaps the transaction", async () => {
    const tx = await prepare();
    const other = await treasury().cancelPayment({ caller: APPROVER.publicKey(), proposalId: 1n });
    const evil = signer(async () => {
      const t = TransactionBuilder.fromXDR(other.toXDR(), Networks.TESTNET);
      t.sign(APPROVER);
      return { signedTxXdr: t.toXDR() };
    });
    await expect(tx.sign(evil)).rejects.toThrow(/different transaction/);
  });

  it("rejects unsigned, invalid, erroring and throwing signers", async () => {
    const tx = await prepare();
    await expect(tx.sign(signer(async (x) => ({ signedTxXdr: x })))).rejects.toThrow(
      /without a signature/,
    );
    await expect(tx.sign(signer(async () => ({ signedTxXdr: "garbage" })))).rejects.toThrow(
      /invalid transaction XDR/,
    );
    await expect(
      tx.sign(signer(async () => ({ signedTxXdr: "", error: { message: "User declined" } }))),
    ).rejects.toThrow(/User declined/);
    await expect(
      tx.sign(
        signer(async () => {
          throw new Error("locked");
        }),
      ),
    ).rejects.toMatchObject({ code: "SIGNING_FAILED" });
  });

  it("submit rejects envelopes for another transaction", async () => {
    const tx = await prepare();
    const other = await treasury().cancelPayment({ caller: APPROVER.publicKey(), proposalId: 1n });
    await expect(tx.submit(other.toXDR())).rejects.toThrow(/not a signed copy/);
  });

  it("keypairSigner requires a secret and a passphrase", async () => {
    expect(() => keypairSigner(Keypair.fromPublicKey(ADMIN.publicKey()))).toThrow(/cannot sign/);
    const s = keypairSigner(ADMIN.secret());
    expect(s.address).toBe(ADMIN.publicKey());
    await expect(s.signTransaction("x")).rejects.toThrow(/networkPassphrase/);
  });
});

describe("submission", () => {
  const prepare = () =>
    treasury().approvePayment({ approver: APPROVER.publicKey(), proposalId: 1n });
  const signer = keypairSigner(APPROVER);

  it("backs off on TRY_AGAIN_LATER", async () => {
    rpc.sendStatuses = ["TRY_AGAIN_LATER"];
    const tx = await prepare();
    const res = await tx.signAndSubmit(signer, { pollIntervalMs: 1 });
    expect(res.hash).toBe(tx.hash);
    expect(rpc.submitted).toHaveLength(2);
  }, 10_000);

  it("treats DUPLICATE as already submitted", async () => {
    rpc.sendStatuses = ["DUPLICATE"];
    const res = await (await prepare()).signAndSubmit(signer, { pollIntervalMs: 1 });
    expect(res.ledger).toBe(1001);
  });

  it("reports network rejection", async () => {
    rpc.sendStatuses = ["ERROR"];
    const err = await (await prepare()).signAndSubmit(signer).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.code).toBe("SUBMISSION_FAILED");
    expect(err.message).toContain("txBadSeq");
  });

  it("reports on-chain failure", async () => {
    rpc.txStatuses = ["FAILED"];
    const err = await (await prepare()).signAndSubmit(signer).catch((e) => e);
    expect(err).toMatchObject({ code: "TRANSACTION_FAILED" });
    expect(err.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(err.contractError).toBeUndefined();
  });

  it("extracts the contract error from a failed transaction", async () => {
    rpc.txStatuses = ["FAILED"];
    rpc.failureEvents = [contractErrorEvent(13)];
    const err = await (await prepare()).signAndSubmit(signer).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.contractError).toBeInstanceOf(ContractError);
    expect(err.contractError.contractErrorName).toBe("SpendingLimitExceeded");
    expect(err.message).toContain("SpendingLimitExceeded");
  });

  it("extracts the contract error from a rejected submission", async () => {
    rpc.sendStatuses = ["ERROR"];
    rpc.failureEvents = [contractErrorEvent(7)];
    const err = await (await prepare()).signAndSubmit(signer).catch((e) => e);
    expect(err.contractError?.contractErrorName).toBe("ProposalNotPending");
  });

  it("times out waiting for confirmation", async () => {
    rpc.txStatuses = Array(100).fill("NOT_FOUND");
    const err = await (await prepare())
      .signAndSubmit(signer, { timeoutMs: 20, pollIntervalMs: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "TRANSACTION_TIMEOUT" });
  });

  it("can be aborted while polling", async () => {
    rpc.txStatuses = Array(100).fill("NOT_FOUND");
    const ac = new AbortController();
    const p = (await prepare()).signAndSubmit(signer, { pollIntervalMs: 50, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("connect()", () => {
  it("binds the signer as acting member and submits", async () => {
    const safe = treasury().connect(keypairSigner(APPROVER), { pollIntervalMs: 1 });
    expect(safe.address).toBe(APPROVER.publicKey());
    expect(safe.contractId).toBe(TREASURY_ID);

    await safe.approvePayment({ proposalId: 1n });
    await safe.revokeApproval({ proposalId: 1n });
    await safe.executePayment({ proposalId: 1n });
    await safe.cancelPayment({ proposalId: 1n });
    await safe.addMember({ member: RECIPIENT, role: "Proposer" });
    await safe.removeMember({ member: RECIPIENT });
    expect((await safe.setPolicy({ policy: policyConfig })).result).toBe(2);
    const { result } = await safe.proposePayment({
      token: USDC,
      recipient: RECIPIENT,
      amount: 1n,
      department: "ops",
      memo: "",
      expiresAt: NOW + 10n,
    });
    expect(result).toBe(2n);
    expect(rpc.submitted).toHaveLength(8);
    for (const tx of rpc.submitted) {
      expect("source" in tx && tx.source).toBe(APPROVER.publicKey());
    }
  });
});

describe("errors are always StellarSafeError", () => {
  it("wraps unexpected RPC failures", async () => {
    rpc.simulateTransaction = async () => {
      throw new Error("socket hang up");
    };
    const err = await treasury()
      .getPolicy()
      .catch((e) => e);
    expect(err).toBeInstanceOf(StellarSafeError);
    expect(err.code).toBe("RPC_ERROR");
    expect(err.cause).toBeInstanceOf(Error);
  });
});
