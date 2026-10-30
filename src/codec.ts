/**
 * Strict ScVal encoders/decoders for the StellarSafe contract types.
 *
 * Encoding follows the Soroban SDK `#[contracttype]` conventions:
 * - structs → `ScMap` keyed by field-name symbols, sorted by key
 * - unit enum variants → `ScVec[Symbol(variant)]`
 * - `Option<T>` → `ScVoid` or the value
 *
 * Decoders validate every field and throw {@link DecodeError} with the full
 * field path (e.g. `proposal.approvals[2]`) when the contract returns
 * something unexpected, instead of passing malformed data to the caller.
 *
 * @module
 */
import { nativeToScVal, Address as StellarAddress, scValToBigInt, xdr } from "@stellar/stellar-sdk";
import { DecodeError } from "./errors.js";
import type {
  DepartmentLimit,
  Member,
  PaymentRequest,
  Policy,
  PolicyConfig,
  Proposal,
  ProposalStatus,
  Role,
  SpendingPeriod,
  ThresholdRule,
  TreasuryConfig,
} from "./types.js";

type ScVal = xdr.ScVal;
type ScValOf<T extends ScVal["type"]> = Extract<ScVal, { type: T }>;

// ---------------------------------------------------------------------------
// Primitive encoders
// ---------------------------------------------------------------------------

export const enc = {
  u32: (v: number): ScVal => xdr.ScVal.scvU32(v),
  u64: (v: bigint): ScVal => xdr.ScVal.scvU64(v),
  i128: (v: bigint): ScVal => nativeToScVal(v, { type: "i128" }),
  bool: (v: boolean): ScVal => xdr.ScVal.scvBool(v),
  symbol: (v: string): ScVal => xdr.ScVal.scvSymbol(v),
  string: (v: string): ScVal => xdr.ScVal.scvString(v),
  address: (v: string): ScVal => StellarAddress.fromString(v).toScVal(),
  vec: <T>(items: readonly T[], encode: (item: T) => ScVal): ScVal =>
    xdr.ScVal.scvVec(items.map(encode)),
  option: <T>(value: T | undefined, encode: (item: T) => ScVal): ScVal =>
    value === undefined ? xdr.ScVal.scvVoid() : encode(value),
  unitEnum: (variant: string): ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]),
  /** Encode a struct as a symbol-keyed map with keys in sorted order. */
  struct: (fields: Record<string, ScVal>): ScVal =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map(
          (key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] as ScVal }),
        ),
    ),
};

// ---------------------------------------------------------------------------
// Primitive decoders
// ---------------------------------------------------------------------------

function expect<T extends ScVal["type"]>(val: ScVal, type: T, path: string): ScValOf<T> {
  if (val.type !== type) {
    throw new DecodeError(`${path}: expected ${type}, got ${val.type}`);
  }
  return val as ScValOf<T>;
}

export const dec = {
  u32: (v: ScVal, path: string): number => expect(v, "scvU32", path).u32,
  u64: (v: ScVal, path: string): bigint => expect(v, "scvU64", path).u64,
  i128: (v: ScVal, path: string): bigint => scValToBigInt(expect(v, "scvI128", path)),
  bool: (v: ScVal, path: string): boolean => expect(v, "scvBool", path).b,
  symbol: (v: ScVal, path: string): string => expect(v, "scvSymbol", path).sym.toString(),
  string: (v: ScVal, path: string): string => expect(v, "scvString", path).str.toString(),
  bytes: (v: ScVal, path: string): Uint8Array => expect(v, "scvBytes", path).bytes.value,
  address: (v: ScVal, path: string): string =>
    StellarAddress.fromScVal(expect(v, "scvAddress", path)).toString(),
  vec: <T>(v: ScVal, path: string, decode: (item: ScVal, path: string) => T): T[] =>
    (expect(v, "scvVec", path).vec ?? []).map((item, i) => decode(item, `${path}[${i}]`)),
  option: <T>(v: ScVal, path: string, decode: (item: ScVal, path: string) => T): T | undefined =>
    v.type === "scvVoid" ? undefined : decode(v, path),
  unitEnum: <T extends string>(v: ScVal, path: string, variants: readonly T[]): T => {
    const items = expect(v, "scvVec", path).vec ?? [];
    const [tag] = items;
    if (items.length !== 1 || tag === undefined) {
      throw new DecodeError(
        `${path}: expected unit enum variant, got vec of length ${items.length}`,
      );
    }
    const name = dec.symbol(tag, `${path}.tag`);
    if (!(variants as readonly string[]).includes(name)) {
      throw new DecodeError(
        `${path}: unknown variant "${name}", expected one of ${variants.join(", ")}`,
      );
    }
    return name as T;
  },
  /** Decode a symbol-keyed map into a field accessor that reports missing fields by path. */
  struct: (v: ScVal, path: string): StructReader => {
    const fields = new Map<string, ScVal>();
    for (const entry of expect(v, "scvMap", path).map ?? []) {
      fields.set(dec.symbol(entry.key, `${path}.<key>`), entry.val);
    }
    return {
      field<T>(name: string, decode: (item: ScVal, path: string) => T): T {
        const item = fields.get(name);
        if (item === undefined) {
          throw new DecodeError(`${path}: missing field "${name}"`);
        }
        return decode(item, `${path}.${name}`);
      },
    };
  },
};

