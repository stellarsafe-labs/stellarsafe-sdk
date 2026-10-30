/**
 * Entry point: {@link StellarSafeClient}.
 *
 * @module
 */
import { Operation, rpc, Address as StellarAddress } from "@stellar/stellar-sdk";
import { dec, enc, encodeMember, encodePolicyConfig } from "./codec.js";
import { bytesToHex, hexToBytes } from "./encoding.js";
import { type RestoreRequiredError, StellarSafeError, ValidationError } from "./errors.js";
import {
  decodeEvent,
  eventTopicFilter,
  type StellarSafeEventType,
  type StellarSafeEventWithMeta,
} from "./events.js";
import { isNetworkName, NETWORKS, type NetworkName } from "./networks.js";
import { validatePolicyConfig } from "./policy.js";
import { type RetryOptions, sleep } from "./retry.js";
import {
  type PreparedTransaction,
  type PrepareOptions,
  type RpcClient,
  TransactionPipeline,
} from "./transaction.js";
import { assertRole, type ReadOptions, TreasuryClient } from "./treasury.js";
import type { Member, PolicyConfig, TreasurySnapshot } from "./types.js";
import { assertAccountId, assertAddress, assertContractId, assertMemo } from "./validation.js";

/** Options for {@link StellarSafeClient}. */
export interface StellarSafeClientOptions {
  /**
   * Built-in network name, or `"custom"` together with `networkPassphrase`.
   */
  readonly network: NetworkName | "custom";
  /** Soroban RPC URL. Required for mainnet and custom networks. */
  readonly rpcUrl?: string;
  /** Required when `network` is `"custom"`; must match the network's passphrase otherwise. */
  readonly networkPassphrase?: string;
  /** Allow `http://` RPC URLs. Only for local development. Default `false`. */
  readonly allowHttp?: boolean;
  /** Extra HTTP headers sent with every RPC request (e.g. an API key). */
  readonly headers?: Record<string, string>;
  /** Per-request RPC timeout in ms. Default 30_000. */
  readonly timeoutMs?: number;
  /** Retry policy for transient RPC failures. */
  readonly retry?: RetryOptions;
  /**
   * Use this RPC client instead of creating one from `rpcUrl`. Useful for
   * sharing a connection, custom transports and testing.
   */
  readonly rpc?: RpcClient;
}

/** Request for {@link StellarSafeClient.getEvents}. Provide exactly one of `startLedger` or `cursor`. */
export interface GetEventsOptions {
  /** Treasury contract ids to watch (1–25). */
  readonly contractIds: readonly string[];
  /** Only these event types. Default: all StellarSafe events. */
  readonly types?: readonly StellarSafeEventType[];
  /** First ledger to scan (inclusive). */
  readonly startLedger?: number;
  /** Resume after a previous page; use the `cursor` returned by the last call. */
  readonly cursor?: string;
  /** Page size, 1–10_000. Default 100. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** A page of decoded events. */
export interface EventPage {
  readonly events: StellarSafeEventWithMeta[];
  /** Pass to the next {@link GetEventsOptions.cursor} to continue. */
  readonly cursor: string;
  readonly latestLedger: number;
  /** Oldest ledger the RPC server still retains events for. */
  readonly oldestLedger: number;
  /** Raw events scanned for this page, including skipped non-StellarSafe events. */
  readonly scanned: number;
}

/** Parameters for {@link StellarSafeClient.deployTreasury}. */
export interface DeployTreasuryParams {
  /** Hex SHA-256 of the uploaded treasury wasm (see {@link StellarSafeClient.uploadWasm}). */
  readonly wasmHash: string;
  /** First Admin. Must authorize the deployment (and pays fees unless `source` is set). */
  readonly admin: string;
  readonly name: string;
  /** Additional members. The admin is added automatically. */
  readonly members?: readonly Member[];
  readonly policy: PolicyConfig;
  /**
   * 32-byte hex salt. Together with the deployer it determines the contract
   * id. Default: random.
   */
  readonly salt?: string;
}

/** Options for deploy, upload and restore transactions. `source` defaults where noted. */
export type DeployOptions = Omit<PrepareOptions, "source"> & { readonly source?: string };

/** Options for {@link StellarSafeClient.streamEvents}. */
export interface StreamEventsOptions extends Omit<GetEventsOptions, "limit"> {
  /** Delay between polls when caught up, in ms. Default 5_000. */
  readonly pollIntervalMs?: number;
  /** Page size per poll. Default 100. */
  readonly pageSize?: number;
}

const MAX_FILTERS = 5;
const MAX_PER_FILTER = 5;

/**
 * Client for StellarSafe treasuries on a Stellar network.
 *
 * @example
 * ```ts
 * const client = new StellarSafeClient({ network: "testnet" });
 * const treasury = await client.getTreasury("C…");
 * console.log(treasury.policy, treasury.pendingProposals);
 * ```
 */
export class StellarSafeClient {
  readonly networkPassphrase: string;
  readonly rpc: RpcClient;
  private readonly pipeline: TransactionPipeline;

