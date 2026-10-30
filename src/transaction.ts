/**
 * Build → simulate → assemble → sign → submit → confirm pipeline for
 * Soroban transactions.
 *
 * @module
 */
import {
  Account,
  authorizeEntry,
  Contract,
  type FeeBumpTransaction,
  Operation,
  rpc,
  Address as StellarAddress,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { base64ToBytes } from "./encoding.js";
import {
  ContractError,
  parseContractErrorCode,
  RestoreRequiredError,
  RpcError,
  SimulationError,
  StellarSafeError,
  TransactionError,
} from "./errors.js";
import { decodeEvent, type StellarSafeEventWithMeta } from "./events.js";
import { type RetryOptions, sleep, throwIfAborted, withRetry } from "./retry.js";
import type { TransactionSigner } from "./signer.js";

/** The subset of `rpc.Server` the SDK uses. Implement it to plug in a custom transport or mock. */
export type RpcClient = Pick<
  rpc.Server,
  | "getAccount"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getEvents"
  | "getLatestLedger"
  | "getNetwork"
>;

/**
 * Placeholder source for read-only simulations. Simulation does not check
 * the source account, so reads need no funded account.
 */
export const READ_ONLY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Options for building a write transaction. */
export interface PrepareOptions extends ReadConsistency {
  /**
   * Account that pays the fee and sequence number. Defaults to the acting
   * member. When it differs, the member must authorize the call separately
   * with {@link PreparedTransaction.signAuthEntries}.
   */
  readonly source: string;
  /** Inclusion fee bid in stroops (excluding resource fee). Default: 100_000 (0.01 XLM). */
  readonly fee?: string | number;
  /** Seconds until the transaction expires. Default: 300. */
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * Read-your-writes control. Public RPC endpoints are load-balanced, so a read
 * right after a confirmed write can hit a node that has not seen it yet.
 */
export interface ReadConsistency {
  /**
   * Only accept results simulated at or after this ledger; re-simulate until
   * the RPC node catches up. Pass `result.ledger` from the write you just made.
   */
  readonly minLedger?: number;
  /** How long to wait for the node to reach `minLedger`, in ms. Default 30_000. */
  readonly minLedgerTimeoutMs?: number;
}

/** Options for submitting a signed transaction. */
export interface SubmitOptions {
  /** How long to wait for the transaction to be included in a ledger, in ms. Default 60_000. */
  readonly timeoutMs?: number;
  /** Interval between `getTransaction` polls, in ms. Default 1_000. */
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/** Options for {@link PreparedTransaction.signAuthEntries}. */
export interface SignAuthOptions {
  /** How many ledgers (~5 s each) the authorization stays valid. Default 100 (~8 minutes). */
  readonly validForLedgers?: number;
  readonly signal?: AbortSignal;
}

/** Fee breakdown in stroops, as decimal strings. */
export interface FeeEstimate {
  /** Inclusion fee bid. */
  readonly inclusion: string;
  /** Minimum resource fee from simulation. */
  readonly resource: string;
  /** Maximum total fee the source can be charged. */
  readonly total: string;
}

/** Outcome of a confirmed transaction. */
export interface TransactionResult<T> {
  readonly hash: string;
  readonly ledger: number;
  /** Decoded contract return value. */
  readonly result: T;
  /** StellarSafe events emitted by the transaction. */
  readonly events: readonly StellarSafeEventWithMeta[];
  /** Fee actually charged, in stroops. */
  readonly feeCharged: bigint;
}

interface PipelineConfig {
  readonly rpc: RpcClient;
  readonly networkPassphrase: string;
  readonly retry: RetryOptions;
}

/** @internal */
export type Decode<T> = (v: xdr.ScVal) => T;

/** @internal Shared plumbing used by every client. */
export class TransactionPipeline {
  private networkVerified: Promise<void> | undefined;
  /** Highest ledger in which this pipeline saw one of its transactions applied. */
  private lastWriteLedger = 0;
  /** Last sequence number this pipeline consumed per source account. */
  private readonly sequences = new Map<string, bigint>();

  constructor(private readonly config: PipelineConfig) {}

  get networkPassphrase(): string {
    return this.config.networkPassphrase;
  }

  /** Run an RPC call with retries, wrapping unknown failures in {@link RpcError}. */
  async call<T>(
    label: string,
    fn: (rpc: RpcClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await withRetry(() => fn(this.config.rpc), this.config.retry, signal);
    } catch (err) {
      if (err instanceof StellarSafeError) throw err;
      throw new RpcError(`RPC ${label} failed: ${describe(err)}`, { cause: err });
    }
  }

  /**
   * Ensure the RPC server is on the configured network. Runs once per
   * pipeline; prevents signing a transaction for the wrong network.
   */
  verifyNetwork(signal?: AbortSignal): Promise<void> {
    if (!this.networkVerified) {
      const check = this.call("getNetwork", (r) => r.getNetwork(), signal).then((network) => {
        if (network.passphrase !== this.config.networkPassphrase) {
          throw new StellarSafeError(
            "NETWORK_MISMATCH",
            `RPC server is on "${network.passphrase}" but the client is configured for "${this.config.networkPassphrase}"`,
          );
        }
      });
      // Allow a retry after a failure instead of caching the rejection forever.
      check.catch(() => {
        if (this.networkVerified === check) this.networkVerified = undefined;
      });
      this.networkVerified = check;
    }
    return this.networkVerified;
  }

  /** Simulate a read-only call and decode its return value. */
  async read<T>(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    decode: Decode<T>,
    opts: ReadConsistency & { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<{ result: T; latestLedger: number }> {
    const tx = this.build(
      new Account(READ_ONLY_SOURCE, "0"),
      contractCall(contractId, method, args),
      {},
    );
    const sim = await this.simulateAtLeast(tx, opts);
    return { result: decodeRetval(sim, decode), latestLedger: sim.latestLedger };
  }

  /**
   * Simulate, re-trying on a node that has not yet reached `minLedger`
   * (default: the last ledger this pipeline wrote in — read-your-writes).
   */
  private async simulateAtLeast(
    tx: Transaction,
    opts: ReadConsistency & { readonly signal?: AbortSignal | undefined },
    authMode?: rpc.Api.SimulationAuthMode,
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    const minLedger = opts.minLedger ?? this.lastWriteLedger;
    const deadline = Date.now() + (opts.minLedgerTimeoutMs ?? 30_000);
    for (;;) {
      const sim = await this.simulate(tx, opts.signal, authMode);
      if (sim.latestLedger >= minLedger) return sim;
      // Load-balanced RPC: this node has not yet seen the ledger we need.
      if (Date.now() >= deadline) {
        throw new RpcError(
          `RPC node is at ledger ${sim.latestLedger}, behind the required ledger ${minLedger}`,
        );
      }
      await sleep(READ_RETRY_MS, opts.signal);
    }
  }

  /** Load the source account, never going backwards from a sequence this pipeline already used. */
  private async loadAccount(source: string, signal?: AbortSignal): Promise<Account> {
    const account = await this.call("getAccount", (r) => r.getAccount(source), signal);
    const known = this.sequences.get(source);
    if (known !== undefined && BigInt(account.sequenceNumber()) < known) {
      // A lagging RPC node returned a stale sequence; the next valid one follows ours.
      return new Account(source, known.toString());
    }
    return account;
  }

  /** Build, simulate and assemble a contract call, ready for signing. */
  prepare<T>(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    decode: Decode<T>,
    opts: PrepareOptions,
  ): Promise<PreparedTransaction<T>> {
    return this.prepareOperation(contractCall(contractId, method, args), decode, opts);
  }

  /** Build, simulate and assemble any single host-function operation. */
  async prepareOperation<T>(
    operation: xdr.Operation,
    decode: Decode<T>,
    opts: PrepareOptions,
  ): Promise<PreparedTransaction<T>> {
    assertSource(opts.source);
    await this.verifyNetwork(opts.signal);
    const account = await this.loadAccount(opts.source, opts.signal);
    const raw = this.build(account, operation, opts);
    const sim = await this.simulateAtLeast(raw, opts);
    const result = decodeRetval(sim, decode);
    const assembled = rpc.assembleTransaction(raw, sim).build();
    return new PreparedTransaction(this, assembled, result, sim, decode, inclusionFee(opts));
  }

  /**
   * Prepare a transaction that restores archived ledger entries reported by
   * a {@link RestoreRequiredError}. Submit it, then retry the original call.
   */
  async prepareRestore(
    error: RestoreRequiredError,
    opts: PrepareOptions,
  ): Promise<PreparedTransaction<void>> {
    assertSource(opts.source);
    await this.verifyNetwork(opts.signal);
    const account = await this.loadAccount(opts.source, opts.signal);
    const inclusion = inclusionFee(opts);
    const tx = new TransactionBuilder(account, {
      fee: (BigInt(inclusion) + BigInt(error.minResourceFee)).toString(),
      networkPassphrase: this.config.networkPassphrase,
    })
      .setSorobanData(error.transactionData)
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .build();
    return new PreparedTransaction(
      this,
      tx,
      undefined,
      { minResourceFee: error.minResourceFee, latestLedger: 0 },
      () => undefined,
      inclusion,
    );
  }

  /** @internal Re-simulate a transaction whose auth entries are now signed, enforcing them. */
  async resimulate(
    tx: Transaction,
    signal?: AbortSignal,
  ): Promise<{
    transaction: Transaction;
    sim: rpc.Api.SimulateTransactionSuccessResponse;
  }> {
    const sim = await this.simulateAtLeast(tx, { signal }, "enforce");
    return { transaction: rpc.assembleTransaction(tx, sim).build(), sim };
  }

  private build(
    source: Account,
    operation: xdr.Operation,
    opts: Pick<PrepareOptions, "fee" | "timeoutSeconds">,
  ): Transaction {
    return new TransactionBuilder(source, {
      fee: inclusionFee(opts),
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .build();
  }

  private async simulate(
    tx: Transaction,
    signal?: AbortSignal,
    authMode?: rpc.Api.SimulationAuthMode,
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    const sim = await this.call(
      "simulateTransaction",
      (r) =>
        authMode ? r.simulateTransaction(tx, undefined, authMode) : r.simulateTransaction(tx),
      signal,
    );
    if (rpc.Api.isSimulationError(sim)) {
      const code = parseContractErrorCode(sim.error) ?? findContractErrorCode(sim.events);
      if (code !== undefined) throw new ContractError(code, { cause: sim.error });
      throw new SimulationError(sim.error);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new RestoreRequiredError(
        sim.restorePreamble.minResourceFee,
        sim.restorePreamble.transactionData.build().toXdr("base64"),
      );
    }
    return sim;
  }

  /** Submit a signed transaction and wait for it to be confirmed. */
  async submit<T>(
    tx: Transaction | FeeBumpTransaction,
    decode: Decode<T>,
    opts: SubmitOptions = {},
  ): Promise<TransactionResult<T>> {
    const hash = txHash(tx);
    const sent = await this.sendWithBackoff(tx, hash, opts.signal);
    if (sent.status === "ERROR") {
      const reason = sent.errorResult?.result.type ?? "unknown";
      throw new TransactionError(
        "SUBMISSION_FAILED",
        hash,
        `Transaction rejected by the network: ${reason}`,
        contractCause(findContractErrorCode(sent.diagnosticEvents)),
      );
    }
    const res = await this.waitForTransaction(hash, opts);
    this.recordApplied(tx, res.ledger);
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      const code = findContractErrorCode(res.diagnosticEventsXdr);
      const detail =
        code === undefined ? res.resultXdr.result.type : new ContractError(code).message;
      throw new TransactionError(
        "TRANSACTION_FAILED",
        hash,
        `Transaction ${hash} failed on-chain: ${detail}`,
        contractCause(code),
      );
    }
    return {
      hash,
      ledger: res.ledger,
      result: decode(res.returnValue ?? VOID),
      events: decodeTransactionEvents(res, hash),
      feeCharged: res.resultXdr.feeCharged,
    };
  }

  /** Remember what an applied transaction consumed, for session consistency. */
  private recordApplied(tx: Transaction | FeeBumpTransaction, ledger: number): void {
    this.lastWriteLedger = Math.max(this.lastWriteLedger, ledger);
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const seq = BigInt(inner.sequence);
    if ((this.sequences.get(inner.source) ?? -1n) < seq) this.sequences.set(inner.source, seq);
  }

  private async sendWithBackoff(
    tx: Transaction | FeeBumpTransaction,
    hash: string,
    signal?: AbortSignal,
  ): Promise<rpc.Api.SendTransactionResponse> {
    for (let attempt = 0; ; attempt++) {
      const sent = await this.call("sendTransaction", (r) => r.sendTransaction(tx), signal);
      if (sent.status !== "TRY_AGAIN_LATER") return sent;
      if (attempt >= MAX_TRY_AGAIN) {
        throw new TransactionError(
          "SUBMISSION_FAILED",
          hash,
          "RPC server kept answering TRY_AGAIN_LATER; the network may be congested. Retry with a higher fee.",
        );
      }
      await sleep(1000 * 2 ** attempt, signal);
    }
  }

  private async waitForTransaction(
    hash: string,
    opts: SubmitOptions,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const interval = opts.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(opts.signal);
      const res = await this.call("getTransaction", (r) => r.getTransaction(hash), opts.signal);
      if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return res;
      if (Date.now() + interval > deadline) {
        throw new TransactionError(
          "TRANSACTION_TIMEOUT",
          hash,
          `Transaction ${hash} was not confirmed within ${timeoutMs}ms. It may still be included; ` +
            "check its status before resubmitting.",
        );
      }
      await sleep(interval, opts.signal);
    }
  }
}

/**
 * A simulated, assembled transaction ready to be signed and submitted.
 *
 * Inspect {@link result} (the simulated return value) and {@link fee} before
 * asking the user to sign. Instances are immutable: {@link signAuthEntries}
 * returns a new one.
 */
export class PreparedTransaction<T> {
  /** Return value from simulation — what the call will return if nothing changes before submission. */
  readonly result: T;
  readonly fee: FeeEstimate;
  /** Ledger the simulation ran against. */
  readonly simulatedAtLedger: number;
  /**
   * Addresses that must still authorize this call with
   * {@link signAuthEntries} before it can be submitted. Empty when the
   * acting member is the transaction source.
   */
  readonly authRequired: readonly string[];

  /** @internal */
  constructor(
    private readonly pipeline: TransactionPipeline,
    /** The assembled transaction, including Soroban resources and auth. */
    readonly transaction: Transaction,
    result: T,
    sim: Pick<rpc.Api.SimulateTransactionSuccessResponse, "minResourceFee" | "latestLedger">,
    private readonly decode: Decode<T>,
    private readonly inclusionFee: string,
  ) {
    this.result = result;
    this.simulatedAtLedger = sim.latestLedger;
    this.fee = { inclusion: inclusionFee, resource: sim.minResourceFee, total: transaction.fee };
    this.authRequired = unsignedAuthAddresses(transaction);
  }

  /** Transaction hash (hex). Signing the envelope does not change it. */
  get hash(): string {
    return txHash(this.transaction);
  }

  /** Base64 transaction envelope XDR, e.g. for an external wallet or multisig flow. */
  toXDR(): string {
    return this.transaction.toXDR();
  }

  /**
   * Authorize the call as `signer.address` when that member is not the
   * transaction source — for example when a relayer or sponsor pays fees.
   *
   * The signer must implement `signAuthEntry` (SEP-43; Freighter and
   * {@link keypairSigner} do). The transaction is then re-simulated with the
   * signatures enforced, so resources and fees stay accurate.
   *
   * @returns a new PreparedTransaction (with a new hash) to sign and submit.
   */
  async signAuthEntries(
    signer: TransactionSigner,
    opts: SignAuthOptions = {},
  ): Promise<PreparedTransaction<T>> {
    const { signAuthEntry } = signer;
    if (!signAuthEntry) {
      throw new StellarSafeError("SIGNING_FAILED", "Signer does not implement signAuthEntry");
    }
    if (!this.authRequired.includes(signer.address)) {
      throw new StellarSafeError(
        "INVALID_ARGUMENT",
        `${signer.address} has no pending authorization in this transaction` +
          (this.authRequired.length ? ` (pending: ${this.authRequired.join(", ")})` : ""),
      );
    }
    const op = invokeOperation(this.transaction);
    const passphrase = this.pipeline.networkPassphrase;
    const validUntil = this.simulatedAtLedger + (opts.validForLedgers ?? 100);
    const auth: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of op.auth ?? []) {
      if (authEntryAddress(entry) !== signer.address || isSigned(entry)) {
        auth.push(entry);
        continue;
      }
      let signedEntry: xdr.SorobanAuthorizationEntry;
      try {
        signedEntry = await authorizeEntry(
          entry,
          async (preimage) => {
            let res: Awaited<ReturnType<typeof signAuthEntry>>;
            try {
              res = await signAuthEntry(preimage.toXdr("base64"), {
                networkPassphrase: passphrase,
                address: signer.address,
              });
            } catch (err) {
              throw new StellarSafeError("SIGNING_FAILED", `Signer threw: ${describe(err)}`, {
                cause: err,
              });
            }
            if (res.error) {
              throw new StellarSafeError(
                "SIGNING_FAILED",
                `Signer returned an error: ${describe(res.error)}`,
                { cause: res.error },
              );
            }
            return { signature: base64ToBytes(res.signedAuthEntry), publicKey: signer.address };
          },
          validUntil,
          passphrase,
        );
      } catch (err) {
        if (err instanceof StellarSafeError) throw err;
        throw new StellarSafeError(
          "SIGNING_FAILED",
          `Authorization signature for ${signer.address} is invalid: ${describe(err)}`,
          { cause: err },
        );
      }
      auth.push(signedEntry);
    }
    const source = this.transaction.source;
    const rebuilt = new TransactionBuilder(
      new Account(source, (BigInt(this.transaction.sequence) - 1n).toString()),
      {
        fee: this.inclusionFee,
        networkPassphrase: passphrase,
        ...(this.transaction.timeBounds ? { timebounds: this.transaction.timeBounds } : {}),
      },
    )
      .addOperation(
        Operation.invokeHostFunction({
          func: op.func,
          auth,
          ...(op.source ? { source: op.source } : {}),
        }),
      )
      .build();
    const { transaction, sim } = await this.pipeline.resimulate(rebuilt, opts.signal);
    return new PreparedTransaction(
      this.pipeline,
      transaction,
      this.result,
      sim,
      this.decode,
      this.inclusionFee,
    );
  }

  /**
   * Sign the envelope with `signer` (the transaction source). Verifies the
   * wallet returned the same transaction (identical hash) with a new signature.
   *
   * @returns the signed transaction envelope (base64 XDR).
   */
  async sign(signer: TransactionSigner): Promise<string> {
    if (this.authRequired.length > 0) {
      throw new StellarSafeError(
        "AUTH_REQUIRED",
        `Authorization still needed from ${this.authRequired.join(", ")}. ` +
          "Call signAuthEntries() with their signer first.",
      );
    }
    const passphrase = this.pipeline.networkPassphrase;
    let signed: Awaited<ReturnType<TransactionSigner["signTransaction"]>>;
    try {
      signed = await signer.signTransaction(this.toXDR(), {
        networkPassphrase: passphrase,
        address: signer.address,
      });
    } catch (err) {
      throw new StellarSafeError("SIGNING_FAILED", `Signer threw: ${describe(err)}`, {
        cause: err,
      });
    }
    if (signed.error) {
      throw new StellarSafeError(
        "SIGNING_FAILED",
        `Signer returned an error: ${describe(signed.error)}`,
        { cause: signed.error },
      );
    }
    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = TransactionBuilder.fromXDR(signed.signedTxXdr, passphrase);
    } catch (err) {
      throw new StellarSafeError("SIGNING_FAILED", "Signer returned invalid transaction XDR", {
        cause: err,
      });
    }
    if (txHash(parsed) !== this.hash) {
      throw new StellarSafeError(
        "SIGNING_FAILED",
        "Signer returned a different transaction than the one prepared. Refusing to submit.",
      );
    }
    if (parsed.signatures.length <= this.transaction.signatures.length) {
      throw new StellarSafeError(
        "SIGNING_FAILED",
        "Signer returned the transaction without a signature",
      );
    }
    return signed.signedTxXdr;
  }

  /** Submit a signed envelope (from {@link sign}) and wait for confirmation. */
  async submit(signedXdr: string, opts?: SubmitOptions): Promise<TransactionResult<T>> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.pipeline.networkPassphrase);
    if (txHash(tx) !== this.hash) {
      throw new StellarSafeError(
        "INVALID_ARGUMENT",
        "signedXdr is not a signed copy of this transaction",
      );
    }
    return this.pipeline.submit(tx, this.decode, opts);
  }

  /** Sign and submit in one step. */
  async signAndSubmit(
    signer: TransactionSigner,
    opts?: SubmitOptions,
  ): Promise<TransactionResult<T>> {
    return this.submit(await this.sign(signer), opts);
  }
}

const DEFAULT_FEE = 100_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TRY_AGAIN = 4;
const READ_RETRY_MS = 500;
const VOID = xdr.ScVal.scvVoid();

function contractCall(contractId: string, method: string, args: readonly xdr.ScVal[]) {
  return new Contract(contractId).call(method, ...args);
}

function inclusionFee(opts: Pick<PrepareOptions, "fee">): string {
  const fee = String(opts.fee ?? DEFAULT_FEE);
  if (!/^\d+$/.test(fee) || BigInt(fee) < 100n) {
    throw new StellarSafeError(
      "INVALID_ARGUMENT",
      `fee must be an integer >= 100 stroops, got ${fee}`,
    );
  }
  return fee;
}

function assertSource(source: string): void {
  if (!StrKey.isValidEd25519PublicKey(source)) {
    throw new StellarSafeError(
      "INVALID_ARGUMENT",
      `source must be an account address (G…), got ${source}`,
    );
  }
}

function decodeRetval<T>(sim: rpc.Api.SimulateTransactionSuccessResponse, decode: Decode<T>): T {
  if (!sim.result) {
    throw new SimulationError("simulation returned no result for a contract invocation");
  }
  return decode(sim.result.retval);
}

function invokeOperation(tx: Transaction): Operation.InvokeHostFunction {
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") {
    throw new StellarSafeError("INVALID_ARGUMENT", "Transaction is not a host-function invocation");
  }
  return op;
}

