/**
 * In-memory stand-in for a Soroban RPC server. Contract calls are dispatched
 * by function name to handlers supplied by each test.
 */
import {
  Account,
  Address,
  type FeeBumpTransaction,
  Networks,
  SorobanDataBuilder,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import type { RpcClient } from "../../src/index.js";

type ScVal = xdr.ScVal;

/** Throw from a handler to make simulation fail with `Error(Contract, #code)`. */
export class ContractFailure {
  constructor(readonly code: number) {}
}

export type Handler = (args: ScVal[]) => ScVal;

export interface FakeRpcOptions {
  handlers?: Record<string, Handler>;
  passphrase?: string;
  latestLedger?: number;
  /** Auth entries returned by simulation (default none, i.e. source-account auth). */
  auth?: xdr.SorobanAuthorizationEntry[];
  /** Addresses that simulation reports as needing address-credential auth for contract calls. */
  authFor?: string[];
}

export interface FakeRpc extends RpcClient {
  readonly calls: { method: string; args: ScVal[] }[];
  readonly submitted: (Transaction | FeeBumpTransaction)[];
  handlers: Record<string, Handler>;
  /** Override the next N sendTransaction statuses. */
  sendStatuses: Array<"PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR">;
  /** Override getTransaction outcomes (consumed in order; then SUCCESS). */
  txStatuses: Array<"NOT_FOUND" | "SUCCESS" | "FAILED">;
  /** Events attached to successful transactions. */
  txEvents: { topics: ScVal[]; data: ScVal }[];
  /** Pages returned by getEvents, consumed in order. */
  eventPages: Awaited<ReturnType<RpcClient["getEvents"]>>[];
  readonly eventRequests: Parameters<RpcClient["getEvents"]>[0][];
  restore: boolean;
  rawSimError: string | undefined;
  /** Auth mode passed to each simulateTransaction call. */
  readonly simAuthModes: (string | undefined)[];
  /** Diagnostic events attached to FAILED transactions / ERROR sends. */
  failureEvents: xdr.DiagnosticEvent[];
  /** Current ledger reported by the fake. */
  ledger: number;
  /** Ledgers reported by successive simulations (consumed first), to mimic lagging nodes. */
  simLedgers: number[];
  nextSimLedger(): number;
}

export function fakeRpc(opts: FakeRpcOptions = {}): FakeRpc {
  const lastResult = new Map<string, ScVal>();
  const fake: FakeRpc = {
    calls: [],
    submitted: [],
    handlers: opts.handlers ?? {},
    sendStatuses: [],
    txStatuses: [],
    txEvents: [],
    eventPages: [],
    eventRequests: [],
    restore: false,
    rawSimError: undefined,
    simAuthModes: [],
    failureEvents: [],
    ledger: opts.latestLedger ?? 1000,
    simLedgers: [],
    nextSimLedger() {
      return fake.simLedgers.shift() ?? fake.ledger;
    },

    async getNetwork() {
      return { passphrase: opts.passphrase ?? Networks.TESTNET, protocolVersion: "23" };
    },

    async getAccount(address: string) {
      return new Account(address, "100");
    },

    async getLatestLedger() {
      return {
        id: "x",
        sequence: fake.ledger,
        protocolVersion: "23",
        closeTime: "1800000000",
      } as Awaited<ReturnType<RpcClient["getLatestLedger"]>>;
    },

    async simulateTransaction(tx, _resources, authMode) {
      const { method, args, invoke, existingAuth } = invocation(tx as Transaction);
      fake.calls.push({ method, args });
      fake.simAuthModes.push(authMode);
      const base = {
        id: "1",
        latestLedger: fake.nextSimLedger(),
        events: [],
        _parsed: true as const,
      };
      if (fake.rawSimError) return { ...base, error: fake.rawSimError };
      const handler = fake.handlers[method];
      if (!handler) return { ...base, error: `HostError: no handler for ${method}` };
      let retval: ScVal;
      try {
        retval = handler(args);
      } catch (err) {
        if (err instanceof ContractFailure) {
          return { ...base, error: `HostError: Error(Contract, #${err.code})` };
        }
        throw err;
      }
      lastResult.set(method, retval);
      const success = {
        ...base,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "54321",
        result: {
          auth:
            existingAuth > 0
              ? []
              : (opts.auth ??
                (invoke ? (opts.authFor ?? []).map((a) => authEntry(a, invoke)) : [])),
          retval,
        },
      };
      if (fake.restore) {
        return {
          ...success,
          restorePreamble: { minResourceFee: "777", transactionData: new SorobanDataBuilder() },
        };
      }
      return success;
    },

    async sendTransaction(tx) {
      fake.submitted.push(tx);
      const status = fake.sendStatuses.shift() ?? "PENDING";
      return {
        status,
        hash: "",
        latestLedger: fake.ledger,
        latestLedgerCloseTime: 0,
        ...(status === "ERROR"
          ? {
              errorResult: { result: { type: "txBadSeq" } } as unknown as xdr.TransactionResult,
              diagnosticEvents: fake.failureEvents,
            }
          : {}),
      };
    },

    async getTransaction(hash: string) {
      const status = fake.txStatuses.shift() ?? "SUCCESS";
      const common = {
        txHash: hash,
        latestLedger: fake.ledger,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      };
      if (status === "NOT_FOUND") return { ...common, status } as never;
      const tx = fake.submitted.at(-1) as Transaction;
      // The transaction is applied in the next ledger, which the fake now reports.
      fake.ledger += 1;
      const { method } = invocation(tx);
      const contractIdBytes = new Uint8Array(32).fill(10);
      return {
        ...common,
        status,
        ledger: fake.ledger,
        createdAt: 1_800_000_000,
        applicationOrder: 1,
        feeBump: false,
        resultXdr: {
          feeCharged: 12345n,
          result: { type: status === "FAILED" ? "txFailed" : "txSuccess" },
        },
        returnValue: lastResult.get(method),
        diagnosticEventsXdr: status === "FAILED" ? fake.failureEvents : undefined,
        events: {
          transactionEventsXdr: [],
          contractEventsXdr: [
            fake.txEvents.map((e) => ({
              contractId: { value: contractIdBytes },
              body: { type: "v0", v0: { topics: e.topics, data: e.data } },
            })),
          ],
        },
      } as never;
    },

    async getEvents(request) {
      fake.eventRequests.push(request);
      const page = fake.eventPages.shift();
      return (
        page ?? {
          events: [],
          cursor: "end",
          latestLedger: fake.ledger,
          oldestLedger: 1,
          latestLedgerCloseTime: "0",
          oldestLedgerCloseTime: "0",
        }
      );
    },
  };
  return fake;
}

interface Invocation {
  method: string;
  args: ScVal[];
  invoke?: xdr.InvokeContractArgs;
  existingAuth: number;
}

/** Name host functions so tests can register handlers: contract method, `__upload`, `__deploy`, `__restore`. */
function invocation(tx: Transaction): Invocation {
  const op = tx.operations[0];
  if (op?.type === "restoreFootprint") return { method: "__restore", args: [], existingAuth: 0 };
  if (op?.type !== "invokeHostFunction") throw new Error("unexpected operation");
  const existingAuth = op.auth?.length ?? 0;
  switch (op.func.type) {
    case "hostFunctionTypeInvokeContract":
      return {
        method: op.func.invokeContract.functionName.toString(),
        args: op.func.invokeContract.args,
        invoke: op.func.invokeContract,
        existingAuth,
      };
    case "hostFunctionTypeUploadContractWasm":
      return { method: "__upload", args: [], existingAuth };
    case "hostFunctionTypeCreateContractV2":
      return { method: "__deploy", args: op.func.createContractV2.constructorArgs, existingAuth };
    default:
      throw new Error(`unexpected host function ${op.func.type}`);
  }
}

function authEntry(address: string, invoke: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: 42n,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invoke),
      subInvocations: [],
    }),
  });
}

/** A diagnostic event carrying `Error(Contract, #code)`, as the host emits on failure. */
export function contractErrorEvent(code: number): xdr.DiagnosticEvent {
  return {
    inSuccessfulContractCall: false,
    event: {
      contractId: null,
      body: {
        type: "v0",
        v0: {
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVoid(),
        },
      },
    },
  } as unknown as xdr.DiagnosticEvent;
}

export const VOID = xdr.ScVal.scvVoid();