  constructor(options: StellarSafeClientOptions) {
    const { network } = options;
    let passphrase: string;
    let defaultRpcUrl: string | undefined;
    if (network === "custom") {
      if (!options.networkPassphrase) {
        throw new StellarSafeError(
          "INVALID_CONFIG",
          'networkPassphrase is required when network is "custom"',
        );
      }
      passphrase = options.networkPassphrase;
    } else if (isNetworkName(network)) {
      passphrase = NETWORKS[network].networkPassphrase;
      defaultRpcUrl = NETWORKS[network].defaultRpcUrl;
      if (options.networkPassphrase !== undefined && options.networkPassphrase !== passphrase) {
        throw new StellarSafeError(
          "INVALID_CONFIG",
          `networkPassphrase does not match the "${network}" network`,
        );
      }
    } else {
      throw new StellarSafeError("INVALID_CONFIG", `Unknown network "${String(network)}"`);
    }
    this.networkPassphrase = passphrase;

    if (options.rpc) {
      this.rpc = options.rpc;
    } else {
      const url = options.rpcUrl ?? defaultRpcUrl;
      if (!url) {
        throw new StellarSafeError(
          "INVALID_CONFIG",
          `rpcUrl is required for the "${network}" network`,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new StellarSafeError("INVALID_CONFIG", `rpcUrl is not a valid URL: ${url}`);
      }
      const allowHttp = options.allowHttp ?? network === "local";
      if (parsed.protocol === "http:" && !allowHttp) {
        throw new StellarSafeError(
          "INVALID_CONFIG",
          "rpcUrl uses http://; set allowHttp: true for local development only",
        );
      }
      this.rpc = new rpc.Server(url, {
        allowHttp,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.headers ? { headers: options.headers } : {}),
      });
    }

    this.pipeline = new TransactionPipeline({
      rpc: this.rpc,
      networkPassphrase: passphrase,
      retry: options.retry ?? {},
    });
  }

  /** A typed client for one treasury contract. Does not make any network calls. */
  treasury(contractId: string): TreasuryClient {
    assertContractId(contractId, "contractId");
    return new TreasuryClient(this.pipeline, contractId);
  }

  /** Read a treasury's config, policy, members and pending proposals. */
  async getTreasury(contractId: string, opts?: ReadOptions): Promise<TreasurySnapshot> {
    return this.treasury(contractId).getSnapshot(opts);
  }

  /**
   * Upload contract wasm to the network so treasuries can be deployed from
   * it. Uploading the same wasm twice is harmless.
   *
   * @returns prepared transaction whose result is the wasm hash (hex).
   */
  async uploadWasm(
    wasm: Uint8Array,
    opts: DeployOptions & { source: string },
  ): Promise<PreparedTransaction<string>> {
    if (!(wasm instanceof Uint8Array) || wasm.length === 0) {
      throw new ValidationError("wasm must be a non-empty Uint8Array");
    }
    return this.pipeline.prepareOperation(
      Operation.uploadContractWasm({ wasm }),
      (v) => bytesToHex(dec.bytes(v, "wasmHash")),
      opts,
    );
  }

  /**
   * Deploy a new treasury. Setup runs in the contract constructor, in the
   * same transaction as deployment, so it cannot be front-run.
   *
   * @returns prepared transaction whose result is the new treasury contract id.
   *
   * @example
   * ```ts
   * const tx = await client.deployTreasury({ wasmHash, admin: me, name: "Ops", policy });
   * const { result: treasuryId } = await tx.signAndSubmit(wallet);
   * ```
   */
  async deployTreasury(
    params: DeployTreasuryParams,
    opts: DeployOptions = {},
  ): Promise<PreparedTransaction<string>> {
    assertAccountId(params.admin, "admin");
    assertMemo(params.name, "name");
    const wasmHash = hexToBytes(params.wasmHash, 32);
    const members = params.members ?? [];
    const seen = new Set([params.admin]);
    members.forEach((m, i) => {
      assertAddress(m.address, `members[${i}].address`);
      assertRole(m.role, `members[${i}].role`);
      if (seen.has(m.address)) {
        throw new ValidationError(`members[${i}].address ${m.address} is listed twice`);
      }
      seen.add(m.address);
    });
    const approvers = 1 + members.filter((m) => m.role !== "Proposer").length;
    validatePolicyConfig(params.policy, approvers);
    const salt =
      params.salt === undefined
        ? globalThis.crypto.getRandomValues(new Uint8Array(32))
        : hexToBytes(params.salt, 32);
    const source = opts.source ?? params.admin;
    return this.pipeline.prepareOperation(
      Operation.createCustomContract({
        address: StellarAddress.fromString(source),
        wasmHash,
        salt,
        constructorArgs: [
          enc.address(params.admin),
          enc.string(params.name),
          enc.vec(members, encodeMember),
          encodePolicyConfig(params.policy),
        ],
      }),
      (v) => dec.address(v, "contractId"),
      { ...opts, source },
    );
  }

