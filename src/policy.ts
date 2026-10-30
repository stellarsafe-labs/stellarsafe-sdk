/**
 * Pure, offline evaluation of StellarSafe policies.
 *
 * These helpers mirror the contract's rules so applications can explain
 * *why* a payment would fail before spending fees on it. They are advisory:
 * **the contract is the only authority**. Always simulate before submitting —
 * the SDK does this automatically for every write.
 *
 * @module
 */
import type { ContractErrorName } from "./errors.js";
import { ValidationError } from "./errors.js";
import type { Member, PaymentRequest, PolicyConfig, Proposal, SpendingPeriod } from "./types.js";
import { assertAddress, assertI128, assertSymbol, assertU32, assertU64 } from "./validation.js";

/**
 * Number of approvals a payment of `amount` requires: the `approvals` of the
 * threshold tier with the largest `minAmount <= amount`, or
 * `defaultApprovals` if no tier matches.
 */
export function requiredApprovals(policy: PolicyConfig, amount: bigint): number {
  let best: { minAmount: bigint; approvals: number } | undefined;
  for (const tier of policy.thresholds) {
    if (amount >= tier.minAmount && (best === undefined || tier.minAmount > best.minAmount)) {
      best = tier;
    }
  }
  return best?.approvals ?? policy.defaultApprovals;
}

/** Index of the accounting period containing `timestamp` (Unix seconds). */
export function periodIndex(period: SpendingPeriod, timestamp: bigint): bigint {
  if (period.length <= 0n) {
    throw new ValidationError("period.length must be greater than zero");
  }
  if (timestamp < period.anchor) return 0n;
  return (timestamp - period.anchor) / period.length;
}

/** Start and end (exclusive) Unix seconds of the period containing `timestamp`. */
export function periodBounds(
  period: SpendingPeriod,
  timestamp: bigint,
): { index: bigint; start: bigint; end: bigint } {
  const index = periodIndex(period, timestamp);
  const start = period.anchor + index * period.length;
  return { index, start, end: start + period.length };
}

/** Spending limit for a department and token, or `undefined` if none is configured. */
export function findDepartmentLimit(
  policy: PolicyConfig,
  department: string,
  token: string,
): bigint | undefined {
  return policy.departmentLimits.find((l) => l.department === department && l.token === token)
    ?.limit;
}

/**
 * Lifecycle state of a proposal from the caller's point of view.
 *
 * - `pending`   — collecting approvals
 * - `ready`     — has enough approvals and can be executed
 * - `stale`     — the policy changed since proposal; approvals are void and it cannot execute
 * - `expired`   — ledger time is past `expiresAt`
 * - `executed`  — paid out
 * - `cancelled` — withdrawn
 */
export type ProposalState = "pending" | "ready" | "stale" | "expired" | "executed" | "cancelled";

/**
 * Derive a proposal's state.
 *
 * @param now - current ledger time in Unix seconds. Prefer ledger time over
 *   wall-clock time; they can differ by several seconds.
 * @param currentPolicyVersion - version of the policy currently in force.
 */
export function getProposalState(
  proposal: Proposal,
  now: bigint,
  currentPolicyVersion: number,
): ProposalState {
  if (proposal.status === "Executed") return "executed";
  if (proposal.status === "Cancelled") return "cancelled";
  if (now > proposal.expiresAt) return "expired";
  if (proposal.policyVersion !== currentPolicyVersion) return "stale";
  return proposal.approvals.length >= proposal.requiredApprovals ? "ready" : "pending";
}

/** Whether `address` may approve a proposal right now (role and not yet approved). */
export function canApprove(
  proposal: Proposal,
  members: readonly Member[],
  address: string,
): boolean {
  const member = members.find((m) => m.address === address);
  if (!member || member.role === "Proposer") return false;
  return !proposal.approvals.includes(address);
}

/** A rule a payment would break, named after the contract error it would trigger. */
export interface PolicyViolation {
  readonly code: ContractErrorName;
  readonly message: string;
}

/** Context for {@link checkPayment}. */
export interface CheckPaymentContext {
  /** Current ledger time (Unix seconds). */
  readonly now: bigint;
  /**
   * Amount already executed for this department and token in the current
   * period (see `TreasuryClient.getSpending`). Defaults to `0n`.
   */
  readonly spent?: bigint;
}

/**
 * List every policy rule `request` would violate. An empty array means the
 * payment passes all checks the SDK can perform offline.
 */
