import { StrKey } from "@stellar/stellar-sdk";
import { ValidationError } from "./errors.js";

/** i128 bounds, the on-chain representation of token amounts. */
export const I128_MAX = (1n << 127n) - 1n;
export const I128_MIN = -(1n << 127n);
export const U64_MAX = (1n << 64n) - 1n;
export const U32_MAX = 0xffff_ffff;

const SYMBOL_RE = /^[a-zA-Z0-9_]{1,32}$/;
const MAX_MEMO_BYTES = 256;

/** Returns `true` for a valid account (`G…`) or contract (`C…`) address. */
export function isValidAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
  );
}

/** Returns `true` for a valid contract address (`C…`). */
export function isValidContractId(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}

export function assertAddress(value: unknown, field: string): asserts value is string {
  if (!isValidAddress(value)) {
    throw new ValidationError(
      `${field} must be a valid Stellar address (G… or C…), got ${show(value)}`,
    );
  }
}

export function assertAccountId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !StrKey.isValidEd25519PublicKey(value)) {
    throw new ValidationError(`${field} must be a valid account address (G…), got ${show(value)}`);
  }
}

export function assertContractId(value: unknown, field: string): asserts value is string {
  if (!isValidContractId(value)) {
    throw new ValidationError(`${field} must be a valid contract address (C…), got ${show(value)}`);
  }
}

export function assertSymbol(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SYMBOL_RE.test(value)) {
    throw new ValidationError(`${field} must match [a-zA-Z0-9_]{1,32}, got ${show(value)}`);
  }
}

export function assertMemo(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_MEMO_BYTES) {
    throw new ValidationError(`${field} must be at most ${MAX_MEMO_BYTES} bytes, got ${bytes}`);
  }
}

export function assertI128(
  value: unknown,
  field: string,
  opts: { positive?: boolean } = {},
): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new ValidationError(`${field} must be a bigint, got ${typeof value}`);
  }
  if (value > I128_MAX || value < I128_MIN) {
    throw new ValidationError(`${field} is out of i128 range`);
  }
  if (opts.positive && value <= 0n) {
    throw new ValidationError(`${field} must be greater than zero, got ${value}`);
  }
}

export function assertU64(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new ValidationError(`${field} must be a bigint in u64 range, got ${show(value)}`);
  }
}

export function assertU32(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new ValidationError(`${field} must be an integer in u32 range, got ${show(value)}`);
  }
}

/** Accept `bigint | number | string` ids from callers and normalize to u64 bigint. */
export function toU64(value: bigint | number | string, field: string): bigint {
  let big: bigint;
  try {
    big = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new ValidationError(`${field} must be an integer, got ${show(value)}`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a safe integer; pass a bigint for large values`);
  }
  assertU64(big, field);
  return big;
}

function show(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
