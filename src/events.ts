/**
 * Decoding of StellarSafe contract events.
 *
 * Every StellarSafe event's first topic is the symbol `"stellarsafe"` and its
 * second topic is the event name. See `docs/CONTRACT_INTERFACE.md`.
 *
 * @module
 */
import type { xdr } from "@stellar/stellar-sdk";
import { dec, decodeRole, enc } from "./codec.js";
import { DecodeError } from "./errors.js";
import type { Address, Role } from "./types.js";

/** First topic of every StellarSafe event. */
export const EVENT_NAMESPACE = "stellarsafe";

/** All event names emitted by the contract. */
export const EVENT_TYPES = [
  "initialized",
  "member_added",
  "member_removed",
  "policy_updated",
  "proposed",
  "approved",
  "approval_revoked",
  "executed",
  "cancelled",
] as const;

export type StellarSafeEventType = (typeof EVENT_TYPES)[number];

/** Payloads keyed by event type. */
export interface EventPayloads {
  initialized: { name: string; admin: Address; policyVersion: number };
  member_added: { member: Address; role: Role };
  member_removed: { member: Address };
  policy_updated: { version: number };
  proposed: {
    proposalId: bigint;
    proposer: Address;
    token: Address;
    recipient: Address;
    amount: bigint;
    department: string;
    expiresAt: bigint;
  };
  approved: { proposalId: bigint; approver: Address; approvals: number };
  approval_revoked: { proposalId: bigint; approver: Address; approvals: number };
  executed: {
    proposalId: bigint;
    executor: Address;
    token: Address;
    recipient: Address;
    amount: bigint;
    department: string;
  };
  cancelled: { proposalId: bigint; by: Address };
}

/** Where and when an event was emitted. Present for events fetched from RPC. */
export interface EventMeta {
  /** RPC event id, usable as a stable unique key and as a pagination cursor. */
  readonly id: string;
  readonly contractId: Address;
  readonly ledger: number;
  /** ISO-8601 ledger close time. */
  readonly ledgerClosedAt: string;
  readonly txHash: string;
}

/** A decoded StellarSafe event: `{ type, data }` discriminated union. */
export type StellarSafeEvent = {
  [K in StellarSafeEventType]: { readonly type: K; readonly data: EventPayloads[K] };
}[StellarSafeEventType];

/** A decoded event together with its on-chain location. */
export type StellarSafeEventWithMeta = StellarSafeEvent & { readonly meta: EventMeta };

/** Raw event shape: topics and data as ScVals. */
export interface RawEvent {
  readonly topics: readonly xdr.ScVal[];
  readonly value: xdr.ScVal;
}

type Decoder<K extends StellarSafeEventType> = (
  topics: readonly xdr.ScVal[],
  value: xdr.ScVal,
) => EventPayloads[K];

function topic(topics: readonly xdr.ScVal[], index: number, type: string): xdr.ScVal {
  const t = topics[index];
  if (t === undefined) {
    throw new DecodeError(`event ${type}: missing topic ${index}`);
  }
  return t;
}

const DECODERS: { [K in StellarSafeEventType]: Decoder<K> } = {
  initialized: (_t, v) => {
    const s = dec.struct(v, "initialized.data");
    return {
      name: s.field("name", dec.string),
      admin: s.field("admin", dec.address),
      policyVersion: s.field("policy_version", dec.u32),
    };
  },
  member_added: (t, v) => ({
    member: dec.address(topic(t, 2, "member_added"), "member_added.topics[2]"),
    role: decodeRole(v, "member_added.data"),
  }),
  member_removed: (t) => ({
    member: dec.address(topic(t, 2, "member_removed"), "member_removed.topics[2]"),
  }),
  policy_updated: (_t, v) => ({ version: dec.u32(v, "policy_updated.data") }),
  proposed: (t, v) => {
    const s = dec.struct(v, "proposed.data");
    return {
      proposalId: dec.u64(topic(t, 2, "proposed"), "proposed.topics[2]"),
      proposer: s.field("proposer", dec.address),
      token: s.field("token", dec.address),
      recipient: s.field("recipient", dec.address),
      amount: s.field("amount", dec.i128),
      department: s.field("department", dec.symbol),
      expiresAt: s.field("expires_at", dec.u64),
    };
  },
  approved: (t, v) => {
    const s = dec.struct(v, "approved.data");
    return {
      proposalId: dec.u64(topic(t, 2, "approved"), "approved.topics[2]"),
      approver: s.field("approver", dec.address),
      approvals: s.field("approvals", dec.u32),
    };
  },
  approval_revoked: (t, v) => {
    const s = dec.struct(v, "approval_revoked.data");
    return {
      proposalId: dec.u64(topic(t, 2, "approval_revoked"), "approval_revoked.topics[2]"),
      approver: s.field("approver", dec.address),
      approvals: s.field("approvals", dec.u32),
    };
  },
  executed: (t, v) => {
    const s = dec.struct(v, "executed.data");
    return {
      proposalId: dec.u64(topic(t, 2, "executed"), "executed.topics[2]"),
      executor: s.field("executor", dec.address),
      token: s.field("token", dec.address),
      recipient: s.field("recipient", dec.address),
      amount: s.field("amount", dec.i128),
      department: s.field("department", dec.symbol),
    };
  },
  cancelled: (t, v) => {
    const s = dec.struct(v, "cancelled.data");
    return {
      proposalId: dec.u64(topic(t, 2, "cancelled"), "cancelled.topics[2]"),
      by: s.field("by", dec.address),
    };
  },
};

function isEventType(name: string): name is StellarSafeEventType {
  return (EVENT_TYPES as readonly string[]).includes(name);
}

/**
 * Decode a raw contract event.
 *
 * @returns the decoded event, or `undefined` if the event is not a StellarSafe
 *   event or is a StellarSafe event type unknown to this SDK version (so
 *   indexers keep working when the contract adds new events).
 * @throws {DecodeError} if a known StellarSafe event has a malformed payload.
 */
export function decodeEvent(raw: RawEvent): StellarSafeEvent | undefined {
  const [ns, name] = raw.topics;
  if (ns?.type !== "scvSymbol" || ns.sym.toString() !== EVENT_NAMESPACE) return undefined;
  if (name?.type !== "scvSymbol") return undefined;
  const type = name.sym.toString();
  if (!isEventType(type)) return undefined;
  const data = DECODERS[type](raw.topics, raw.value);
  return { type, data } as StellarSafeEvent;
}

/** Build the RPC topic filter (base64 XDR segments) matching StellarSafe events. */
export function eventTopicFilter(types?: readonly StellarSafeEventType[]): string[][] {
  const ns = enc.symbol(EVENT_NAMESPACE).toXdr("base64");
  if (!types || types.length === 0) {
    // "**" matches zero or more trailing topics.
    return [[ns, "**"]];
  }
  return types.map((type) => [ns, enc.symbol(type).toXdr("base64"), "**"]);
}
