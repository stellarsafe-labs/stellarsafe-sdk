import { describe, expect, it } from "vitest";
import {
  ContractError,
  ContractErrorCode,
  isContractError,
  isStellarSafeError,
  parseContractErrorCode,
  StellarSafeError,
  ValidationError,
} from "../../src/index.js";

describe("errors", () => {
  it("parses contract error codes from host errors", () => {
    expect(parseContractErrorCode("HostError: Error(Contract, #13)\n\nEvent log...")).toBe(13);
    expect(parseContractErrorCode("HostError: Error(Budget, ExceededLimit)")).toBeUndefined();
  });

  it("names known contract errors", () => {
    const err = new ContractError(ContractErrorCode.SpendingLimitExceeded);
    expect(err.code).toBe("CONTRACT_ERROR");
    expect(err.contractErrorName).toBe("SpendingLimitExceeded");
    expect(err.message).toMatch(/^SpendingLimitExceeded \(#13\)/);
    expect(err.is("SpendingLimitExceeded")).toBe(true);
    expect(isContractError(err, "SpendingLimitExceeded")).toBe(true);
    expect(isContractError(err, "Unauthorized")).toBe(false);
    expect(isContractError(err)).toBe(true);
    expect(err).toBeInstanceOf(StellarSafeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("handles unknown codes", () => {
    const err = new ContractError(999);
    expect(err.contractErrorName).toBeUndefined();
    expect(err.message).toMatch(/Unknown contract error #999/);
  });

  it("has unique codes", () => {
    const codes = Object.values(ContractErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("type guards", () => {
    expect(isStellarSafeError(new ValidationError("x"))).toBe(true);
    expect(isStellarSafeError(new Error("x"))).toBe(false);
    expect(new ValidationError("x").name).toBe("ValidationError");
    expect(new ValidationError("x").code).toBe("INVALID_ARGUMENT");
  });
});
