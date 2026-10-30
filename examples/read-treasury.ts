/**
 * Print a treasury's policy, members, pending proposals and spending.
 *
 *   npm run build
 *   STELLARSAFE_TREASURY_ID=C… node examples/read-treasury.ts
 */
import { formatAmount, getProposalState, periodBounds, StellarSafeClient } from "@stellarsafe/sdk";

const treasuryId = process.env.STELLARSAFE_TREASURY_ID;
if (!treasuryId) throw new Error("Set STELLARSAFE_TREASURY_ID");

const client = new StellarSafeClient({
  network: "testnet",
  ...(process.env.STELLAR_RPC_URL ? { rpcUrl: process.env.STELLAR_RPC_URL } : {}),
});

const safe = client.treasury(treasuryId);
await safe.assertCompatible();

const [{ config, policy, members, pendingProposals }, { closeTime: now }] = await Promise.all([
  safe.getSnapshot(),
  client.getLedgerTime(),
]);

console.log(`${config.name} — policy v${policy.version}`);
console.log(`Members:`);
for (const m of members) console.log(`  ${m.role.padEnd(8)} ${m.address}`);

const period = periodBounds(policy.period, now);
console.log(
  `\nSpending period #${period.index} (${new Date(Number(period.start) * 1000).toISOString()} →)`,
);
for (const limit of policy.departmentLimits) {
  const s = await safe.getSpending(limit.department, limit.token);
  console.log(`  ${limit.department}: ${formatAmount(s.spent)} / ${formatAmount(s.limit)} spent`);
}

console.log(`\nPending proposals:`);
for (const p of pendingProposals) {
  const state = getProposalState(p, now, policy.version);
  console.log(
    `  #${p.id} ${formatAmount(p.amount)} → ${p.recipient} [${state}] ` +
      `${p.approvals.length}/${p.requiredApprovals} approvals — ${p.memo}`,
  );
}