interface StructReader {
  field<T>(name: string, decode: (item: ScVal, path: string) => T): T;
}

// ---------------------------------------------------------------------------
// Domain codecs
// ---------------------------------------------------------------------------

const ROLE_VARIANTS = ["Proposer", "Approver", "Admin"] as const satisfies readonly Role[];
const STATUS_VARIANTS = [
  "Pending",
  "Executed",
  "Cancelled",
] as const satisfies readonly ProposalStatus[];

export function encodeRole(role: Role): ScVal {
  return enc.unitEnum(role);
}

export function decodeRole(v: ScVal, path = "role"): Role {
  return dec.unitEnum(v, path, ROLE_VARIANTS);
}

export function decodeMember(v: ScVal, path = "member"): Member {
  const s = dec.struct(v, path);
  return { address: s.field("address", dec.address), role: s.field("role", decodeRole) };
}

function encodeThreshold(t: ThresholdRule): ScVal {
  return enc.struct({ min_amount: enc.i128(t.minAmount), approvals: enc.u32(t.approvals) });
}

function decodeThreshold(v: ScVal, path: string): ThresholdRule {
  const s = dec.struct(v, path);
  return { minAmount: s.field("min_amount", dec.i128), approvals: s.field("approvals", dec.u32) };
}

function encodeDepartmentLimit(l: DepartmentLimit): ScVal {
  return enc.struct({
    department: enc.symbol(l.department),
    token: enc.address(l.token),
    limit: enc.i128(l.limit),
  });
}

function decodeDepartmentLimit(v: ScVal, path: string): DepartmentLimit {
  const s = dec.struct(v, path);
  return {
    department: s.field("department", dec.symbol),
    token: s.field("token", dec.address),
    limit: s.field("limit", dec.i128),
  };
}

function encodePeriod(p: SpendingPeriod): ScVal {
  return enc.struct({ anchor: enc.u64(p.anchor), length: enc.u64(p.length) });
}

function decodePeriod(v: ScVal, path: string): SpendingPeriod {
  const s = dec.struct(v, path);
  return { anchor: s.field("anchor", dec.u64), length: s.field("length", dec.u64) };
}

function policyConfigFields(p: PolicyConfig): Record<string, ScVal> {
  return {
    default_approvals: enc.u32(p.defaultApprovals),
    thresholds: enc.vec(p.thresholds, encodeThreshold),
    recipient_allowlist_enabled: enc.bool(p.recipientAllowlistEnabled),
    allowed_recipients: enc.vec(p.allowedRecipients, enc.address),
    allowed_tokens: enc.vec(p.allowedTokens, enc.address),
    department_limits: enc.vec(p.departmentLimits, encodeDepartmentLimit),
    period: encodePeriod(p.period),
    max_proposal_ttl: enc.u64(p.maxProposalTtl),
  };
}

export function encodePolicyConfig(p: PolicyConfig): ScVal {
  return enc.struct(policyConfigFields(p));
}

