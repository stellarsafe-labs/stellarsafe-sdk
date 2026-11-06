/**
 * Wallet adapter: Stellar Wallets Kit → `TransactionSigner`.
 *
 * This is the only file that knows about the kit. Everything else talks to
 * the SDK's `TransactionSigner` interface, so swapping wallets (or using
 * Freighter's API directly) only means changing this file.
 *
 * `TransactionSigner` is three members:
 *
 * - `address` — the account the signer signs for.
 * - `signTransaction(xdr, opts)` — SEP-43. Used by `PreparedTransaction.sign`
 *   and `signAndSubmit`. The SDK then checks the wallet returned the same
 *   transaction (same hash) with a new signature before submitting.
 * - `signAuthEntry(preimageXdr, opts)` — SEP-43, optional. Used by
 *   `PreparedTransaction.signAuthEntries` when someone else pays the fee.
 *
 * The kit's methods already have these shapes. When the user rejects a
 * request, the kit throws `{ code, message }` (not an `Error`); the SDK wraps
 * anything thrown here in a `StellarSafeError` with code `SIGNING_FAILED`.
 */
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { sep43Modules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { VARIAL_ID } from "@creit.tech/stellar-wallets-kit/modules/varial";
import type { TransactionSigner } from "@stellarsafe/sdk";

/**
 * Set up the kit for testnet. `sep43Modules()` lists wallets that implement
 * SEP-43 in full, including `signAuthEntry`. Freighter is listed as "Varial"
 * (its new name) in kit v2.8+.
 */
export function initWallets(): void {
  StellarWalletsKit.init({
    modules: sep43Modules(),
    selectedWalletId: VARIAL_ID,
    network: Networks.TESTNET,
  });
}

/** Open the kit's wallet picker and return a signer for the chosen account. */
export async function connectWallet(): Promise<TransactionSigner> {
  const { address } = await StellarWalletsKit.authModal();
  return walletSigner(address);
}

/**
 * Re-read the account currently selected in the wallet. Use it after the user
 * switches accounts (for example to the fee payer in a relayed-fee flow).
 */
export async function refreshWallet(): Promise<TransactionSigner> {
  const { address } = await StellarWalletsKit.fetchAddress();
  return walletSigner(address);
}

/** Network passphrase the wallet is currently on, to warn when it is not testnet. */
export async function walletNetworkPassphrase(): Promise<string> {
  return (await StellarWalletsKit.getNetwork()).networkPassphrase;
}

export async function disconnectWallet(): Promise<void> {
  await StellarWalletsKit.disconnect();
}

/**
 * The adapter. `address` is passed through to the wallet so it signs with
 * that account (or refuses) rather than whichever account happens to be
 * selected.
 */
export function walletSigner(address: string): TransactionSigner {
  return {
    address,
    signTransaction: (xdr, opts) => StellarWalletsKit.signTransaction(xdr, { ...opts, address }),
    signAuthEntry: (preimageXdr, opts) =>
      StellarWalletsKit.signAuthEntry(preimageXdr, { ...opts, address }),
  };
}
