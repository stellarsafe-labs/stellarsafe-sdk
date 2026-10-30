import { describe, expect, it } from "vitest";
import { isValidAddress, isValidContractId, ValidationError } from "../../src/index.js";
import {
  assertI128,
  assertMemo,
  assertSymbol,
  assertU32,
  assertU64,
  toU64,
  U64_MAX,
} from "../../src/validation.js";
import { ADMIN, USDC } from "../helpers/fixtures.js";

describe("validation", () => {
  it("addresses", () => {
    expect(isValidAddress(ADMIN.publicKey())).toBe(true);
    expect(isValidAddress(USDC)).toBe(true);
    expect(isValidAddress("GABC")).toBe(false);
    expect(isValidAddress(42)).toBe(false);
    expect(isValidContractId(USDC)).toBe(true);
    expect(isValidContractId(ADMIN.publicKey())).toBe(false);
  });

  it("symbols", () => {
    expect(() => assertSymbol("ops_2026", "d")).not.toThrow();
    expect(() => assertSymbol("", "d")).toThrow(ValidationError);
    expect(() => assertSymbol("has space", "d")).toThrow(ValidationError);
    expect(() => assertSymbol("x".repeat(33), "d")).toThrow(ValidationError);
  });

  it("memo byte length", () => {
    expect(() => assertMemo("é".repeat(128), "m")).not.toThrow();
    expect(() => assertMemo("é".repeat(129), "m")).toThrow(/256 bytes/);
    expect(() => assertMemo(5, "m")).toThrow(/string/);
  });

  it("integers", () => {
    expect(() => assertI128(1n, "a", { positive: true })).not.toThrow();
    expect(() => assertI128(0n, "a", { positive: true })).toThrow(/greater than zero/);
    expect(() => assertI128(1, "a")).toThrow(/bigint/);
    expect(() => assertI128(1n << 127n, "a")).toThrow(/range/);
    expect(() => assertU64(-1n, "a")).toThrow(ValidationError);
    expect(() => assertU64(U64_MAX + 1n, "a")).toThrow(ValidationError);
    expect(() => assertU32(-1, "a")).toThrow(ValidationError);
    expect(() => assertU32(1.5, "a")).toThrow(ValidationError);
  });

  it("toU64 accepts bigint, safe numbers and decimal strings", () => {
    expect(toU64(5n, "id")).toBe(5n);
    expect(toU64(5, "id")).toBe(5n);
    expect(toU64("18446744073709551615", "id")).toBe(U64_MAX);
    expect(() => toU64(2 ** 60, "id")).toThrow(/safe integer/);
    expect(() => toU64("abc", "id")).toThrow(/integer/);
    expect(() => toU64(-1, "id")).toThrow(ValidationError);
  });
});
