/**
 * Conformance between the SDK and the compiled contract.
 *
 * Reads the interface spec embedded in test/fixtures/stellarsafe_treasury.wasm
 * (the real contract build) and checks that every SDK call names a real
 * function and encodes each argument exactly as the contract's types demand,
 * that the SDK's encoders for return types match the contract's structs, and
 * that error codes and events line up. Any drift between the two repositories
 * fails here, offline.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { contract, type xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { enc, encodeMember } from "../../src/codec.js";
import {
  ContractErrorCode,
  EVENT_TYPES,
  encodePolicy,
  encodeProposal,
  encodeTreasuryConfig,
  keypairSigner,
  StellarSafeClient,
} from "../../src/index.js";
import { type FakeRpc, fakeRpc, VOID } from "../helpers/fake-rpc.js";
import {
  ADMIN,
  APPROVER,
  makePolicy,
  makeProposal,
  NOW,
  PROPOSER,
  RECIPIENT,
  TREASURY_ID,
  USDC,
} from "../helpers/fixtures.js";

const spec = contract.Spec.fromWasm(
  new Uint8Array(readFileSync(new URL("../fixtures/stellarsafe_treasury.wasm", import.meta.url))),
);

type TypeDef = xdr.ScSpecTypeDef;

function udt(name: string): xdr.ScSpecEntry {
  const entry = spec.entries.find(
    (e) =>
      (e.type === "scSpecEntryUdtStructV0" && e.udtStructV0.name.toString() === name) ||
      (e.type === "scSpecEntryUdtUnionV0" && e.udtUnionV0.name.toString() === name),
  );
  if (!entry) throw new Error(`spec has no type ${name}`);
  return entry;
}

const PRIMITIVES: Partial<Record<TypeDef["type"], xdr.ScVal["type"]>> = {
  scSpecTypeAddress: "scvAddress",
  scSpecTypeU32: "scvU32",
  scSpecTypeU64: "scvU64",
  scSpecTypeI128: "scvI128",
  scSpecTypeBool: "scvBool",
  scSpecTypeString: "scvString",
  scSpecTypeSymbol: "scvSymbol",
  scSpecTypeBytes: "scvBytes",
};

/** Assert `val` is a valid encoding of spec type `type`, recursively. */
function conforms(val: xdr.ScVal, type: TypeDef, path: string): void {
  const primitive = PRIMITIVES[type.type];
  if (primitive) {
    expect(val.type, path).toBe(primitive);
    return;
  }
  switch (type.type) {
    case "scSpecTypeVoid":
      expect(val.type, path).toBe("scvVoid");
      return;
    case "scSpecTypeOption":
      if (val.type !== "scvVoid") conforms(val, type.option.valueType, path);
      return;
    case "scSpecTypeVec":
      expect(val.type, path).toBe("scvVec");
      if (val.type === "scvVec") {
        (val.vec ?? []).forEach((v, i) => {
          conforms(v, type.vec.elementType, `${path}[${i}]`);
        });
      }
      return;
    case "scSpecTypeUdt": {
      const entry = udt(type.udt.name.toString());
      if (entry.type === "scSpecEntryUdtStructV0") {
        expect(val.type, path).toBe("scvMap");
        if (val.type !== "scvMap") return;
        const fields = entry.udtStructV0.fields;
        const keys = (val.map ?? []).map((e) =>
          e.key.type === "scvSymbol" ? e.key.sym.toString() : "?",
        );
        expect(keys, `${path} fields`).toEqual(fields.map((f) => f.name.toString()).sort());
        for (const f of fields) {
          const entryVal = val.map?.find(
            (e) => e.key.type === "scvSymbol" && e.key.sym.toString() === f.name.toString(),
          )?.val;
          if (entryVal) conforms(entryVal, f.type, `${path}.${f.name.toString()}`);
        }
        return;
      }
      if (entry.type === "scSpecEntryUdtUnionV0") {
        expect(val.type, path).toBe("scvVec");
        if (val.type !== "scvVec") return;
        const [tag, ...rest] = val.vec ?? [];
        const name = tag?.type === "scvSymbol" ? tag.sym.toString() : "";
        const c = entry.udtUnionV0.cases.find(
          (x) =>
            (x.type === "scSpecUdtUnionCaseVoidV0"
              ? x.voidCase.name
              : x.tupleCase.name
            ).toString() === name,
        );
        expect(c, `${path}: unknown variant ${name}`).toBeDefined();
        if (c?.type === "scSpecUdtUnionCaseTupleV0") {
          c.tupleCase.type.forEach((t, i) => {
            conforms(rest[i] as xdr.ScVal, t, `${path}.${name}[${i}]`);
          });
        } else {
          expect(rest, path).toEqual([]);
        }
        return;
      }
      throw new Error(`unsupported udt kind at ${path}`);
    }
    default:
      throw new Error(`unsupported spec type ${type.type} at ${path}`);
  }
}

