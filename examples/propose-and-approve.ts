/**
 * Propose a payment, check it against the policy, approve and execute it.
 *
 *   npm run build
 *   STELLARSAFE_TREASURY_ID=C… TOKEN_ID=C… RECIPIENT=G… \
 *   PROPOSER_SECRET=S… APPROVER_SECRET=S… node examples/propose-and-approve.ts
 */
import {
  checkPayment,
  formatAmount,
  isContractError,
  keypairSigner,
  parseAmount,
  StellarSafeClient,
} from "@stellarsafe/sdk";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};

const client = new StellarSafeClient({ network: "testnet" });
const safe = client.treasury(env("STELLARSAFE_TREASURY_ID"));
const proposer = keypairSigner(env("PROPOSER_SECRET"));
const approver = keypairSigner(env("APPROVER_SECRET"));

const { closeTime: now } = await client.getLedgerTime();
const request = {
  token: env("TOKEN_ID"),
  recipient: env("RECIPIENT"),
  amount: parseAmount("10"),
  department: "ops",
  memo: "SDK example payment",
  expiresAt: now + 24n * 3600n,
};

// 1. Explain problems before spending fees.
const [policy, spending] = await Promise.all([
  safe.getPolicy(),
  safe.getSpending(request.department, request.token),
]);
const violations = checkPayment(policy, request, { now, spent: spending.spent });
if (violations.length > 0) {
  for (const v of violations) console.error(`✗ ${v.code}: ${v.message}`);
  process.exit(1);
}

// 2. Prepare (simulates on-chain) and inspect before signing.
const proposal = await safe.proposePayment({ proposer: proposer.address, ...request });
console.log(
  `Will create proposal #${proposal.result}, max fee ${formatAmount(BigInt(proposal.fee.total))} XLM`,
);
const { result: proposalId, hash } = await proposal.signAndSubmit(proposer);
console.log(`Proposed #${proposalId} in ${hash}`);

// 3. Approve and execute with a bound signer.
const ops = safe.connect(approver);
await ops.approvePayment({ proposalId });
try {
  const { hash: execHash, events } = await ops.executePayment({ proposalId });
  console.log(
    `Executed in ${execHash}`,
    events.map((e) => e.type),
  );
} catch (err) {
  if (isContractError(err, "InsufficientApprovals")) {
    console.log("More approvals needed before execution.");
  } else {
    throw err;
  }
}
