/**
 * Domain types mirroring the StellarSafe treasury contract's data model.
 *
 * Conventions:
 * - Addresses are strkey strings (`G…` accounts, `C…` contracts).
 * - Token amounts are `bigint` in the token's smallest unit (i128 on-chain).
 *   Use {@link parseAmount} / {@link formatAmount} to convert from decimals.
 * - Timestamps are `bigint` Unix seconds (u64 on-chain), matching ledger time.
 * - Proposal ids are `bigint` (u64 on-chain).
 *
 * @module
 */

/** A Stellar address in strkey form (`G…` or `C…`). */
export type Address = string;

/**
 * Member roles. Roles are cumulative in the contract:
 * - `Proposer` may create payment proposals.
 * - `Approver` may additionally approve, revoke approvals and execute.
 * - `Admin` may additionally manage members and policy.
 */
export type Role = "Proposer" | "Approver" | "Admin";

/** All roles, lowest privilege first. */
export const ROLES: readonly Role[] = Object.freeze(["Proposer", "Approver", "Admin"]);

/** A treasury member. */
export interface Member {
  readonly address: Address;
  readonly role: Role;
}

/**
 * Approval threshold tier: payments with `amount >= minAmount` need at least
 * `approvals` distinct approvals. The highest matching tier applies.
 */
export interface ThresholdRule {
  readonly minAmount: bigint;
  readonly approvals: number;
}

/** Per-department, per-token spending limit for one accounting period. */
export interface DepartmentLimit {
  /** Department identifier, a Soroban `Symbol` (`[a-zA-Z0-9_]{1,32}`). */
  readonly department: string;
  /** Token contract address (e.g. the USDC Stellar Asset Contract). */
  readonly token: Address;
  /** Maximum total executed amount per period, in the token's smallest unit. */
  readonly limit: bigint;
}

/**
 * Fixed-length accounting period. Period index for a ledger timestamp `t` is
 * `floor((t - anchor) / length)`; spending counters reset when the index changes.
 *
 * Calendar months cannot be computed cheaply on-chain, so "monthly" limits use
 * a fixed length (e.g. 30 days = 2_592_000 seconds) from a chosen anchor.
 */
export interface SpendingPeriod {
  /** Unix seconds at which period 0 starts. */
  readonly anchor: bigint;
  /** Period length in seconds (> 0). */
  readonly length: bigint;
}

/** Policy fields set by admins via `set_policy`. */
export interface PolicyConfig {
  /** Approvals required when no {@link ThresholdRule} matches. Must be >= 1. */
  readonly defaultApprovals: number;
  /** Additional tiers for larger payments. */
  readonly thresholds: readonly ThresholdRule[];
  /** When `true`, payments may only go to {@link allowedRecipients}. */
  readonly recipientAllowlistEnabled: boolean;
  readonly allowedRecipients: readonly Address[];
  /** Tokens the treasury may pay out. Empty means any token. */
  readonly allowedTokens: readonly Address[];
  /** Spending limits. Departments without a limit for a token cannot spend it. */
  readonly departmentLimits: readonly DepartmentLimit[];
  readonly period: SpendingPeriod;
  /** Maximum lifetime of a proposal (expires_at - created_at), in seconds. */
  readonly maxProposalTtl: bigint;
}

/** Policy as stored on-chain: config plus contract-assigned version metadata. */
export interface Policy extends PolicyConfig {
  /** Monotonic version. Bumped on every `set_policy`; approvals on older versions are void. */
  readonly version: number;
  /** Ledger timestamp of the last policy change. */
  readonly updatedAt: bigint;
}

/** Stored proposal status. Expiry is derived from `expiresAt`, see {@link getProposalState}. */
export type ProposalStatus = "Pending" | "Executed" | "Cancelled";

/** Input for `propose_payment`. */
export interface PaymentRequest {
  readonly token: Address;
  readonly recipient: Address;
  /** Amount in the token's smallest unit. Must be > 0. */
  readonly amount: bigint;
  readonly department: string;
  /** Free-form description stored on-chain (max 256 bytes). */
  readonly memo: string;
  /** Unix seconds after which the proposal can no longer be approved or executed. */
  readonly expiresAt: bigint;
}

/** A payment proposal as stored on-chain. */
export interface Proposal extends PaymentRequest {
  readonly id: bigint;
  readonly proposer: Address;
  readonly createdAt: bigint;
  /** Policy version in force when the proposal was created. */
  readonly policyVersion: number;
  /** Approvals required, fixed at proposal time from the policy thresholds. */
  readonly requiredApprovals: number;
  /** Distinct members who approved, in approval order. */
  readonly approvals: readonly Address[];
  readonly status: ProposalStatus;
  /** Ledger timestamp of execution or cancellation, if any. */
  readonly closedAt: bigint | undefined;
}

/** Treasury-wide configuration. */
export interface TreasuryConfig {
  /** Display name set at initialization. */
  readonly name: string;
  /** Number of proposals ever created (next id is `proposalCount + 1`). */
  readonly proposalCount: bigint;
  /** Contract interface version, for compatibility checks. */
  readonly interfaceVersion: number;
}

/** Amount spent by a department for a token in the current period. */
export interface SpendingStatus {
  readonly department: string;
  readonly token: Address;
  readonly periodIndex: bigint;
  readonly spent: bigint;
  /** Limit from the current policy, or `0n` if none is configured. */
  readonly limit: bigint;
  /** `max(limit - spent, 0)`. */
  readonly remaining: bigint;
}

/** Everything needed to render a treasury, read in one call. */
export interface TreasurySnapshot {
  readonly contractId: Address;
  readonly config: TreasuryConfig;
  readonly policy: Policy;
  readonly members: readonly Member[];
  readonly pendingProposals: readonly Proposal[];
  /** Ledger sequence the snapshot was simulated against. */
  readonly ledger: number;
}
