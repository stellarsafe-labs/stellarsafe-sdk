import {
  canApprove,
  checkPayment,
  formatAmount,
  getProposalState,
  NETWORKS,
  type PreparedTransaction,
  type Proposal,
  parseAmount,
  StellarSafeClient,
  type TransactionResult,
  type TransactionSigner,
  type TreasurySnapshot,
} from "@stellarsafe/sdk";
import { explainError } from "./errors.js";
import {
  connectWallet,
  disconnectWallet,
  initWallets,
  refreshWallet,
  walletNetworkPassphrase,
} from "./wallet.js";
import "./style.css";

const TESTNET = NETWORKS.testnet.networkPassphrase;
const EXPLORER = "https://stellar.expert/explorer/testnet";

const rpcUrl = import.meta.env.VITE_STELLAR_RPC_URL as string | undefined;
const client = new StellarSafeClient({
  network: "testnet",
  ...(rpcUrl ? { rpcUrl } : {}),
});

let signer: TransactionSigner | undefined;
let snapshot: TreasurySnapshot | undefined;
let ledgerNow = 0n;

// ---------------------------------------------------------------- DOM helpers

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

type Child = Node | string;

/** Build an element. Text is always set with textContent: on-chain strings are untrusted. */
function el(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function short(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

function addr(address: string): HTMLElement {
  return el("span", { class: "mono", title: address }, short(address));
}

function xlm(stroops: string | bigint): string {
  return `${formatAmount(BigInt(stroops))} XLM`;
}

function showMessage(kind: "info" | "success" | "error", text: string, link?: string): void {
  const box = $("message");
  box.className = kind;
  box.replaceChildren(text);
  if (link) box.append(" ", el("a", { href: link, target: "_blank", rel: "noopener" }, "View"));
  box.hidden = false;
}

/**
 * Run one user action: disable buttons while it runs, report any error, and
 * always re-enable, so a rejected signature or failed call leaves the app usable.
 */
async function action(fn: () => Promise<void>): Promise<void> {
  const buttons = document.querySelectorAll<HTMLButtonElement>("main > :not(dialog) button");
  for (const b of buttons) b.disabled = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showMessage("error", explainError(err));
  } finally {
    for (const b of buttons) b.disabled = false;
    renderWallet();
    if (snapshot) renderTreasury(snapshot);
  }
}

// --------------------------------------------------------------------- wallet

function renderWallet(): void {
  $("wallet-address").replaceChildren(signer ? addr(signer.address) : "Not connected");
  $("connect").hidden = signer !== undefined;
  $("disconnect").hidden = signer === undefined;
}

$("connect").addEventListener("click", () =>
  action(async () => {
    signer = await connectWallet();
    const passphrase = await walletNetworkPassphrase();
    if (passphrase !== TESTNET) {
      showMessage("error", `Your wallet is on "${passphrase}". Switch it to Testnet.`);
    } else {
      showMessage("success", `Connected ${signer.address}`);
    }
  }),
);

$("disconnect").addEventListener("click", () =>
  action(async () => {
    await disconnectWallet();
    signer = undefined;
    showMessage("info", "Disconnected.");
  }),
);

function requireSigner(): TransactionSigner {
  if (!signer) throw new Error("Connect a wallet first.");
  return signer;
}

// ------------------------------------------------------------------- treasury

async function loadTreasury(contractId: string, minLedger?: number): Promise<void> {
  const [snap, time] = await Promise.all([
    client.getTreasury(contractId, minLedger ? { minLedger } : undefined),
    client.getLedgerTime(),
  ]);
  snapshot = snap;
  ledgerNow = time.closeTime;
  const url = new URL(location.href);
  url.searchParams.set("treasury", contractId);
  history.replaceState(null, "", url);
  $("departments").replaceChildren(
    ...[...new Set(snap.policy.departmentLimits.map((l) => l.department))].map((d) =>
      el("option", { value: d }),
    ),
  );
}

function renderTreasury(snap: TreasurySnapshot): void {
  const { config, policy, members, pendingProposals } = snap;
  const me = signer?.address;
  const myRole = members.find((m) => m.address === me)?.role;

  const policyRows: [string, Child][] = [
    ["Version", String(policy.version)],
    ["Default approvals", String(policy.defaultApprovals)],
    [
      "Thresholds",
      policy.thresholds.length
        ? policy.thresholds
            .map((t) => `≥ ${formatAmount(t.minAmount)} → ${t.approvals} approvals`)
            .join("; ")
        : "none",
    ],
    [
      "Recipient allowlist",
      policy.recipientAllowlistEnabled
        ? el("span", {}, ...policy.allowedRecipients.flatMap((r) => [addr(r), " "]))
        : "off",
    ],
    [
      "Allowed tokens",
      policy.allowedTokens.length
        ? el("span", {}, ...policy.allowedTokens.flatMap((t) => [addr(t), " "]))
        : "any",
    ],
    [
      "Department limits",
      el(
        "span",
        {},
        ...policy.departmentLimits.flatMap((l) => [
          `${l.department}: ${formatAmount(l.limit)} of `,
          addr(l.token),
          el("br"),
        ]),
      ),
    ],
    ["Period", `${Number(policy.period.length) / 86_400} days`],
    ["Max proposal lifetime", `${Number(policy.maxProposalTtl) / 3_600} hours`],
  ];

  $("treasury").replaceChildren(
    el("h3", {}, `${config.name} `, el("small", {}, `(ledger ${snap.ledger})`)),
    el("p", {}, me ? `Your role: ${myRole ?? "not a member"}` : "Connect a wallet to act."),
    el("h4", {}, "Policy"),
    el("dl", {}, ...policyRows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    el("h4", {}, `Members (${members.length})`),
    el(
      "table",
      {},
      ...members.map((m) =>
        el(
          "tr",
          {},
          el("td", {}, m.role),
          el("td", { class: "mono" }, m.address, m.address === me ? " (you)" : ""),
        ),
      ),
    ),
    el("h4", {}, `Pending proposals (${pendingProposals.length})`),
    pendingProposals.length ? proposalTable(snap, pendingProposals) : el("p", {}, "None."),
  );
}

function proposalTable(snap: TreasurySnapshot, proposals: readonly Proposal[]): HTMLElement {
  const header = el(
    "tr",
    {},
    ...["#", "Amount", "To", "Dept", "Memo", "Approvals", "State", ""].map((h) => el("th", {}, h)),
  );
  const rows = proposals.map((p) => {
    const state = getProposalState(p, ledgerNow, snap.policy.version);
    const button = el("button", { type: "button" }, "Approve") as HTMLButtonElement;
    const allowed = signer !== undefined && canApprove(p, snap.members, signer.address);
    button.disabled = !allowed || state !== "pending";
    button.title = !signer
      ? "Connect a wallet"
      : !allowed
        ? "You are not an approver or already approved"
        : state !== "pending"
          ? `Proposal is ${state}`
          : "";
    button.addEventListener("click", () => action(() => approve(snap.contractId, p.id)));
    return el(
      "tr",
      {},
      el("td", {}, String(p.id)),
      el("td", {}, formatAmount(p.amount)),
      el("td", {}, addr(p.recipient)),
      el("td", {}, p.department),
      el("td", {}, p.memo),
      el("td", {}, `${p.approvals.length}/${p.requiredApprovals}`),
      el("td", {}, state),
      el("td", {}, button),
    );
  });
  return el("table", {}, header, ...rows);
}

$<HTMLFormElement>("load-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $<HTMLInputElement>("treasury-id").value.trim();
  void action(async () => {
    showMessage("info", "Loading treasury…");
    await loadTreasury(id);
    showMessage("success", "Treasury loaded.");
  });
});

// ----------------------------------------------------- review, sign, submit

/** Show what will happen and the fee; resolve true if the user clicks Sign. */
function review(title: string, rows: [string, string][], hint = ""): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("review");
  $("review-title").textContent = title;
  $("review-details").replaceChildren(
    ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", { class: "mono" }, v)]),
  );
  $("review-hint").textContent = hint;
  dialog.showModal();
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      dialog.close();
      sign.removeEventListener("click", onSign);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      resolve(ok);
    };
    const sign = $("review-sign");
    const cancel = $("review-cancel");
    const onSign = () => done(true);
    const onCancel = () => done(false);
    sign.addEventListener("click", onSign);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
  });
}

