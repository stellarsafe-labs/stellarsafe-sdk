import { describe, expect, it, vi } from "vitest";
import { StellarSafeError } from "../../src/index.js";
import { isTransientError, sleep, withRetry } from "../../src/retry.js";

describe("isTransientError", () => {
  it.each([
    [{ response: { status: 503 } }, true],
    [{ status: 429 }, true],
    [{ response: { status: 400 } }, false],
    [{ code: "ECONNRESET" }, true],
    [{ name: "TimeoutError" }, true],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), true],
    [new TypeError("x is not a function"), false],
    [new StellarSafeError("RPC_ERROR", "x"), false],
    ["string", false],
    [null, false],
  ])("%j → %s", (err, expected) => {
    expect(isTransientError(err)).toBe(expected);
  });
});

describe("withRetry", () => {
  it("retries transient errors then succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ code: "ETIMEDOUT" })
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured retries", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours abort signals", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(withRetry(async () => 1, {}, ac.signal)).rejects.toMatchObject({
      code: "ABORTED",
    });
  });
});

describe("sleep", () => {
  it("aborts early", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort("stop");
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("resolves", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});