function okType(fn: string): TypeDef {
  const out = spec.getFunc(fn).outputs[0];
  if (!out) throw new Error(`${fn} has no output`);
  return out.type === "scSpecTypeResult" ? out.result.okType : out;
}

describe("contract interface conformance", () => {
  it("uses the recorded contract build", () => {
    const wasm = readFileSync(new URL("../fixtures/stellarsafe_treasury.wasm", import.meta.url));
    const recorded = readFileSync(
      new URL("../fixtures/stellarsafe_treasury.wasm.sha256", import.meta.url),
      "utf8",
    ).trim();
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(recorded);
  });

  it("error codes match the contract exactly", () => {
    const fromWasm = Object.fromEntries(spec.errorCases().map((e) => [e.name.toString(), e.value]));
    expect(fromWasm).toEqual(ContractErrorCode);
  });

  it("every contract event is decodable by the SDK", () => {
    const events = spec.entries
      .filter((e) => e.type === "scSpecEntryEventV0")
      .map((e) => (e.type === "scSpecEntryEventV0" ? e.eventV0.prefixTopics.map(String) : []));
    expect(events.every((topics) => topics[0] === "stellarsafe")).toBe(true);
    expect(events.map((t) => t[1]).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("SDK encoders for return types match the contract's structs", () => {
    conforms(encodePolicy(makePolicy()), okType("get_policy"), "Policy");
    conforms(
      encodeProposal(makeProposal({ approvals: [APPROVER.publicKey()], closedAt: 5n })),
      okType("get_proposal"),
      "Proposal",
    );
    conforms(
      encodeTreasuryConfig({ name: "x", proposalCount: 1n, interfaceVersion: 1 }),
      okType("get_config"),
      "TreasuryConfig",
    );
    conforms(
      enc.vec([{ address: ADMIN.publicKey(), role: "Admin" as const }], encodeMember),
      okType("get_members"),
      "Vec<Member>",
    );
  });

  describe("every SDK call matches a contract function", () => {
    let rpc: FakeRpc;
    let client: StellarSafeClient;

    beforeEach(() => {
      rpc = fakeRpc();
      // Answer every call with a value of the right spec type, so decoding succeeds too.
      const answers: Record<string, xdr.ScVal> = {
        get_config: encodeTreasuryConfig({ name: "x", proposalCount: 1n, interfaceVersion: 1 }),
        get_policy: encodePolicy(makePolicy()),
        get_members: enc.vec([], encodeMember),
        get_role: VOID,
        get_proposal: encodeProposal(makeProposal()),
        get_pending_proposals: enc.vec([], encodeProposal),
        get_proposals: enc.vec([], encodeProposal),
        get_spent: enc.struct({ period_index: enc.u64(0n), spent: enc.i128(0n) }),
        propose_payment: enc.u64(1n),
        set_policy: enc.u32(2),
        __deploy: enc.address(TREASURY_ID),
      };
      rpc.handlers = new Proxy(
        {},
        { get: (_t, name: string) => () => answers[name] ?? VOID, has: () => true },
      );
      client = new StellarSafeClient({ network: "testnet", rpc });
    });

    it("all calls", async () => {
      const safe = client.treasury(TREASURY_ID);
      const { version: _v, updatedAt: _u, ...policy } = makePolicy();
      const admin = ADMIN.publicKey();
      await safe.getSnapshot();
      await safe.getRole(admin);
      await safe.getProposal(1n);
      await safe.listProposals();
      await safe.getSpending("ops", USDC);
      await safe.addMember({ caller: admin, member: RECIPIENT, role: "Proposer" });
      await safe.removeMember({ caller: admin, member: RECIPIENT });
      await safe.setPolicy({ caller: admin, policy });
      await safe.proposePayment({
        proposer: PROPOSER.publicKey(),
        token: USDC,
        recipient: RECIPIENT,
        amount: 1n,
        department: "ops",
        memo: "m",
        expiresAt: NOW,
      });
      await safe.approvePayment({ approver: admin, proposalId: 1n });
      await safe.revokeApproval({ approver: admin, proposalId: 1n });
      await safe.executePayment({ executor: admin, proposalId: 1n });
      await safe.cancelPayment({ caller: admin, proposalId: 1n });
      await client.deployTreasury({
        wasmHash: "00".repeat(32),
        admin,
        name: "x",
        members: [{ address: APPROVER.publicKey(), role: "Approver" }],
        policy,
      });
      expect(keypairSigner(ADMIN).address).toBe(admin);

      const called = new Set<string>();
      for (const { method, args } of rpc.calls) {
        const name = method === "__deploy" ? "__constructor" : method;
        called.add(name);
        const fn = spec.getFunc(name);
        expect(args.length, `${name} arity`).toBe(fn.inputs.length);
        fn.inputs.forEach((input, i) => {
          conforms(args[i] as xdr.ScVal, input.type, `${name}(${input.name.toString()})`);
        });
      }
      // The SDK covers the entire contract interface.
      expect([...called].sort()).toEqual(
        spec
          .funcs()
          .map((f) => f.name.toString())
          .sort(),
      );
    });
  });
});
