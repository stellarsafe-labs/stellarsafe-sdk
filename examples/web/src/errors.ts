import { isContractError, isStellarSafeError } from "@stellarsafe/sdk";

/** Turn anything thrown by the SDK or wallet into a message for the user. */
export function explainError(err: unknown): string {
  // Contract rejected the call, either in simulation (before signing) or on-chain.
  if (isContractError(err)) {
    const name = err.contractErrorName ?? `contract error #${err.contractCode}`;
    return `Contract rejected the call: ${name}\n${err.message}`;
  }
  if (isStellarSafeError(err)) {
    switch (err.code) {
      case "SIGNING_FAILED":
        return (
          "The wallet did not sign (SIGNING_FAILED). Nothing was submitted; you can try again.\n" +
          `Details: ${err.message}`
        );
      case "AUTH_REQUIRED":
        return `Another account must authorize this first (AUTH_REQUIRED).\n${err.message}`;
      case "NETWORK_MISMATCH":
        return `Wrong network (NETWORK_MISMATCH). Switch the wallet to testnet.\n${err.message}`;
      default:
        // Simulation errors carry a long diagnostic log; the full error is in the console.
        return `${err.code}: ${err.message.split("\n")[0]}`;
    }
  }
  if (err instanceof Error) return err.message;
  // The kit throws plain `{ code, message }` objects, e.g. when the picker is closed.
  if (typeof err === "object" && err !== null && "message" in err) return String(err.message);
  return String(err);
}
