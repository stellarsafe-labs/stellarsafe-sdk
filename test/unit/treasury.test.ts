import { Address, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
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
  contractId,
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
const EURC = contractId(12);
const XLM_SAC = contractId(13);
/** Balances served by the fake `balance` handler, per token contract. */
let balances: Map<string, bigint>;

let rpc: FakeRpc;
let client: StellarSafeClient;

beforeEach(() => {
  balances = new Map([[USDC, 50_0000000n]]);
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
      balance: (_args, token) => {
        const balance = balances.get(token);
        if (balance === undefined) throw new ContractFailure(6);
        return enc.i128(balance);
      },
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
    expect(snap.balances).toEqual([{ token: USDC, balance: 50_0000000n }]);
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

describe("getBalances", () => {
  const multiTokenPolicy = makePolicy({
    allowedTokens: [USDC, EURC],
    departmentLimits: [
      { department: "ops", token: USDC, limit: 1n },
      { department: "ops", token: XLM_SAC, limit: 1n },
      { department: "marketing", token: EURC, limit: 1n },
    ],
  });

  beforeEach(() => {
    rpc.handlers.get_policy = () => encodePolicy(multiTokenPolicy);
    balances.set(EURC, 7n).set(XLM_SAC, 0n);
  });

  const balanceCalls = () => rpc.calls.filter((c) => c.method === "balance");

  it("reads each distinct policy token once, in policy order", async () => {
    expect(await treasury().getBalances()).toEqual([
      { token: USDC, balance: 50_0000000n },
      { token: EURC, balance: 7n },
      { token: XLM_SAC, balance: 0n },
    ]);
    const calls = balanceCalls();
    expect(calls.map((c) => c.contractId)).toEqual([USDC, EURC, XLM_SAC]);
    for (const call of calls) {
      expect(call.args).toHaveLength(1);
      expect(Address.fromScVal(call.args[0] as never).toString()).toBe(TREASURY_ID);
    }
    // Read-only: no account is loaded.
    expect(rpc.simAuthModes.every((m) => m === undefined)).toBe(true);
  });

  it("reads the tokens in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const simulate = rpc.simulateTransaction.bind(rpc);
    rpc.simulateTransaction = async (...a) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await simulate(...a);
      } finally {
        inFlight--;
      }
    };
    await treasury().getBalances();
    expect(maxInFlight).toBe(3);
  });

  it("returns an empty list when the policy names no tokens", async () => {
    rpc.handlers.get_policy = () =>
      encodePolicy(makePolicy({ allowedTokens: [], departmentLimits: [] }));
    expect(await treasury().getBalances()).toEqual([]);
    expect(balanceCalls()).toHaveLength(0);
  });

  it("reads only the given tokens, de-duplicated, without reading the policy", async () => {
    expect(await treasury().getBalances({ tokens: [EURC, EURC, USDC] })).toEqual([
      { token: EURC, balance: 7n },
      { token: USDC, balance: 50_0000000n },
    ]);
    expect(rpc.calls.map((c) => c.method)).toEqual(["balance", "balance"]);
    await expect(treasury().getBalances({ tokens: [USDC, "nope"] })).rejects.toThrow(/tokens\[1\]/);
  });

  it("reports a failing token without failing the others", async () => {
    balances.delete(EURC); // the fake token traps with Error(Contract, #6)
    rpc.handlers.balance = ((handler) => (args, token) => {
      if (token === XLM_SAC) return enc.u32(1); // not an i128
      return handler(args, token);
    })(rpc.handlers.balance as NonNullable<typeof rpc.handlers.balance>);

    const [usdc, eurc, xlm] = await treasury().getBalances();
    expect(usdc).toEqual({ token: USDC, balance: 50_0000000n });

    expect(eurc?.token).toBe(EURC);
    expect(eurc?.balance).toBeUndefined();
    // A token's error code is not a treasury ContractError.
    expect(eurc?.error).toBeInstanceOf(SimulationError);
    expect(eurc?.error).not.toBeInstanceOf(ContractError);
    expect(eurc?.error?.message).toMatch(/Error\(Contract, #6\)/);

    expect(xlm?.error).toMatchObject({ code: "DECODE_ERROR" });
  });

  it("still fails as a whole when the policy cannot be read", async () => {
    rpc.handlers.get_policy = () => {
      throw new ContractFailure(1);
    };
    await expect(treasury().getBalances()).rejects.toBeInstanceOf(ContractError);
  });

  it("uses the pipeline's retries", async () => {
    const retrying = new StellarSafeClient({
      network: "testnet",
      rpc,
      retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const simulate = rpc.simulateTransaction.bind(rpc);
    let failures = 1;
    rpc.simulateTransaction = async (...a) => {
      if (failures-- > 0) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      return simulate(...a);
    };
    expect(await retrying.treasury(TREASURY_ID).getBalances({ tokens: [USDC] })).toEqual([
      { token: USDC, balance: 50_0000000n },
    ]);
  });

  it("rejects as a whole when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      treasury().getBalances({ tokens: [USDC], signal: ac.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("is included in the snapshot, with failures reported per token", async () => {
    balances.delete(XLM_SAC);
    rpc.simLedgers = [1000, 1000, 1000, 1000, 1002];
    const snap = await treasury().getSnapshot();
    expect(snap.balances.map((b) => [b.token, b.balance])).toEqual([
      [USDC, 50_0000000n],
      [EURC, 7n],
      [XLM_SAC, undefined],
    ]);
    expect(snap.balances[2]?.error).toBeInstanceOf(SimulationError);
    expect(snap.ledger).toBe(1002);
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

describe("read-your-writes (minLedger)", () => {
  it("re-simulates until the RPC node reaches minLedger", async () => {
    rpc.simLedgers = [998, 999];
    const p = await treasury().getProposal(1n, { minLedger: 1000 });
    expect(p.id).toBe(1n);
    expect(rpc.calls.filter((c) => c.method === "get_proposal")).toHaveLength(3);
  });

  it("does not wait when no minLedger is given", async () => {
    rpc.simLedgers = [5];
    await treasury().getPolicy();
    expect(rpc.calls).toHaveLength(1);
  });

  it("applies to snapshots", async () => {
    rpc.simLedgers = [999];
    const snap = await treasury().getSnapshot({ minLedger: 1000 });
    expect(snap.ledger).toBe(1000);
  });

  it("gives up after minLedgerTimeoutMs", async () => {
    rpc.simLedgers = Array(50).fill(1);
    await expect(
      treasury().getPolicy({ minLedger: 1000, minLedgerTimeoutMs: 1 }),
    ).rejects.toMatchObject({ code: "RPC_ERROR", message: expect.stringMatching(/behind/) });
  });
});

describe("session consistency", () => {
  it("reads after a write wait for the write's ledger automatically", async () => {
    const res = await (
      await treasury().approvePayment({ approver: APPROVER.publicKey(), proposalId: 1n })
    ).signAndSubmit(keypairSigner(APPROVER), { pollIntervalMs: 1 });
    expect(res.ledger).toBe(1001);
    rpc.simLedgers = [1000]; // a lagging node answers first
    const before = rpc.calls.length;
    await treasury().getProposal(1n);
    expect(rpc.calls.length - before).toBe(2);
  });

  it("never reuses a sequence number when the RPC returns a stale account", async () => {
    // The fake always reports sequence 100, like a node that missed our last transaction.
    const signer = keypairSigner(APPROVER);
    const first = await treasury().approvePayment({
      approver: APPROVER.publicKey(),
      proposalId: 1n,
    });
    await first.signAndSubmit(signer, { pollIntervalMs: 1 });
    const second = await treasury().revokeApproval({
      approver: APPROVER.publicKey(),
      proposalId: 1n,
    });
    expect(first.transaction.sequence).toBe("101");
    expect(second.transaction.sequence).toBe("102");
  });
});
