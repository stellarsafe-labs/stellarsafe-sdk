import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { dec, enc, encodeMember, encodeRole } from "../../src/codec.js";
import {
  DecodeError,
  decodeMember,
  decodePolicy,
  decodeProposal,
  decodeTreasuryConfig,
  encodePaymentRequest,
  encodePolicy,
  encodePolicyConfig,
  encodeProposal,
  encodeTreasuryConfig,
} from "../../src/index.js";
import { APPROVER, makePolicy, makeProposal, RECIPIENT, USDC } from "../helpers/fixtures.js";

/** Serialize through XDR bytes to be sure values survive the wire. */
function wire(v: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.fromXdr(v.toXdr("base64"), "base64");
}

function mapKeys(v: xdr.ScVal): string[] {
  if (v.type !== "scvMap") throw new Error("not a map");
  return (v.map ?? []).map((e) => (e.key.type === "scvSymbol" ? e.key.sym.toString() : "?"));
}

describe("struct encoding", () => {
  it("sorts keys as Soroban requires", () => {
    const keys = mapKeys(enc.struct({ zeta: enc.u32(1), alpha: enc.u32(2), mid: enc.u32(3) }));
    expect(keys).toEqual(["alpha", "mid", "zeta"]);
  });

  it("encodes policy config with snake_case sorted keys", () => {
    const { version: _v, updatedAt: _u, ...config } = makePolicy();
    expect(mapKeys(encodePolicyConfig(config))).toEqual([
      "allowed_recipients",
      "allowed_tokens",
      "default_approvals",
      "department_limits",
      "max_proposal_ttl",
      "period",
      "recipient_allowlist_enabled",
      "thresholds",
    ]);
  });

  it("encodes payment requests", () => {
    const { id: _id, ...rest } = makeProposal();
    const v = encodePaymentRequest(rest);
    expect(mapKeys(v)).toEqual([
      "amount",
      "department",
      "expires_at",
      "memo",
      "recipient",
      "token",
    ]);
  });

  it("encodes unit enums as a single-symbol vec", () => {
    const v = encodeRole("Admin");
    expect(v.type).toBe("scvVec");
    expect(dec.unitEnum(v, "r", ["Admin"])).toBe("Admin");
  });
});

describe("round trips", () => {
  it("policy", () => {
    const policy = makePolicy();
    expect(decodePolicy(wire(encodePolicy(policy)))).toEqual(policy);
  });

  it("proposal (open and closed)", () => {
    const open = makeProposal({ approvals: [APPROVER.publicKey()] });
    expect(decodeProposal(wire(encodeProposal(open)))).toEqual(open);
    const closed = makeProposal({ status: "Executed", closedAt: 123n });
    expect(decodeProposal(wire(encodeProposal(closed)))).toEqual(closed);
  });

  it("member", () => {
    const m = { address: RECIPIENT, role: "Approver" as const };
    expect(decodeMember(wire(encodeMember(m)))).toEqual(m);
  });

  it("treasury config", () => {
    const c = { name: "Acme Ops", proposalCount: 7n, interfaceVersion: 1 };
    expect(decodeTreasuryConfig(wire(encodeTreasuryConfig(c)))).toEqual(c);
  });

  it("negative and large i128", () => {
    for (const n of [-1n, 0n, (1n << 126n) + 5n, -(1n << 120n)]) {
      expect(dec.i128(wire(enc.i128(n)), "n")).toBe(n);
    }
  });

  it("contract addresses", () => {
    expect(dec.address(enc.address(USDC), "a")).toBe(USDC);
  });

  it("empty vec / null vec", () => {
    expect(dec.vec(xdr.ScVal.scvVec(null), "v", dec.u32)).toEqual([]);
    expect(dec.option(xdr.ScVal.scvVoid(), "o", dec.u32)).toBeUndefined();
  });
});

describe("strict decoding", () => {
  it("reports wrong types with the field path", () => {
    const bad = enc.struct({ address: enc.u32(1), role: encodeRole("Admin") });
    expect(() => decodeMember(bad)).toThrow(DecodeError);
    expect(() => decodeMember(bad)).toThrow("member.address: expected scvAddress, got scvU32");
  });

  it("reports missing fields", () => {
    const bad = enc.struct({ address: enc.address(RECIPIENT) });
    expect(() => decodeMember(bad)).toThrow('member: missing field "role"');
  });

  it("reports nested vec paths", () => {
    const p = encodeProposal(makeProposal());
    const tampered = enc.struct({
      ...Object.fromEntries(
        (p.type === "scvMap" ? (p.map ?? []) : []).map((e) => [
          e.key.type === "scvSymbol" ? e.key.sym.toString() : "",
          e.val,
        ]),
      ),
      approvals: enc.vec([1], enc.u32),
    });
    expect(() => decodeProposal(tampered)).toThrow("proposal.approvals[0]: expected scvAddress");
  });

  it("rejects unknown enum variants and malformed enums", () => {
    expect(() =>
      decodeMember(enc.struct({ address: enc.address(RECIPIENT), role: enc.unitEnum("Owner") })),
    ).toThrow(/unknown variant "Owner"/);
    expect(() => dec.unitEnum(xdr.ScVal.scvVec([]), "r", ["A"])).toThrow(/unit enum/);
  });
});
