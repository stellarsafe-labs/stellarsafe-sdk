/**
 * Error types thrown by the SDK.
 *
 * Every error the SDK throws is a {@link StellarSafeError} with a stable
 * machine-readable `code`, so callers can branch on `err.code` instead of
 * parsing messages.
 *
 * @module
 */

/** Stable error codes for {@link StellarSafeError}. */
export type StellarSafeErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CONFIG"
  | "CONTRACT_ERROR"
  | "SIMULATION_FAILED"
  | "RESTORE_REQUIRED"
  | "SUBMISSION_FAILED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_TIMEOUT"
  | "SIGNING_FAILED"
  | "AUTH_REQUIRED"
  | "NETWORK_MISMATCH"
  | "RPC_ERROR"
  | "DECODE_ERROR"
  | "ABORTED";

/** Base class for every error thrown by `@stellarsafe/sdk`. */
export class StellarSafeError extends Error {
  override readonly name: string = "StellarSafeError";
  readonly code: StellarSafeErrorCode;

  constructor(code: StellarSafeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** Thrown when a caller passes an invalid value (bad address, negative amount, ...). */
export class ValidationError extends StellarSafeError {
  override readonly name = "ValidationError";
  constructor(message: string, options?: { cause?: unknown }) {
    super("INVALID_ARGUMENT", message, options);
  }
}

/** Thrown when an XDR value returned by the network does not match the expected contract types. */
export class DecodeError extends StellarSafeError {
  override readonly name = "DecodeError";
  constructor(message: string, options?: { cause?: unknown }) {
    super("DECODE_ERROR", message, options);
  }
}

/**
 * Error codes defined by the StellarSafe treasury contract (`#[contracterror]`).
 *
 * These numeric values are part of the contract interface: see
 * `docs/CONTRACT_INTERFACE.md`. The SDK and contract must agree on them.
 */
export const ContractErrorCode = {
  AlreadyInitialized: 1,
  NotInitialized: 2,
  Unauthorized: 3,
  NotMember: 4,
  MemberAlreadyExists: 5,
  ProposalNotFound: 6,
  ProposalNotPending: 7,
  ProposalExpired: 8,
  AlreadyApproved: 9,
  NotApproved: 10,
  InsufficientApprovals: 11,
  RecipientNotAllowed: 12,
  SpendingLimitExceeded: 13,
  PolicyVersionMismatch: 14,
  InvalidAmount: 15,
  InvalidPolicy: 16,
  InvalidExpiry: 17,
  LastAdmin: 18,
  InsufficientBalance: 19,
  TokenNotAllowed: 20,
  MemoTooLong: 21,
  TooManyPending: 22,
} as const;

/** Name of a contract error, e.g. `"SpendingLimitExceeded"`. */
export type ContractErrorName = keyof typeof ContractErrorCode;

/**
 * Readable descriptions for every contract error defined by the SDK.
 *
 * The mapping is frozen so callers can safely share it with user interfaces.
 */
export const CONTRACT_ERROR_DESCRIPTIONS: Readonly<
  Record<ContractErrorName, string>
> = Object.freeze({
  AlreadyInitialized: "The treasury has already been initialized.",
  NotInitialized: "The treasury has not been initialized.",
  Unauthorized: "The caller does not have the role required for this action.",
  NotMember: "The address is not a member of this treasury.",
  MemberAlreadyExists: "The address is already a member of this treasury.",
  ProposalNotFound: "No proposal exists with this id.",
  ProposalNotPending: "The proposal is not pending (already executed or cancelled).",
  ProposalExpired: "The proposal's approval window has expired.",
  AlreadyApproved: "This member has already approved the proposal.",
  NotApproved: "This member has not approved the proposal.",
  InsufficientApprovals: "The proposal does not have enough valid approvals.",
  RecipientNotAllowed: "The recipient is not on the treasury's allowlist.",
  SpendingLimitExceeded:
    "The payment would exceed the department's spending limit for this period.",
  PolicyVersionMismatch:
    "The policy changed after the proposal was created; its approvals are void.",
  InvalidAmount: "The amount must be a positive integer.",
  InvalidPolicy: "The policy configuration is invalid.",
  InvalidExpiry: "The expiry is in the past or exceeds the policy's maximum proposal lifetime.",
  LastAdmin: "Cannot remove or demote the last admin of the treasury.",
  InsufficientBalance: "The treasury does not hold enough of this token.",
  TokenNotAllowed: "The token is not enabled in the treasury policy.",
  MemoTooLong: "The memo or name is longer than 256 bytes.",
  TooManyPending: "The treasury has too many pending proposals; execute or cancel some first.",
});

const NAME_BY_CODE = new Map<number, ContractErrorName>(
  (Object.entries(ContractErrorCode) as [ContractErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ]),
);

/**
 * Get the readable description for a contract error name or numeric code.
 *
 * Unknown numeric codes use the same fallback message as {@link ContractError}.
 */
export function describeContractError(nameOrCode: ContractErrorName | number): string {
  const name =
    typeof nameOrCode === "number" ? NAME_BY_CODE.get(nameOrCode) : nameOrCode;
  return name === undefined
    ? `Unknown contract error #${nameOrCode}. The contract may be newer than this SDK.`
    : CONTRACT_ERROR_DESCRIPTIONS[name];
}

/** Thrown when the treasury contract rejects a call with one of its own error codes. */
export class ContractError extends StellarSafeError {
  override readonly name = "ContractError";
  /** Numeric contract error code (`Error(Contract, #N)`). */
  readonly contractCode: number;
  /** Symbolic name, or `undefined` if the code is unknown to this SDK version. */
  readonly contractErrorName: ContractErrorName | undefined;

  constructor(contractCode: number, options?: { cause?: unknown }) {
    const name = NAME_BY_CODE.get(contractCode);
    const message = name
      ? `${name} (#${contractCode}): ${describeContractError(name)}`
      : describeContractError(contractCode);
    super("CONTRACT_ERROR", message, options);
    this.contractCode = contractCode;
    this.contractErrorName = name;
  }

  /** Type-safe check for a specific contract error. */
  is(name: ContractErrorName): boolean {
    return this.contractErrorName === name;
  }
}

/**
 * Extract a contract error code from a host error string such as
 * `"HostError: Error(Contract, #13)"`. Returns `undefined` when the string
 * contains no contract error.
 */
export function parseContractErrorCode(message: string): number | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Thrown when simulation fails for a reason other than a contract error. */
export class SimulationError extends StellarSafeError {
  override readonly name = "SimulationError";
  /** Raw error string from the RPC server. */
  readonly rpcError: string;
  constructor(rpcError: string) {
    super("SIMULATION_FAILED", `Transaction simulation failed: ${rpcError}`);
    this.rpcError = rpcError;
  }
}

/**
 * Thrown when the call touches archived ledger entries that must be restored
 * first. Pass it to `StellarSafeClient.prepareRestore()` to build the restore
 * transaction, submit that, then retry the original call.
 */
export class RestoreRequiredError extends StellarSafeError {
  override readonly name = "RestoreRequiredError";
  /** Minimum resource fee (stroops) for the restore transaction. */
  readonly minResourceFee: string;
  /** Base64 `SorobanTransactionData` describing the entries to restore. */
  readonly transactionData: string;
  constructor(minResourceFee: string, transactionData: string) {
    super(
      "RESTORE_REQUIRED",
      "Contract state is archived and must be restored before this call. " +
        "Use client.prepareRestore(error, { source }) to restore it, then retry.",
    );
    this.minResourceFee = minResourceFee;
    this.transactionData = transactionData;
  }
}

/** Thrown when a transaction was submitted but did not succeed on-chain. */
export class TransactionError extends StellarSafeError {
  override readonly name: string = "TransactionError";
  /** Transaction hash (hex). */
  readonly hash: string;
  constructor(
    code: "SUBMISSION_FAILED" | "TRANSACTION_FAILED" | "TRANSACTION_TIMEOUT",
    hash: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.hash = hash;
  }

  /** The contract error that made the transaction fail, when the RPC reported one. */
  get contractError(): ContractError | undefined {
    return this.cause instanceof ContractError ? this.cause : undefined;
  }
}

/** Thrown when an RPC request fails (network error, 5xx, rate limit) after retries. */
export class RpcError extends StellarSafeError {
  override readonly name = "RpcError";
  constructor(message: string, options?: { cause?: unknown }) {
    super("RPC_ERROR", message, options);
  }
}

/** Type guard for {@link StellarSafeError}. */
export function isStellarSafeError(err: unknown): err is StellarSafeError {
  return err instanceof StellarSafeError;
}

/** Type guard for {@link ContractError}, optionally for a specific error name. */
export function isContractError(err: unknown, name?: ContractErrorName): err is ContractError {
  return err instanceof ContractError && (name === undefined || err.is(name));
}
