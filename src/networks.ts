import { Networks } from "@stellar/stellar-sdk";

/** Built-in network names. */
export type NetworkName = "testnet" | "mainnet" | "futurenet" | "local";

/** Connection details for a Stellar network. */
export interface NetworkConfig {
  /** Network passphrase used when signing transactions. */
  readonly networkPassphrase: string;
  /** Default Soroban RPC URL, if there is a well-known public one. */
  readonly defaultRpcUrl: string | undefined;
  /** Friendbot URL for funding test accounts, where available. */
  readonly friendbotUrl: string | undefined;
}

/**
 * Presets for the public Stellar networks.
 *
 * Mainnet has no default RPC URL on purpose: pick a production RPC provider
 * (see https://developers.stellar.org/docs/data/rpc/rpc-providers) and pass
 * its URL explicitly.
 */
export const NETWORKS: Readonly<Record<NetworkName, NetworkConfig>> = Object.freeze({
  testnet: {
    networkPassphrase: Networks.TESTNET,
    defaultRpcUrl: "https://soroban-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
  },
  mainnet: {
    networkPassphrase: Networks.PUBLIC,
    defaultRpcUrl: undefined,
    friendbotUrl: undefined,
  },
  futurenet: {
    networkPassphrase: Networks.FUTURENET,
    defaultRpcUrl: "https://rpc-futurenet.stellar.org",
    friendbotUrl: "https://friendbot-futurenet.stellar.org",
  },
  local: {
    networkPassphrase: Networks.STANDALONE,
    defaultRpcUrl: "http://localhost:8000/rpc",
    friendbotUrl: "http://localhost:8000/friendbot",
  },
});

/** Type guard for built-in network names. */
export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === "string" && Object.hasOwn(NETWORKS, value);
}
