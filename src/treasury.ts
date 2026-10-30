/**
 * Typed client for a single StellarSafe treasury contract.
 *
 * @module
 */
import type { xdr } from "@stellar/stellar-sdk";
import {
  dec,
  decodeMember,
  decodePolicy,
  decodeProposal,
  decodeTreasuryConfig,
  enc,
  encodePaymentRequest,
  encodePolicyConfig,
  encodeRole,
} from "./codec.js";
import { ValidationError } from "./errors.js";
import { findDepartmentLimit, validatePolicyConfig } from "./policy.js";
import type { TransactionSigner } from "./signer.js";
import type {
  PreparedTransaction,
  PrepareOptions,
  ReadConsistency,
  SubmitOptions,
  TransactionPipeline,
  TransactionResult,
} from "./transaction.js";
import type {
  Address,
  Member,
  PaymentRequest,
  Policy,
  PolicyConfig,
  Proposal,
  Role,
  SpendingStatus,
  TreasuryConfig,
  TreasurySnapshot,
} from "./types.js";
import { ROLES } from "./types.js";
import {
  assertAccountId,
  assertAddress,
  assertI128,
  assertMemo,
  assertSymbol,
  assertU64,
  toU64,
} from "./validation.js";

/** Contract interface version this SDK targets. See `docs/CONTRACT_INTERFACE.md`. */
export const SUPPORTED_INTERFACE_VERSION = 1;

/** Options accepted by every write method. `source` defaults to the acting member. */
export type WriteOptions = Omit<PrepareOptions, "source"> & { readonly source?: string };

/** Options accepted by every read method. */
export interface ReadOptions extends ReadConsistency {
  readonly signal?: AbortSignal;
}

/** A proposal id as `bigint`, or a safe-integer `number`/decimal `string`. */
export type ProposalId = bigint | number | string;

const decodeVoid = (): void => undefined;

/**
 * Client for one treasury contract.
 *
 * - **Reads** (`get*`) simulate a call and return decoded data. They need no
 *   account or signature.
 * - **Writes** (`propose*`, `approve*`, …) return a {@link PreparedTransaction}:
 *   simulated, fee-estimated and ready to sign. Nothing is sent until you call
 *   `sign`/`submit`/`signAndSubmit`.
 *
 * Use {@link connect} for a signer-bound variant whose writes sign and submit
 * immediately.
 */
export class TreasuryClient {
  /** @internal */
  constructor(
    private readonly pipeline: TransactionPipeline,
    /** Treasury contract address (`C…`). */
    readonly contractId: Address,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Treasury name, proposal counter and interface version. */
  async getConfig(opts?: ReadOptions): Promise<TreasuryConfig> {
    return this.read("get_config", [], (v) => decodeTreasuryConfig(v), opts);
  }

  /** The policy currently in force. */
  async getPolicy(opts?: ReadOptions): Promise<Policy> {
    return this.read("get_policy", [], (v) => decodePolicy(v), opts);
  }

  /** All members and their roles. */
  async getMembers(opts?: ReadOptions): Promise<Member[]> {
    return this.read("get_members", [], (v) => dec.vec(v, "members", decodeMember), opts);
  }

  /** Role of `address`, or `undefined` if it is not a member. */
  async getRole(address: Address, opts?: ReadOptions): Promise<Role | undefined> {
    assertAddress(address, "address");
    return this.read(
      "get_role",
      [enc.address(address)],
      (v) => dec.option(v, "role", (x, p) => dec.unitEnum(x, p, ROLES)),
      opts,
    );
  }

  /** A proposal by id. Throws `ContractError` (`ProposalNotFound`) if it does not exist. */
  async getProposal(id: ProposalId, opts?: ReadOptions): Promise<Proposal> {
    const proposalId = toU64(id, "proposalId");
    return this.read("get_proposal", [enc.u64(proposalId)], (v) => decodeProposal(v), opts);
  }

  /** All proposals with stored status `Pending` (including expired and stale ones). */
  async getPendingProposals(opts?: ReadOptions): Promise<Proposal[]> {
    return this.read(
      "get_pending_proposals",
      [],
      (v) => dec.vec(v, "proposals", decodeProposal),
      opts,
    );
  }

  /**
   * Page through all proposals by id, oldest first.
   *
   * - `start` — first proposal id to include (ids start at 1). Default 1.
   * - `limit` — page size, 1–100. Default 50.
   */
  async listProposals(
    { start = 1n, limit = 50 }: { start?: ProposalId; limit?: number } = {},
    opts?: ReadOptions,
  ): Promise<Proposal[]> {
    const from = toU64(start, "start");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError(`limit must be an integer between 1 and 100, got ${limit}`);
    }
    return this.read(
      "get_proposals",
      [enc.u64(from), enc.u32(limit)],
      (v) => dec.vec(v, "proposals", decodeProposal),
      opts,
    );
  }