  /**
   * Build the transaction that restores archived contract state reported by
   * a {@link RestoreRequiredError}. Sign and submit it, then retry the call.
   */
  prepareRestore(
    error: RestoreRequiredError,
    opts: DeployOptions & { source: string },
  ): Promise<PreparedTransaction<void>> {
    return this.pipeline.prepareRestore(error, opts);
  }

  /** Confirm the RPC server is on the configured network. Writes do this automatically. */
  verifyNetwork(opts?: ReadOptions): Promise<void> {
    return this.pipeline.verifyNetwork(opts?.signal);
  }

  /**
   * Latest ledger sequence and close time. Use `closeTime` as "now" for
   * expiry and spending-period calculations: the contract uses ledger time,
   * not your machine's clock.
   */
  async getLedgerTime(opts?: ReadOptions): Promise<{ sequence: number; closeTime: bigint }> {
    const latest = await this.pipeline.call(
      "getLatestLedger",
      (r) => r.getLatestLedger(),
      opts?.signal,
    );
    return { sequence: latest.sequence, closeTime: BigInt(latest.closeTime) };
  }

  /** Fetch one page of StellarSafe events. */
  async getEvents(options: GetEventsOptions): Promise<EventPage> {
    const filters = buildFilters(options.contractIds, options.types);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new ValidationError(`limit must be an integer between 1 and 10000, got ${limit}`);
    }
    let request: rpc.Api.GetEventsRequest;
    if (options.cursor !== undefined && options.startLedger === undefined) {
      request = { filters, cursor: options.cursor, limit };
    } else if (options.startLedger !== undefined && options.cursor === undefined) {
      if (!Number.isInteger(options.startLedger) || options.startLedger < 1) {
        throw new ValidationError("startLedger must be a positive integer");
      }
      request = { filters, startLedger: options.startLedger, limit };
    } else {
      throw new ValidationError("Provide exactly one of startLedger or cursor");
    }
    const res = await this.pipeline.call("getEvents", (r) => r.getEvents(request), options.signal);
    const events: StellarSafeEventWithMeta[] = [];
    for (const e of res.events) {
      const decoded = decodeEvent({ topics: e.topic, value: e.value });
      if (!decoded) continue;
      events.push({
        ...decoded,
        meta: {
          id: e.id,
          contractId: e.contractId?.contractId() ?? "",
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          txHash: e.txHash,
        },
      });
    }
    return {
      events,
      cursor: res.cursor,
      latestLedger: res.latestLedger,
      oldestLedger: res.oldestLedger,
      scanned: res.events.length,
    };
  }

  /**
   * Continuously yield StellarSafe events, polling when caught up.
   *
   * Stops when `signal` aborts (the iterator then throws an `ABORTED`
   * error — wrap in try/catch or use `for await` with `break`). Persist
   * `event.meta.id` or the page cursor to resume after a restart.
   *
   * @example
   * ```ts
   * const ac = new AbortController();
   * for await (const event of client.streamEvents({ contractIds: [id], startLedger, signal: ac.signal })) {
   *   if (event.type === "executed") console.log("paid", event.data.amount);
   * }
   * ```
   */
  async *streamEvents(
    options: StreamEventsOptions,
  ): AsyncGenerator<StellarSafeEventWithMeta, void, void> {
    const interval = options.pollIntervalMs ?? 5_000;
    const base = {
      contractIds: options.contractIds,
      limit: options.pageSize ?? 100,
      ...(options.types ? { types: options.types } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let page = await this.getEvents({
      ...base,
      ...(options.cursor !== undefined
        ? { cursor: options.cursor }
        : options.startLedger !== undefined
          ? { startLedger: options.startLedger }
          : {}),
    });
    for (;;) {
      yield* page.events;
      if (page.scanned < base.limit) {
        await sleep(interval, options.signal);
      }
      page = await this.getEvents({ ...base, cursor: page.cursor });
    }
  }
}

function buildFilters(
  contractIds: readonly string[],
  types: readonly StellarSafeEventType[] | undefined,
): rpc.Api.EventFilter[] {
  if (contractIds.length === 0) {
    throw new ValidationError("contractIds must contain at least one contract id");
  }
  contractIds.forEach((id, i) => {
    assertContractId(id, `contractIds[${i}]`);
  });
  const topics = eventTopicFilter(types);
  const filters: rpc.Api.EventFilter[] = [];
  for (const ids of chunk(contractIds, MAX_PER_FILTER)) {
    for (const t of chunk(topics, MAX_PER_FILTER)) {
      filters.push({ type: "contract", contractIds: ids, topics: t });
    }
  }
  if (filters.length > MAX_FILTERS) {
    throw new ValidationError(
      `Too many contracts/event types for one request (needs ${filters.length} filters, RPC allows ${MAX_FILTERS}). ` +
        "Watch fewer contracts per call, or omit `types` to match all events.",
    );
  }
  return filters;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