function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
): xdr.SorobanAddressCredentials | undefined {
  const cred = entry.credentials;
  if (cred.type === "sorobanCredentialsAddress") return cred.address;
  if (cred.type === "sorobanCredentialsAddressV2") return cred.addressV2;
  return undefined;
}

function authEntryAddress(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  const creds = addressCredentials(entry);
  if (creds) return StellarAddress.fromScAddress(creds.address).toString();
  if (entry.credentials.type === "sorobanCredentialsSourceAccount") return undefined;
  return "<delegated signer>";
}

function isSigned(entry: xdr.SorobanAuthorizationEntry): boolean {
  const creds = addressCredentials(entry);
  return creds !== undefined && creds.signature.type !== "scvVoid";
}

/** Addresses with non-source-account auth entries that are not yet signed. */
function unsignedAuthAddresses(tx: Transaction): string[] {
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") return [];
  const out = new Set<string>();
  for (const entry of op.auth ?? []) {
    const address = authEntryAddress(entry);
    if (address !== undefined && !isSigned(entry)) out.add(address);
  }
  return [...out];
}

/** Find a `Error(Contract, #n)` value in diagnostic events (topics or data). */
export function findContractErrorCode(
  events: readonly xdr.DiagnosticEvent[] | undefined,
): number | undefined {
  for (const { event } of events ?? []) {
    if (event.body.type !== "v0") continue;
    for (const val of [...event.body.v0.topics, event.body.v0.data]) {
      if (val.type === "scvError" && val.error.type === "sceContract") {
        return val.error.contractCode;
      }
    }
  }
  return undefined;
}

function contractCause(code: number | undefined): { cause?: ContractError } {
  return code === undefined ? {} : { cause: new ContractError(code) };
}

function decodeTransactionEvents(
  res: rpc.Api.GetSuccessfulTransactionResponse,
  hash: string,
): StellarSafeEventWithMeta[] {
  const out: StellarSafeEventWithMeta[] = [];
  const closedAt = new Date(res.createdAt * 1000).toISOString();
  (res.events?.contractEventsXdr ?? []).forEach((opEvents, op) => {
    opEvents.forEach((event, i) => {
      if (event.body.type !== "v0" || event.contractId === null) return;
      const decoded = decodeEvent({ topics: event.body.v0.topics, value: event.body.v0.data });
      if (!decoded) return;
      out.push({
        ...decoded,
        meta: {
          id: `${hash}-${op}-${i}`,
          contractId: StrKey.encodeContract(event.contractId.value),
          ledger: res.ledger,
          ledgerClosedAt: closedAt,
          txHash: hash,
        },
      });
    });
  });
  return out;
}

/** Hex-encoded transaction hash. */
function txHash(tx: Transaction | FeeBumpTransaction): string {
  return Array.from(tx.hash(), (b) => b.toString(16).padStart(2, "0")).join("");
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
