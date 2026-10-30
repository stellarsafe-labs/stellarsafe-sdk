import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, StellarSafeError } from "../../src/index.js";

describe("parseAmount", () => {
  it.each([
    ["500", 7, 5_000_000_000n],
    ["0.0000001", 7, 1n],
    ["123.45", 2, 12_345n],
    ["  10 ", 0, 10n],
    ["0", 7, 0n],
    ["1.5", 7, 15_000_000n],
  ])("parses %s with %i decimals", (input, decimals, expected) => {
    expect(parseAmount(input, decimals)).toBe(expected);
  });

  it("defaults to 7 decimals", () => {
    expect(parseAmount("1")).toBe(10_000_000n);
  });

  it.each(["", "-1", "1e5", "1.", ".5", "abc", "1,000", "0x10"])("rejects %j", (input) => {
    expect(() => parseAmount(input, 7)).toThrow(StellarSafeError);
  });

  it("rejects excess precision instead of rounding", () => {
    expect(() => parseAmount("0.00000001", 7)).toThrow(/more than 7 decimal places/);
  });

  it("rejects values beyond i128", () => {
    expect(() => parseAmount("9".repeat(40), 0)).toThrow(/i128/);
  });

  it("rejects bad decimals and non-strings", () => {
    expect(() => parseAmount("1", -1)).toThrow(/decimals/);
    expect(() => parseAmount("1", 1.5)).toThrow(/decimals/);
    expect(() => parseAmount(1 as unknown as string)).toThrow(/decimal string/);
  });
});

describe("formatAmount", () => {
  it.each([
    [5_000_000_000n, 7, "500"],
    [1n, 7, "0.0000001"],
    [12_345n, 2, "123.45"],
    [0n, 7, "0"],
    [-15_000_000n, 7, "-1.5"],
    [42n, 0, "42"],
  ])("formats %s", (value, decimals, expected) => {
    expect(formatAmount(value, decimals)).toBe(expected);
  });

  it("round-trips with parseAmount", () => {
    for (const s of ["0.1", "1", "1234567.1234567", "0.0000001"]) {
      expect(formatAmount(parseAmount(s))).toBe(s);
    }
  });

  it("rejects non-bigint", () => {
    expect(() => formatAmount(5 as unknown as bigint)).toThrow(/bigint/);
  });
});
