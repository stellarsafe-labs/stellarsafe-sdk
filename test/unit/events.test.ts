import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { enc, encodeRole } from "../../src/codec.js";
import { DecodeError, decodeEvent, EVENT_TYPES, eventTopicFilter } from "../../src/index.js";
import { ADMIN, APPROVER, RECIPIENT, USDC } from "../helpers/fixtures.js";

const ns = enc.symbol("stellarsafe");
const topics = (name: string, ...rest: xdr.ScVal[]) => [ns, enc.symbol(name), ...rest];

describe("decodeEvent", () => {
  const admin = ADMIN.publicKey();
  const approver = APPROVER.publicKey();
  const id = enc.u64(7n);

  it.each([
    [
      "initialized",
      topics("initialized"),
      enc.struct({
        name: enc.string("Acme"),
        admin: enc.address(admin),
        policy_version: enc.u32(1),
      }),
      { name: "Acme", admin, policyVersion: 1 },
    ],
    [
      "member_added",
      topics("member_added", enc.address(approver)),
      encodeRole("Approver"),
      { member: approver, role: "Approver" },
    ],
    [
      "member_removed",
      topics("member_removed", enc.address(approver)),
      xdr.ScVal.scvVoid(),
      { member: approver },
    ],
    ["policy_updated", topics("policy_updated"), enc.u32(3), { version: 3 }],
    [
      "proposed",
      topics("proposed", id),
      enc.struct({
        proposer: enc.address(admin),
        token: enc.address(USDC),
        recipient: enc.address(RECIPIENT),
        amount: enc.i128(500n),
        department: enc.symbol("ops"),
        expires_at: enc.u64(99n),
      }),
      {
        proposalId: 7n,
        proposer: admin,
        token: USDC,
        recipient: RECIPIENT,
        amount: 500n,
        department: "ops",
        expiresAt: 99n,
      },
    ],
    [
      "approved",
      topics("approved", id),
      enc.struct({ approver: enc.address(approver), approvals: enc.u32(2) }),
      { proposalId: 7n, approver, approvals: 2 },
    ],
    [
      "approval_revoked",
      topics("approval_revoked", id),
      enc.struct({ approver: enc.address(approver), approvals: enc.u32(1) }),
      { proposalId: 7n, approver, approvals: 1 },
    ],
    [
      "executed",
      topics("executed", id),
      enc.struct({
        executor: enc.address(approver),
        token: enc.address(USDC),
        recipient: enc.address(RECIPIENT),
        amount: enc.i128(500n),
        department: enc.symbol("ops"),
      }),
      {
        proposalId: 7n,
        executor: approver,
        token: USDC,
        recipient: RECIPIENT,
        amount: 500n,
        department: "ops",
      },
    ],
    [
      "cancelled",
      topics("cancelled", id),
      enc.struct({ by: enc.address(admin) }),
      { proposalId: 7n, by: admin },
    ],
  ])("decodes %s", (type, t, value, data) => {
    expect(decodeEvent({ topics: t, value })).toEqual({ type, data });
  });

  it("covers every event type", () => {
    expect(EVENT_TYPES).toHaveLength(9);
  });

  it("ignores foreign and unknown events", () => {
    expect(decodeEvent({ topics: [enc.symbol("transfer")], value: enc.u32(1) })).toBeUndefined();
    expect(decodeEvent({ topics: [], value: enc.u32(1) })).toBeUndefined();
    expect(decodeEvent({ topics: [ns], value: enc.u32(1) })).toBeUndefined();
    expect(decodeEvent({ topics: [ns, enc.u32(1)], value: enc.u32(1) })).toBeUndefined();
    expect(decodeEvent({ topics: topics("future_event"), value: enc.u32(1) })).toBeUndefined();
  });

  it("throws on malformed known events", () => {
    expect(() => decodeEvent({ topics: topics("approved"), value: enc.u32(1) })).toThrow(
      DecodeError,
    );
    expect(() =>
      decodeEvent({
        topics: topics("approved"),
        value: enc.struct({ approver: enc.address(approver), approvals: enc.u32(2) }),
      }),
    ).toThrow(/missing topic 2/);
  });
});

describe("eventTopicFilter", () => {
  it("matches all StellarSafe events by default", () => {
    const [filter] = eventTopicFilter();
    expect(filter).toEqual([ns.toXdr("base64"), "**"]);
  });

  it("builds one pattern per type", () => {
    const f = eventTopicFilter(["approved", "executed"]);
    expect(f).toHaveLength(2);
    expect(f[1]).toEqual([ns.toXdr("base64"), enc.symbol("executed").toXdr("base64"), "**"]);
  });
});