function feeRows<T>(tx: PreparedTransaction<T>): [string, string][] {
  return [
    ["Max fee", xlm(tx.fee.total)],
    ["  inclusion", xlm(tx.fee.inclusion)],
    ["  resources", xlm(tx.fee.resource)],
    ["Simulated at ledger", String(tx.simulatedAtLedger)],
    ["Tx hash", tx.hash],
  ];
}

function feePayer(): string | undefined {
  const value = $<HTMLInputElement>("fee-payer").value.trim();
  return value && value !== signer?.address ? value : undefined;
}

/**
 * Ask the wallet to sign and submit. With a fee payer set, the connected
 * member first signs only the authorization (`signAuthEntries`), then the
 * user switches the wallet to the fee payer to sign the envelope.
 */
async function signAndSubmit<T>(
  tx: PreparedTransaction<T>,
  member: TransactionSigner,
): Promise<TransactionResult<T> | undefined> {
  const payer = feePayer();
  if (!payer) {
    showMessage("info", "Waiting for the wallet signature…");
    return tx.signAndSubmit(member);
  }

  showMessage("info", "Waiting for the wallet to sign the authorization entry…");
  const authorized = await tx.signAuthEntries(member);
  const ok = await review(
    "Authorization signed — now sign as the fee payer",
    [["Fee payer", payer], ...feeRows(authorized)],
    `Switch the wallet to ${short(payer)}, then click Sign. The fee was re-estimated with the signature in place.`,
  );
  if (!ok) return undefined;
  const payerSigner = await refreshWallet();
  if (payerSigner.address !== payer) {
    throw new Error(`Wallet is on ${payerSigner.address}, expected fee payer ${payer}.`);
  }
  showMessage("info", "Waiting for the fee payer's signature…");
  return authorized.signAndSubmit(payerSigner);
}