function decodePolicyConfigFields(s: StructReader): PolicyConfig {
  return {
    defaultApprovals: s.field("default_approvals", dec.u32),
    thresholds: s.field("thresholds", (v, p) => dec.vec(v, p, decodeThreshold)),
    recipientAllowlistEnabled: s.field("recipient_allowlist_enabled", dec.bool),
    allowedRecipients: s.field("allowed_recipients", (v, p) => dec.vec(v, p, dec.address)),
    allowedTokens: s.field("allowed_tokens", (v, p) => dec.vec(v, p, dec.address)),
    departmentLimits: s.field("department_limits", (v, p) => dec.vec(v, p, decodeDepartmentLimit)),
    period: s.field("period", decodePeriod),
    maxProposalTtl: s.field("max_proposal_ttl", dec.u64),
  };
}

export function decodePolicyConfig(v: ScVal, path = "policy"): PolicyConfig {
  return decodePolicyConfigFields(dec.struct(v, path));
}

/** Encode a stored policy (used by test fixtures and mock servers). */
export function encodePolicy(p: Policy): ScVal {
  return enc.struct({
    ...policyConfigFields(p),
    version: enc.u32(p.version),
    updated_at: enc.u64(p.updatedAt),
  });
}

export function decodePolicy(v: ScVal, path = "policy"): Policy {
  const s = dec.struct(v, path);
  return {
    ...decodePolicyConfigFields(s),
    version: s.field("version", dec.u32),
    updatedAt: s.field("updated_at", dec.u64),
  };
}

function paymentRequestFields(r: PaymentRequest): Record<string, ScVal> {
  return {
    token: enc.address(r.token),
    recipient: enc.address(r.recipient),
    amount: enc.i128(r.amount),
    department: enc.symbol(r.department),
    memo: enc.string(r.memo),
    expires_at: enc.u64(r.expiresAt),
  };
}

export function encodePaymentRequest(r: PaymentRequest): ScVal {
  return enc.struct(paymentRequestFields(r));
}

/** Encode a stored proposal (used by test fixtures and mock servers). */
export function encodeProposal(p: Proposal): ScVal {
  return enc.struct({
    ...paymentRequestFields(p),
    id: enc.u64(p.id),
    proposer: enc.address(p.proposer),
    created_at: enc.u64(p.createdAt),
    policy_version: enc.u32(p.policyVersion),
    required_approvals: enc.u32(p.requiredApprovals),
    approvals: enc.vec(p.approvals, enc.address),
    status: enc.unitEnum(p.status),
    closed_at: enc.option(p.closedAt, enc.u64),
  });
}

export function decodeProposal(v: ScVal, path = "proposal"): Proposal {
  const s = dec.struct(v, path);
  return {
    id: s.field("id", dec.u64),
    proposer: s.field("proposer", dec.address),
    token: s.field("token", dec.address),
    recipient: s.field("recipient", dec.address),
    amount: s.field("amount", dec.i128),
    department: s.field("department", dec.symbol),
    memo: s.field("memo", dec.string),
    expiresAt: s.field("expires_at", dec.u64),
    createdAt: s.field("created_at", dec.u64),
    policyVersion: s.field("policy_version", dec.u32),
    requiredApprovals: s.field("required_approvals", dec.u32),
    approvals: s.field("approvals", (x, p) => dec.vec(x, p, dec.address)),
    status: s.field("status", (x, p) => dec.unitEnum(x, p, STATUS_VARIANTS)),
    closedAt: s.field("closed_at", (x, p) => dec.option(x, p, dec.u64)),
  };
}

export function encodeTreasuryConfig(c: TreasuryConfig): ScVal {
  return enc.struct({
    name: enc.string(c.name),
    proposal_count: enc.u64(c.proposalCount),
    interface_version: enc.u32(c.interfaceVersion),
  });
}

export function decodeTreasuryConfig(v: ScVal, path = "config"): TreasuryConfig {
  const s = dec.struct(v, path);
  return {
    name: s.field("name", dec.string),
    proposalCount: s.field("proposal_count", dec.u64),
    interfaceVersion: s.field("interface_version", dec.u32),
  };
}

export function encodeMember(m: Member): ScVal {
  return enc.struct({ address: enc.address(m.address), role: encodeRole(m.role) });
}
