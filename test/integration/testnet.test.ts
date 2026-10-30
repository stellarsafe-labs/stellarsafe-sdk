/**
 * Read-only checks against a real treasury on testnet.
 *
 *   STELLARSAFE_TREASURY_ID=C… npm run test:integration
 */
import { describe, expect, it } from "vitest";
import { getProposalState, StellarSafeClient } from "../../src/index.js";

const treasuryId = process.env.STELLARSAFE_TREASURY_ID;

describe.skipIf(!treasuryId)("testnet treasury", () => {
  const client = new StellarSafeClient({
    network: "testnet",
    ...(process.env.STELLAR_RPC_URL ? { rpcUrl: process.env.STELLAR_RPC_URL } : {}),
  });
  const safe = client.treasury(treasuryId as string);

  it("is on the expected network", async () => {
    await client.verifyNetwork();
  });

  it("implements the supported interface", async () => {
    await safe.assertCompatible();
  });

  it("decodes a full snapshot", async () => {
    const snap = await safe.getSnapshot();
    expect(snap.members.length).toBeGreaterThan(0);
    expect(snap.members.some((m) => m.role === "Admin")).toBe(true);
    expect(snap.policy.version).toBeGreaterThan(0);
    const { closeTime } = await client.getLedgerTime();
    for (const p of snap.pendingProposals) {
      expect(["pending", "ready", "stale", "expired"]).toContain(
        getProposalState(p, closeTime, snap.policy.version),
      );
    }
  });

  it("decodes recent events", async () => {
    const { sequence } = await client.getLedgerTime();
    const page = await client.getEvents({
      contractIds: [treasuryId as string],
      startLedger: Math.max(1, sequence - 100_000),
      limit: 50,
    });
    for (const e of page.events) expect(e.meta.contractId).toBe(treasuryId);
  });
});