function reportSuccess<T>(what: string, result: TransactionResult<T>): void {
  showMessage(
    "success",
    `${what} in ledger ${result.ledger}. Fee charged: ${xlm(result.feeCharged)}.`,
    `${EXPLORER}/tx/${result.hash}`,
  );
}

// ------------------------------------------------------------------- propose

$<HTMLFormElement>("propose-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget as HTMLFormElement);
  const field = (name: string) => String(form.get(name) ?? "").trim();
  void action(async () => {
    const member = requireSigner();
    if (!snapshot) throw new Error("Load a treasury first.");
    const { contractId, policy } = snapshot;
    const safe = client.treasury(contractId);
    const { closeTime } = await client.getLedgerTime();

    const request = {
      token: field("token"),
      recipient: field("recipient"),
      amount: parseAmount(field("amount")),
      department: field("department"),
      memo: field("memo"),
      expiresAt: closeTime + BigInt(field("hours")) * 3600n,
    };

    // Advisory pre-check, so the user sees problems before paying anything.
    // We still simulate below, so the contract's own error is shown by name.
    const spending = await safe
      .getSpending(request.department, request.token)
      .catch(() => undefined);
    const violations = checkPayment(policy, request, {
      now: closeTime,
      ...(spending ? { spent: spending.spent } : {}),
    });
    $("violations").replaceChildren(
      ...violations.map((v) => el("li", {}, `${v.code}: ${v.message}`)),
    );

    showMessage("info", "Simulating proposal…");
    const payer = feePayer();
    const tx = await safe.proposePayment(
      { proposer: member.address, ...request },
      payer ? { source: payer } : {},
    );
    const ok = await review(`Propose payment — will create proposal #${tx.result}`, [
      ["Amount", formatAmount(request.amount)],
      ["Recipient", request.recipient],
      ["Department", request.department],
      ...feeRows(tx),
    ]);
    if (!ok) return showMessage("info", "Cancelled. Nothing was signed.");

    const result = await signAndSubmit(tx, member);
    if (!result) return showMessage("info", "Cancelled. Nothing was submitted.");
    await loadTreasury(contractId, result.ledger);
    reportSuccess(`Created proposal #${result.result}`, result);
  });
});

// ------------------------------------------------------------------- approve

async function approve(contractId: string, proposalId: bigint): Promise<void> {
  const member = requireSigner();
  const payer = feePayer();
  showMessage("info", `Simulating approval of #${proposalId}…`);
  const tx = await client
    .treasury(contractId)
    .approvePayment({ approver: member.address, proposalId }, payer ? { source: payer } : {});
  const ok = await review(`Approve proposal #${proposalId}`, feeRows(tx));
  if (!ok) return showMessage("info", "Cancelled. Nothing was signed.");

  const result = await signAndSubmit(tx, member);
  if (!result) return showMessage("info", "Cancelled. Nothing was submitted.");
  await loadTreasury(contractId, result.ledger);
  reportSuccess(`Approved proposal #${proposalId}`, result);
}

// ---------------------------------------------------------------------- init

initWallets();
renderWallet();
const initialId =
  new URLSearchParams(location.search).get("treasury") ??
  (import.meta.env.VITE_TREASURY_ID as string | undefined) ??
  "";
$<HTMLInputElement>("treasury-id").value = initialId;
if (initialId) {
  void action(async () => {
    await loadTreasury(initialId);
    showMessage("info", "Treasury loaded. Connect a wallet to propose or approve.");
  });
}
