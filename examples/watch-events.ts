/**
 * Stream treasury activity until Ctrl-C. Resumes from the last cursor.
 *
 *   npm run build
 *   STELLARSAFE_TREASURY_ID=C… node examples/watch-events.ts
 */
import { formatAmount, isStellarSafeError, StellarSafeClient } from "@stellarsafe/sdk";

const treasuryId = process.env.STELLARSAFE_TREASURY_ID;
if (!treasuryId) throw new Error("Set STELLARSAFE_TREASURY_ID");

const client = new StellarSafeClient({ network: "testnet" });
const { sequence } = await client.getLedgerTime();

const ac = new AbortController();
process.on("SIGINT", () => ac.abort());

try {
  for await (const event of client.streamEvents({
    contractIds: [treasuryId],
    startLedger: Math.max(1, sequence - 17_280), // ~1 day back
    signal: ac.signal,
  })) {
    const at = `[ledger ${event.meta.ledger}]`;
    switch (event.type) {
      case "proposed":
        console.log(
          at,
          `#${event.data.proposalId} proposed: ${formatAmount(event.data.amount)} → ${event.data.recipient}`,
        );
        break;
      case "approved":
        console.log(
          at,
          `#${event.data.proposalId} approved by ${event.data.approver} (${event.data.approvals})`,
        );
        break;
      case "executed":
        console.log(at, `#${event.data.proposalId} executed, tx ${event.meta.txHash}`);
        break;
      default:
        console.log(at, event.type, event.data);
    }
  }
} catch (err) {
  if (!(isStellarSafeError(err) && err.code === "ABORTED")) throw err;
}