  /** Spending so far in the current period for a department and token, with the policy limit. */
  async getSpending(
    department: string,
    token: Address,
    opts?: ReadOptions,
  ): Promise<SpendingStatus> {
    assertSymbol(department, "department");
    assertAddress(token, "token");
    const [spend, policy] = await Promise.all([
      this.read(
        "get_spent",
        [enc.symbol(department), enc.address(token)],
        (v) => {
          const s = dec.struct(v, "spent");
          return {
            periodIndex: s.field("period_index", dec.u64),
            spent: s.field("spent", dec.i128),
          };
        },
        opts,
      ),
      this.getPolicy(opts),
    ]);
    const limit = findDepartmentLimit(policy, department, token) ?? 0n;
    const remaining = limit > spend.spent ? limit - spend.spent : 0n;
    return { department, token, ...spend, limit, remaining };
  }

  /**
   * Config, policy, members and pending proposals in one call.
   *
   * The four reads run in parallel and may observe consecutive ledgers;
   * `ledger` is the newest one seen.
   */
  async getSnapshot(opts?: ReadOptions): Promise<TreasurySnapshot> {
    const [config, policy, members, pending] = await Promise.all([
      this.readWithLedger("get_config", [], (v) => decodeTreasuryConfig(v), opts),
      this.readWithLedger("get_policy", [], (v) => decodePolicy(v), opts),
      this.readWithLedger("get_members", [], (v) => dec.vec(v, "members", decodeMember), opts),
      this.readWithLedger(
        "get_pending_proposals",
        [],
        (v) => dec.vec(v, "proposals", decodeProposal),
        opts,
      ),
    ]);
    return {
      contractId: this.contractId,
      config: config.result,
      policy: policy.result,
      members: members.result,
      pendingProposals: pending.result,
      ledger: Math.max(
        config.latestLedger,
        policy.latestLedger,
        members.latestLedger,
        pending.latestLedger,
      ),
    };
  }

