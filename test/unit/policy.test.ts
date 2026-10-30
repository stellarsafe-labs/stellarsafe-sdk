import { describe, expect, it } from "vitest";
import {
  canApprove,
  checkPayment,
  getProposalState,
  monthlyPeriod,
  type PolicyConfig,
  periodBounds,
  periodIndex,
  requiredApprovals,
  THIRTY_DAYS_SECONDS,
  ValidationError,
  validatePolicyConfig,
} from "../../src/index.js";
import {
  ADMIN,
  APPROVER,
  makePolicy,
  makeProposal,
  NOW,
  PROPOSER,
  RECIPIENT,
  USDC,
} from "../helpers/fixtures.js";

const policy = makePolicy({
  thresholds: [
    { minAmount: 5_000n, approvals: 2 },
    { minAmount: 50_000n, approvals: 3 },
  ],
});

describe("requiredApprovals", () => {
  it.each([
    [1n, 1],
    [4_999n, 1],
    [5_000n, 2],
    [49_999n, 2],
    [50_000n, 3],
    [10n ** 20n, 3],
  ])("amount %s needs %i", (amount, n) => {
    expect(requiredApprovals(policy, amount)).toBe(n);
  });

  it("picks the highest matching tier regardless of order", () => {
    const reversed = { ...policy, thresholds: [...policy.thresholds].reverse() };
    expect(requiredApprovals(reversed, 60_000n)).toBe(3);
  });
});

describe("periods", () => {
  const period = { anchor: 1_000n, length: 100n };
  it("computes index and bounds", () => {
    expect(periodIndex(period, 1_000n)).toBe(0n);
    expect(periodIndex(period, 1_099n)).toBe(0n);
    expect(periodIndex(period, 1_100n)).toBe(1n);
    expect(periodIndex(period, 500n)).toBe(0n);
    expect(periodBounds(period, 1_250n)).toEqual({ index: 2n, start: 1_200n, end: 1_300n });
  });

  it("rejects zero-length periods", () => {
    expect(() => periodIndex({ anchor: 0n, length: 0n }, 1n)).toThrow(ValidationError);
  });

  it("monthlyPeriod is 30 days", () => {
    expect(monthlyPeriod(5n)).toEqual({ anchor: 5n, length: THIRTY_DAYS_SECONDS });
  });
});

describe("getProposalState", () => {
  it.each([
    [{}, "pending"],
    [{ approvals: [APPROVER.publicKey()] }, "ready"],
    [{ status: "Executed" as const }, "executed"],
    [{ status: "Cancelled" as const }, "cancelled"],
    [{ expiresAt: NOW - 1n }, "expired"],
    [{ policyVersion: 0 }, "stale"],
  ])("case %# → %s", (overrides, state) => {
    expect(getProposalState(makeProposal(overrides), NOW, 1)).toBe(state);
  });

  it("is still valid at exactly expiresAt", () => {
    expect(getProposalState(makeProposal({ expiresAt: NOW }), NOW, 1)).toBe("pending");
  });
});

describe("canApprove", () => {
  const members = [
    { address: ADMIN.publicKey(), role: "Admin" as const },
    { address: APPROVER.publicKey(), role: "Approver" as const },
    { address: PROPOSER.publicKey(), role: "Proposer" as const },
  ];
  it("requires approver role and no prior approval", () => {
    const p = makeProposal({ approvals: [ADMIN.publicKey()] });
    expect(canApprove(p, members, APPROVER.publicKey())).toBe(true);
    expect(canApprove(p, members, ADMIN.publicKey())).toBe(false);
    expect(canApprove(p, members, PROPOSER.publicKey())).toBe(false);
    expect(canApprove(p, members, RECIPIENT)).toBe(false);
  });
});

describe("checkPayment", () => {
  const ok = {
    token: USDC,
    recipient: RECIPIENT,
    amount: 1_000n,
    department: "ops",
    memo: "",
    expiresAt: NOW + 3_600n,
  };

  it("passes a compliant payment", () => {
    expect(checkPayment(policy, ok, { now: NOW })).toEqual([]);
  });

  it.each([
    [{ amount: 0n }, "InvalidAmount"],
    [{ token: ADMIN.publicKey() }, "TokenNotAllowed"],
    [{ recipient: ADMIN.publicKey() }, "RecipientNotAllowed"],
    [{ expiresAt: NOW }, "InvalidExpiry"],
    [{ expiresAt: NOW + 604_801n }, "InvalidExpiry"],
    [{ department: "marketing" }, "SpendingLimitExceeded"],
    [{ amount: 10_000_000_001n }, "SpendingLimitExceeded"],
  ])("case %# → %s", (overrides, code) => {
    const codes = checkPayment(policy, { ...ok, ...overrides }, { now: NOW }).map((v) => v.code);
    expect(codes).toContain(code);
  });

  it("accounts for already-spent amounts", () => {
    const v = checkPayment(policy, ok, { now: NOW, spent: 10_000_000_000n });
    expect(v.map((x) => x.code)).toEqual(["SpendingLimitExceeded"]);
  });

  it("skips allowlists when disabled or empty", () => {
    const open = makePolicy({ recipientAllowlistEnabled: false, allowedTokens: [] });
    expect(checkPayment(open, { ...ok, recipient: ADMIN.publicKey() }, { now: NOW })).toEqual([]);
  });
});

describe("validatePolicyConfig", () => {
  const { version: _v, updatedAt: _u, ...base } = makePolicy();
  const valid: PolicyConfig = base;

  it("accepts a valid config", () => {
    expect(() => validatePolicyConfig(valid)).not.toThrow();
    expect(() => validatePolicyConfig(valid, 2)).not.toThrow();
  });

  it.each<[string, Partial<PolicyConfig>]>([
    ["defaultApprovals 0", { defaultApprovals: 0 }],
    ["threshold approvals 0", { thresholds: [{ minAmount: 1n, approvals: 0 }] }],
    ["threshold minAmount 0", { thresholds: [{ minAmount: 0n, approvals: 1 }] }],
    [
      "duplicate thresholds",
      {
        thresholds: [
          { minAmount: 1n, approvals: 1 },
          { minAmount: 1n, approvals: 2 },
        ],
      },
    ],
    ["bad recipient", { allowedRecipients: ["nope"] }],
    ["bad token", { allowedTokens: ["nope"] }],
    ["bad department", { departmentLimits: [{ department: "a b", token: USDC, limit: 1n }] }],
    ["negative limit", { departmentLimits: [{ department: "ops", token: USDC, limit: -1n }] }],
    [
      "duplicate limit",
      {
        departmentLimits: [
          { department: "ops", token: USDC, limit: 1n },
          { department: "ops", token: USDC, limit: 2n },
        ],
      },
    ],
    ["zero period", { period: { anchor: 0n, length: 0n } }],
    ["zero ttl", { maxProposalTtl: 0n }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validatePolicyConfig({ ...valid, ...overrides })).toThrow(ValidationError);
  });

  it("rejects unreachable thresholds when approver count is known", () => {
    expect(() => validatePolicyConfig(valid, 1)).toThrow(/only 1 approvers/);
  });
});
