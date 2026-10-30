import { hash, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { base64ToBytes, bytesToBase64 } from "./encoding.js";
import { StellarSafeError } from "./errors.js";

/**
 * Anything that can sign a transaction envelope.
 *
 * The shape matches SEP-43 wallets (Freighter, the Stellar Wallets Kit, …)
 * and `@stellar/stellar-sdk`'s `contract.Signer`, so those objects can be
 * passed in directly. `address` is the account the signer signs for.
 */
export interface TransactionSigner {
  readonly address: string;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string; error?: unknown }>;
  /**
   * Sign a Soroban authorization entry preimage (base64 `HashIdPreimage`
   * XDR), returning the base64 ed25519 signature of its SHA-256 hash.
   * Needed only to authorize calls where this signer is not the
   * transaction source; see `PreparedTransaction.signAuthEntries`.
   */
  signAuthEntry?(
    preimageXdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: unknown }>;
}

/**
 * Create a {@link TransactionSigner} from a secret key or `Keypair`.
 *
 * Intended for servers, scripts and tests. In browsers, use the user's wallet
 * instead of handling secret keys.
 */
export function keypairSigner(secretOrKeypair: string | Keypair): TransactionSigner {
  const keypair =
    typeof secretOrKeypair === "string" ? Keypair.fromSecret(secretOrKeypair) : secretOrKeypair;
  if (!keypair.canSign()) {
    throw new StellarSafeError("SIGNING_FAILED", "Keypair has no secret key and cannot sign");
  }
  const address = keypair.publicKey();
  return {
    address,
    async signTransaction(envelopeXdr, opts) {
      if (!opts?.networkPassphrase) {
        throw new StellarSafeError("SIGNING_FAILED", "networkPassphrase is required to sign");
      }
      const tx = TransactionBuilder.fromXDR(envelopeXdr, opts.networkPassphrase);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    },
    async signAuthEntry(preimageXdr, opts) {
      // Parse first so we only ever sign a well-formed authorization preimage.
      const preimage = xdr.HashIdPreimage.fromXdr(base64ToBytes(preimageXdr));
      let networkId: Uint8Array;
      if (preimage.type === "envelopeTypeSorobanAuthorization") {
        networkId = preimage.sorobanAuthorization.networkId.value;
      } else if (preimage.type === "envelopeTypeSorobanAuthorizationWithAddress") {
        networkId = preimage.sorobanAuthorizationWithAddress.networkId.value;
      } else {
        throw new StellarSafeError(
          "SIGNING_FAILED",
          "Refusing to sign a non-authorization preimage",
        );
      }
      if (
        opts?.networkPassphrase !== undefined &&
        bytesToBase64(networkId) !== bytesToBase64(hash(opts.networkPassphrase))
      ) {
        throw new StellarSafeError("SIGNING_FAILED", "Authorization is for a different network");
      }
      const signature = keypair.sign(hash(preimage.toXdr()));
      return { signedAuthEntry: bytesToBase64(signature), signerAddress: address };
    },
  };
}
