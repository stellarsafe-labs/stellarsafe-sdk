import { ValidationError } from "./errors.js";
import { I128_MAX } from "./validation.js";

/** Decimals used by Stellar classic assets and their Stellar Asset Contracts (incl. USDC). */
export const STELLAR_ASSET_DECIMALS = 7;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Convert a human decimal string into the token's smallest unit.
 *
 * Uses exact string arithmetic — never floating point — and rejects inputs
 * with more fractional digits than `decimals` rather than silently rounding.
 *
 * @example
 * parseAmount("500", 7)      // 5_000_000_000n
 * parseAmount("0.0000001", 7) // 1n
 */
export function parseAmount(value: string, decimals: number = STELLAR_ASSET_DECIMALS): bigint {
  assertDecimals(decimals);
  if (typeof value !== "string") {
    throw new ValidationError('amount must be a decimal string (e.g. "500.25")');
  }
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) {
    throw new ValidationError(
      `amount must be a non-negative decimal string, got ${JSON.stringify(value)}`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new ValidationError(
      `amount ${JSON.stringify(value)} has more than ${decimals} decimal places`,
    );
  }
  const result = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (result > I128_MAX) {
    throw new ValidationError("amount is out of i128 range");
  }
  return result;
}

/**
 * Format a smallest-unit amount as a decimal string, trimming trailing zeros.
 *
 * @example
 * formatAmount(5_000_000_000n, 7) // "500"
 * formatAmount(12_345n, 2)        // "123.45"
 */
export function formatAmount(value: bigint, decimals: number = STELLAR_ASSET_DECIMALS): string {
  assertDecimals(decimals);
  if (typeof value !== "bigint") {
    throw new ValidationError("value must be a bigint");
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new ValidationError(`decimals must be an integer between 0 and 38, got ${decimals}`);
  }
}