  /**
   * Check the deployed contract speaks the interface version this SDK targets.
   *
   * @throws {ValidationError} if the versions differ.
   */
  async assertCompatible(opts?: ReadOptions): Promise<void> {
    const { interfaceVersion } = await this.getConfig(opts);
    if (interfaceVersion !== SUPPORTED_INTERFACE_VERSION) {
      throw new ValidationError(
        `Treasury ${this.contractId} implements interface v${interfaceVersion}, ` +
          `but this SDK supports v${SUPPORTED_INTERFACE_VERSION}. Upgrade @stellarsafe/sdk.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Add a member. Caller must be an Admin. */
  async addMember(
    params: { caller: Address; member: Address; role: Role },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    assertAccountId(params.caller, "caller");
    assertAddress(params.member, "member");
    assertRole(params.role, "role");
    return this.write(
      "add_member",
      [enc.address(params.caller), enc.address(params.member), encodeRole(params.role)],
      decodeVoid,
      params.caller,
      opts,
    );
  }

  /**
   * Remove a member. Caller must be an Admin. The contract removes the
   * member's approvals from pending proposals and refuses to remove the last Admin.
   */
  async removeMember(
    params: { caller: Address; member: Address },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    assertAccountId(params.caller, "caller");
    assertAddress(params.member, "member");
    return this.write(
      "remove_member",
      [enc.address(params.caller), enc.address(params.member)],
      decodeVoid,
      params.caller,
      opts,
    );
  }

  /**
   * Replace the policy. Caller must be an Admin. Bumps the policy version,
   * which voids approvals on all pending proposals.
   *
   * The config is validated locally first; see {@link validatePolicyConfig}.
   *
   * @returns prepared transaction whose result is the new policy version.
   */
  async setPolicy(
    params: { caller: Address; policy: PolicyConfig },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<number>> {
    assertAccountId(params.caller, "caller");
    validatePolicyConfig(params.policy);
    return this.write(
      "set_policy",
      [enc.address(params.caller), encodePolicyConfig(params.policy)],
      (v) => dec.u32(v, "version"),
      params.caller,
      opts,
    );
  }

  /**
   * Create a payment proposal. Caller must be a member (any role).
   *
   * @returns prepared transaction whose result is the new proposal id.
   */
  async proposePayment(
    params: PaymentRequest & { proposer: Address },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<bigint>> {
    const { proposer, ...request } = params;
    assertAccountId(proposer, "proposer");
    assertPaymentRequest(request);
    return this.write(
      "propose_payment",
      [enc.address(proposer), encodePaymentRequest(request)],
      (v) => dec.u64(v, "proposalId"),
      proposer,
      opts,
    );
  }

  /** Approve a proposal. Caller must be an Approver or Admin who has not yet approved. */
  async approvePayment(
    params: { approver: Address; proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    return this.proposalAction(
      "approve_payment",
      params.approver,
      "approver",
      params.proposalId,
      opts,
    );
  }

  /** Withdraw a previously given approval. */
  async revokeApproval(
    params: { approver: Address; proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    return this.proposalAction(
      "revoke_approval",
      params.approver,
      "approver",
      params.proposalId,
      opts,
    );
  }

  /**
   * Execute an approved proposal: re-checks every policy rule on-chain and
   * transfers the tokens. Caller must be an Approver or Admin.
   */
  async executePayment(
    params: { executor: Address; proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    return this.proposalAction(
      "execute_payment",
      params.executor,
      "executor",
      params.proposalId,
      opts,
    );
  }

  /** Cancel a pending proposal. Caller must be the proposer or an Admin. */
  async cancelPayment(
    params: { caller: Address; proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    return this.proposalAction("cancel_payment", params.caller, "caller", params.proposalId, opts);
  }

  /**
   * Bind a signer: writes on the returned object omit the acting member
   * (it is `signer.address`), and sign and submit immediately.
   *
   * @example
   * ```ts
   * const safe = client.treasury(id).connect(keypairSigner(secret));
   * const { result: proposalId } = await safe.proposePayment({ ... });
   * await safe.approvePayment({ proposalId });
   * ```
   */
  connect(signer: TransactionSigner, submitOptions?: SubmitOptions): ConnectedTreasury {
    return new ConnectedTreasury(this, signer, submitOptions);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async read<T>(
    method: string,
    args: xdr.ScVal[],
    decode: (v: xdr.ScVal) => T,
    opts?: ReadOptions,
  ): Promise<T> {
    return (await this.readWithLedger(method, args, decode, opts)).result;
  }

  private readWithLedger<T>(
    method: string,
    args: xdr.ScVal[],
    decode: (v: xdr.ScVal) => T,
    opts: ReadOptions | undefined,
  ): Promise<{ result: T; latestLedger: number }> {
    return this.pipeline.read(this.contractId, method, args, decode, opts);
  }

  private write<T>(
    method: string,
    args: xdr.ScVal[],
    decode: (v: xdr.ScVal) => T,
    actor: Address,
    opts: WriteOptions = {},
  ): Promise<PreparedTransaction<T>> {
    return this.pipeline.prepare(this.contractId, method, args, decode, {
      ...opts,
      source: opts.source ?? actor,
    });
  }

  private proposalAction(
    method: string,
    actor: Address,
    field: string,
    id: ProposalId,
    opts?: WriteOptions,
  ): Promise<PreparedTransaction<void>> {
    assertAccountId(actor, field);
    const proposalId = toU64(id, "proposalId");
    return this.write(method, [enc.address(actor), enc.u64(proposalId)], decodeVoid, actor, opts);
  }
}

/**
 * A {@link TreasuryClient} bound to a signer. Write methods sign and submit
 * immediately and resolve once the transaction is confirmed.
 */
export class ConnectedTreasury {
  /** @internal */
  constructor(
    /** The underlying unbound client, for reads. */
    readonly client: TreasuryClient,
    readonly signer: TransactionSigner,
    private readonly submitOptions: SubmitOptions = {},
  ) {}

  get contractId(): Address {
    return this.client.contractId;
  }

  get address(): Address {
    return this.signer.address;
  }

  addMember(
    params: { member: Address; role: Role },
    opts?: WriteOptions,
  ): Promise<TransactionResult<void>> {
    return this.run(this.client.addMember({ caller: this.address, ...params }, opts));
  }

  removeMember(params: { member: Address }, opts?: WriteOptions): Promise<TransactionResult<void>> {
    return this.run(this.client.removeMember({ caller: this.address, ...params }, opts));
  }

  setPolicy(
    params: { policy: PolicyConfig },
    opts?: WriteOptions,
  ): Promise<TransactionResult<number>> {
    return this.run(this.client.setPolicy({ caller: this.address, ...params }, opts));
  }

  proposePayment(params: PaymentRequest, opts?: WriteOptions): Promise<TransactionResult<bigint>> {
    return this.run(this.client.proposePayment({ proposer: this.address, ...params }, opts));
  }

  approvePayment(
    params: { proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<TransactionResult<void>> {
    return this.run(this.client.approvePayment({ approver: this.address, ...params }, opts));
  }

  revokeApproval(
    params: { proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<TransactionResult<void>> {
    return this.run(this.client.revokeApproval({ approver: this.address, ...params }, opts));
  }

  executePayment(
    params: { proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<TransactionResult<void>> {
    return this.run(this.client.executePayment({ executor: this.address, ...params }, opts));
  }

  cancelPayment(
    params: { proposalId: ProposalId },
    opts?: WriteOptions,
  ): Promise<TransactionResult<void>> {
    return this.run(this.client.cancelPayment({ caller: this.address, ...params }, opts));
  }

  private async run<T>(prepared: Promise<PreparedTransaction<T>>): Promise<TransactionResult<T>> {
    return (await prepared).signAndSubmit(this.signer, this.submitOptions);
  }
}

export function assertRole(value: unknown, field: string): asserts value is Role {
  if (!(ROLES as readonly unknown[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${ROLES.join(", ")}, got ${String(value)}`);
  }
}

function assertPaymentRequest(r: PaymentRequest): void {
  assertAddress(r.token, "token");
  assertAddress(r.recipient, "recipient");
  assertI128(r.amount, "amount", { positive: true });
  assertSymbol(r.department, "department");
  assertMemo(r.memo, "memo");
  assertU64(r.expiresAt, "expiresAt");
}