export function checkPayment(
  policy: PolicyConfig,
  request: PaymentRequest,
  ctx: CheckPaymentContext,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const spent = ctx.spent ?? 0n;

  if (request.amount <= 0n) {
    violations.push({ code: "InvalidAmount", message: "Amount must be greater than zero." });
  }
  if (policy.allowedTokens.length > 0 && !policy.allowedTokens.includes(request.token)) {
    violations.push({ code: "TokenNotAllowed", message: `Token ${request.token} is not allowed.` });
  }
  if (policy.recipientAllowlistEnabled && !policy.allowedRecipients.includes(request.recipient)) {
    violations.push({
      code: "RecipientNotAllowed",
      message: `Recipient ${request.recipient} is not on the allowlist.`,
    });
  }
  if (request.expiresAt <= ctx.now) {
    violations.push({ code: "InvalidExpiry", message: "Expiry must be in the future." });
  } else if (request.expiresAt - ctx.now > policy.maxProposalTtl) {
    violations.push({
      code: "InvalidExpiry",
      message: `Expiry exceeds the maximum proposal lifetime of ${policy.maxProposalTtl} seconds.`,
    });
  }
  const limit = findDepartmentLimit(policy, request.department, request.token);
  if (limit === undefined) {
    violations.push({
      code: "SpendingLimitExceeded",
      message: `Department "${request.department}" has no spending limit for this token.`,
    });
  } else if (request.amount > 0n && spent + request.amount > limit) {
    violations.push({
      code: "SpendingLimitExceeded",
      message: `Payment would bring period spending to ${spent + request.amount}, above the limit of ${limit}.`,
    });
  }
  return violations;
}

/**
 * Validate a policy config before sending it to `set_policy`.
 *
 * @param approverCount - optional number of members with the Approver or Admin
 *   role; when given, thresholds that could never be met are rejected.
 * @throws {ValidationError} describing the first problem found.
 */
export function validatePolicyConfig(config: PolicyConfig, approverCount?: number): void {
  assertU32(config.defaultApprovals, "defaultApprovals");
  if (config.defaultApprovals < 1) {
    throw new ValidationError("defaultApprovals must be at least 1");
  }
  const seenMin = new Set<bigint>();
  config.thresholds.forEach((t, i) => {
    assertI128(t.minAmount, `thresholds[${i}].minAmount`, { positive: true });
    assertU32(t.approvals, `thresholds[${i}].approvals`);
    if (t.approvals < 1) throw new ValidationError(`thresholds[${i}].approvals must be at least 1`);
    if (seenMin.has(t.minAmount)) {
      throw new ValidationError(`thresholds[${i}].minAmount ${t.minAmount} is duplicated`);
    }
    seenMin.add(t.minAmount);
  });
  if (approverCount !== undefined) {
    const max = Math.max(config.defaultApprovals, ...config.thresholds.map((t) => t.approvals));
    if (max > approverCount) {
      throw new ValidationError(
        `policy requires up to ${max} approvals but the treasury has only ${approverCount} approvers`,
      );
    }
  }
  config.allowedRecipients.forEach((a, i) => {
    assertAddress(a, `allowedRecipients[${i}]`);
  });
  config.allowedTokens.forEach((a, i) => {
    assertAddress(a, `allowedTokens[${i}]`);
  });
  const seenLimit = new Set<string>();
  config.departmentLimits.forEach((l, i) => {
    assertSymbol(l.department, `departmentLimits[${i}].department`);
    assertAddress(l.token, `departmentLimits[${i}].token`);
    assertI128(l.limit, `departmentLimits[${i}].limit`);
    if (l.limit < 0n)
      throw new ValidationError(`departmentLimits[${i}].limit must not be negative`);
    const key = `${l.department}/${l.token}`;
    if (seenLimit.has(key)) {
      throw new ValidationError(`departmentLimits[${i}] duplicates department/token ${key}`);
    }
    seenLimit.add(key);
  });
  assertU64(config.period.anchor, "period.anchor");
  assertU64(config.period.length, "period.length");
  if (config.period.length === 0n)
    throw new ValidationError("period.length must be greater than zero");
  assertU64(config.maxProposalTtl, "maxProposalTtl");
  if (config.maxProposalTtl === 0n)
    throw new ValidationError("maxProposalTtl must be greater than zero");
}

/** Fixed-length "month" used by {@link monthlyPeriod}: 30 days. */
export const THIRTY_DAYS_SECONDS = 30n * 24n * 60n * 60n;

/** Convenience: a 30-day spending period starting at `anchor` (Unix seconds). */
export function monthlyPeriod(anchor: bigint): SpendingPeriod {
  return { anchor, length: THIRTY_DAYS_SECONDS };
}
