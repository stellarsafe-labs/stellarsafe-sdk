import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { Policy, Proposal } from "../../src/index.js";

/** Deterministic keypairs so test output is stable. */
export function keypair(seed: number): Keypair {
  return Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(seed));
}

export function contractId(seed: number): string {
  return StrKey.encodeContract(new Uint8Array(32).fill(seed));
}

export const ADMIN = keypair(1);
export const APPROVER = keypair(2);
export const PROPOSER = keypair(3);
export const RECIPIENT = keypair(4).publicKey();
export const TREASURY_ID = contractId(10);
export const USDC = contractId(11);

export const NOW = 1_800_000_000n;

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    updatedAt: NOW - 100n,
    defaultApprovals: 1,
    thresholds: [{ minAmount: 5_000_000_000n, approvals: 2 }],
    recipientAllowlistEnabled: true,
    allowedRecipients: [RECIPIENT],
    allowedTokens: [USDC],
    departmentLimits: [{ department: "ops", token: USDC, limit: 10_000_000_000n }],
    period: { anchor: 1_700_000_000n, length: 2_592_000n },
    maxProposalTtl: 604_800n,
    ...overrides,
  };
}

export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1n,
    proposer: PROPOSER.publicKey(),
    token: USDC,
    recipient: RECIPIENT,
    amount: 1_000_000_000n,
    department: "ops",
    memo: "Invoice #42",
    expiresAt: NOW + 86_400n,
    createdAt: NOW - 60n,
    policyVersion: 1,
    requiredApprovals: 1,
    approvals: [],
    status: "Pending",
    closedAt: undefined,
    ...overrides,
  };
}
