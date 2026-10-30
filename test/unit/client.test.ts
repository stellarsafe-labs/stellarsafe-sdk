import { Networks, rpc as stellarRpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { enc } from "../../src/codec.js";
import { NETWORKS, StellarSafeClient, StellarSafeError } from "../../src/index.js";
import { fakeRpc } from "../helpers/fake-rpc.js";
import { ADMIN, APPROVER, contractId, makePolicy, TREASURY_ID } from "../helpers/fixtures.js";

describe("StellarSafeClient configuration", () => {
  it("uses the testnet defaults", () => {
    const c = new StellarSafeClient({ network: "testnet" });
    expect(c.networkPassphrase).toBe(Networks.TESTNET);
    expect(c.rpc).toBeInstanceOf(stellarRpc.Server);
  });

  it("requires an rpcUrl for mainnet", () => {
    expect(() => new StellarSafeClient({ network: "mainnet" })).toThrow(/rpcUrl is required/);
    const c = new StellarSafeClient({ network: "mainnet", rpcUrl: "https://rpc.example.com" });
    expect(c.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it("supports custom networks", () => {
    expect(() => new StellarSafeClient({ network: "custom", rpcUrl: "https://x" })).toThrow(
      /networkPassphrase is required/,
    );
    const c = new StellarSafeClient({
      network: "custom",
      networkPassphrase: "My Net",
      rpcUrl: "https://x.example",
      headers: { "x-api-key": "k" },
    });
    expect(c.networkPassphrase).toBe("My Net");
  });

  it("rejects contradictory passphrases and unknown networks", () => {
    expect(
      () => new StellarSafeClient({ network: "testnet", networkPassphrase: Networks.PUBLIC }),
    ).toThrow(/does not match/);
    expect(() => new StellarSafeClient({ network: "moonnet" as never })).toThrow(/Unknown network/);
  });

  it("refuses plain http unless allowed", () => {
    expect(() => new StellarSafeClient({ network: "testnet", rpcUrl: "http://x.example" })).toThrow(
      /allowHttp/,
    );
    expect(
      () =>
        new StellarSafeClient({ network: "testnet", rpcUrl: "http://x.example", allowHttp: true }),
    ).not.toThrow();
    expect(() => new StellarSafeClient({ network: "local" })).not.toThrow();
    expect(() => new StellarSafeClient({ network: "testnet", rpcUrl: "not a url" })).toThrow(
      /valid URL/,
    );
  });

  it("validates contract ids", () => {
    const c = new StellarSafeClient({ network: "testnet", rpc: fakeRpc() });
    expect(() => c.treasury(APPROVER.publicKey())).toThrow(/contract address/);
    expect(c.treasury(TREASURY_ID).contractId).toBe(TREASURY_ID);
  });

  it("exposes network presets", () => {
    expect(Object.keys(NETWORKS)).toEqual(["testnet", "mainnet", "futurenet", "local"]);
    expect(Object.isFrozen(NETWORKS)).toBe(true);
  });
});

describe("network helpers", () => {
  it("getLedgerTime", async () => {
    const c = new StellarSafeClient({ network: "testnet", rpc: fakeRpc() });
    expect(await c.getLedgerTime()).toEqual({ sequence: 1000, closeTime: 1_800_000_000n });
  });

  it("verifyNetwork caches success and retries after failure", async () => {
    const rpc = fakeRpc();
    let calls = 0;
    const original = rpc.getNetwork;
    rpc.getNetwork = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return original();
    };
    const c = new StellarSafeClient({ network: "testnet", rpc, retry: { retries: 0 } });
    await expect(c.verifyNetwork()).rejects.toBeInstanceOf(StellarSafeError);
    await c.verifyNetwork();
    await c.verifyNetwork();
    expect(calls).toBe(2);
  });
});

function rawEvent(id: string, name: string, ledger: number) {
  return {
    id,
    type: "contract" as const,
    ledger,
    ledgerClosedAt: "2026-10-30T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "ab".repeat(32),
    contractId: { contractId: () => TREASURY_ID } as never,
    topic: [enc.symbol("stellarsafe"), enc.symbol(name)],
    value: enc.u32(ledger),
  };
}

function page(events: ReturnType<typeof rawEvent>[], cursor: string) {
  return {
    events,
    cursor,
    latestLedger: 2000,
    oldestLedger: 10,
    latestLedgerCloseTime: "0",
    oldestLedgerCloseTime: "0",
  };
}

describe("getEvents", () => {
  it("decodes StellarSafe events and skips others", async () => {
    const rpc = fakeRpc();
    rpc.eventPages = [
      page(
        [
          rawEvent("1", "policy_updated", 5),
          { ...rawEvent("2", "x", 6), topic: [enc.symbol("transfer")] },
        ],
        "c1",
      ),
    ];
    const c = new StellarSafeClient({ network: "testnet", rpc });
    const res = await c.getEvents({ contractIds: [TREASURY_ID], startLedger: 5 });
    expect(res.cursor).toBe("c1");
    expect(res.oldestLedger).toBe(10);
    expect(res.events).toEqual([
      {
        type: "policy_updated",
        data: { version: 5 },
        meta: {
          id: "1",
          contractId: TREASURY_ID,
          ledger: 5,
          ledgerClosedAt: "2026-10-30T00:00:00Z",
          txHash: "ab".repeat(32),
        },
      },
    ]);
    expect(rpc.eventRequests[0]).toMatchObject({ startLedger: 5, limit: 100 });
  });

  it("builds RPC filters within the server's limits", async () => {
    const rpc = fakeRpc();
    const c = new StellarSafeClient({ network: "testnet", rpc });
    const ids = Array.from({ length: 7 }, (_, i) => contractId(100 + i));
    await c.getEvents({ contractIds: ids, cursor: "abc", types: ["approved", "executed"] });
    const req = rpc.eventRequests[0];
    expect(req?.cursor).toBe("abc");
    expect(req?.filters).toHaveLength(2);
    expect(req?.filters[0]?.contractIds).toHaveLength(5);
    expect(req?.filters[0]?.topics).toHaveLength(2);

    const many = Array.from({ length: 26 }, (_, i) => contractId(100 + i));
    await expect(c.getEvents({ contractIds: many, startLedger: 1 })).rejects.toThrow(
      /Too many contracts/,
    );
  });

  it("validates arguments", async () => {
    const c = new StellarSafeClient({ network: "testnet", rpc: fakeRpc() });
    await expect(c.getEvents({ contractIds: [], startLedger: 1 })).rejects.toThrow(/at least one/);
    await expect(c.getEvents({ contractIds: [TREASURY_ID] })).rejects.toThrow(/exactly one/);
    await expect(
      c.getEvents({ contractIds: [TREASURY_ID], startLedger: 1, cursor: "x" }),
    ).rejects.toThrow(/exactly one/);
    await expect(c.getEvents({ contractIds: [TREASURY_ID], startLedger: 0 })).rejects.toThrow(
      /startLedger/,
    );
    await expect(
      c.getEvents({ contractIds: [TREASURY_ID], startLedger: 1, limit: 0 }),
    ).rejects.toThrow(/limit/);
    await expect(c.getEvents({ contractIds: ["nope"], startLedger: 1 })).rejects.toThrow(
      /contractIds\[0\]/,
    );
  });
});

describe("streamEvents", () => {
  it("pages through events with cursors and polls when caught up", async () => {
    const rpc = fakeRpc();
    rpc.eventPages = [
      page([rawEvent("1", "policy_updated", 1), rawEvent("2", "policy_updated", 2)], "c1"),
      page([], "c2"),
      page([rawEvent("3", "policy_updated", 3)], "c3"),
    ];
    const c = new StellarSafeClient({ network: "testnet", rpc });
    const ac = new AbortController();
    const seen: string[] = [];
    try {
      for await (const e of c.streamEvents({
        contractIds: [TREASURY_ID],
        startLedger: 1,
        pageSize: 2,
        pollIntervalMs: 1,
        signal: ac.signal,
      })) {
        seen.push(e.meta.id);
        if (seen.length === 3) ac.abort();
      }
    } catch (err) {
      expect(err).toMatchObject({ code: "ABORTED" });
    }
    expect(seen).toEqual(["1", "2", "3"]);
    expect(rpc.eventRequests.map((r) => r.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("resumes from a cursor", async () => {
    const rpc = fakeRpc();
    rpc.eventPages = [page([rawEvent("9", "policy_updated", 9)], "c9")];
    const c = new StellarSafeClient({ network: "testnet", rpc });
    const it = c.streamEvents({
      contractIds: [TREASURY_ID],
      cursor: "c8",
      types: ["policy_updated"],
    });
    const first = await it.next();
    expect(first.value?.meta.id).toBe("9");
    await it.return();
    expect(rpc.eventRequests[0]?.cursor).toBe("c8");
  });
});

describe("deployment", () => {
  const policyConfig = (() => {
    const { version: _v, updatedAt: _u, ...rest } = makePolicy();
    return rest;
  })();

  function deployRpc() {
    const rpc = fakeRpc({
      handlers: {
        __upload: () => xdr.ScVal.scvBytes(new Uint8Array(32).fill(0xab)),
        __deploy: () => enc.address(TREASURY_ID),
      },
    });
    return { rpc, client: new StellarSafeClient({ network: "testnet", rpc }) };
  }

  it("uploads wasm and returns the hash", async () => {
    const { client } = deployRpc();
    const tx = await client.uploadWasm(new Uint8Array([0, 97, 115, 109]), {
      source: ADMIN.publicKey(),
    });
    expect(tx.result).toBe("ab".repeat(32));
    await expect(
      client.uploadWasm(new Uint8Array(), { source: ADMIN.publicKey() }),
    ).rejects.toThrow(/non-empty/);
  });

  it("deploys a treasury with constructor arguments", async () => {
    const { client, rpc } = deployRpc();
    const tx = await client.deployTreasury({
      wasmHash: "ab".repeat(32),
      admin: ADMIN.publicKey(),
      name: "Acme",
      members: [{ address: APPROVER.publicKey(), role: "Approver" }],
      policy: policyConfig,
      salt: "01".repeat(32),
    });
    expect(tx.result).toBe(TREASURY_ID);
    expect(tx.transaction.source).toBe(ADMIN.publicKey());
    const args = rpc.calls.at(-1)?.args ?? [];
    expect(args.map((a) => a.type)).toEqual(["scvAddress", "scvString", "scvVec", "scvMap"]);
    const op = tx.transaction.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeCreateContractV2") {
      throw new Error("expected createContractV2");
    }
    const preimage = op.func.createContractV2.contractIdPreimage;
    expect(preimage.type).toBe("contractIdPreimageFromAddress");
  });

  it("generates a random salt by default", async () => {
    const { client } = deployRpc();
    const params = {
      wasmHash: "ab".repeat(32),
      admin: ADMIN.publicKey(),
      name: "Acme",
      members: [{ address: APPROVER.publicKey(), role: "Approver" as const }],
      policy: policyConfig,
    };
    const a = await client.deployTreasury(params);
    const b = await client.deployTreasury(params);
    expect(a.hash).not.toBe(b.hash);
  });

  it("validates deployment parameters locally", async () => {
    const { client, rpc } = deployRpc();
    const base = {
      wasmHash: "ab".repeat(32),
      admin: ADMIN.publicKey(),
      name: "Acme",
      members: [{ address: APPROVER.publicKey(), role: "Approver" as const }],
      policy: policyConfig,
    };
    await expect(client.deployTreasury({ ...base, members: [] })).rejects.toThrow(
      /only 1 approvers/,
    );
    await expect(client.deployTreasury({ ...base, wasmHash: "abcd" })).rejects.toThrow(/32 bytes/);
    await expect(client.deployTreasury({ ...base, wasmHash: "zz".repeat(32) })).rejects.toThrow(
      /hex/,
    );
    await expect(client.deployTreasury({ ...base, salt: "00" })).rejects.toThrow(/32 bytes/);
    await expect(
      client.deployTreasury({
        ...base,
        members: [{ address: ADMIN.publicKey(), role: "Approver" }],
      }),
    ).rejects.toThrow(/listed twice/);
    await expect(
      client.deployTreasury({
        ...base,
        members: [{ address: APPROVER.publicKey(), role: "Owner" as never }],
      }),
    ).rejects.toThrow(/role must be one of/);
    expect(rpc.calls).toHaveLength(0);
  });
});
