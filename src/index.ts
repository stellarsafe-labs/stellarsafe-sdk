/**
 * TypeScript SDK for StellarSafe treasuries on Stellar/Soroban.
 *
 * @packageDocumentation
 */

export { formatAmount, parseAmount, STELLAR_ASSET_DECIMALS } from "./amount.js";
export type {
  EventPage,
  GetEventsOptions,
  StellarSafeClientOptions,
  StreamEventsOptions,
} from "./client.js";
export { StellarSafeClient } from "./client.js";
export {
  decodeMember,
  decodePolicy,
  decodeProposal,
  decodeTreasuryConfig,
  encodePaymentRequest,
  encodePolicy,
  encodePolicyConfig,
  encodeProposal,
  encodeTreasuryConfig,
} from "./codec.js";
export type { ContractErrorName, StellarSafeErrorCode } from "./errors.js";
export {
  ContractError,
  ContractErrorCode,
  DecodeError,
  isContractError,
  isStellarSafeError,
  parseContractErrorCode,
  RestoreRequiredError,
  RpcError,
  SimulationError,
  StellarSafeError,
  TransactionError,
  ValidationError,
} from "./errors.js";
export type {
  EventMeta,
  EventPayloads,
  RawEvent,
  StellarSafeEvent,
  StellarSafeEventType,
  StellarSafeEventWithMeta,
} from "./events.js";
export { decodeEvent, EVENT_NAMESPACE, EVENT_TYPES, eventTopicFilter } from "./events.js";
export type { NetworkConfig, NetworkName } from "./networks.js";
export { NETWORKS } from "./networks.js";
export type { CheckPaymentContext, PolicyViolation, ProposalState } from "./policy.js";
export {
  canApprove,
  checkPayment,
  findDepartmentLimit,
  getProposalState,
  monthlyPeriod,
  periodBounds,
  periodIndex,
  requiredApprovals,
  THIRTY_DAYS_SECONDS,
  validatePolicyConfig,
} from "./policy.js";
export type { RetryOptions } from "./retry.js";
export type { TransactionSigner } from "./signer.js";
export { keypairSigner } from "./signer.js";
export type {
  FeeEstimate,
  PrepareOptions,
  ReadConsistency,
  RpcClient,
  SubmitOptions,
  TransactionResult,
} from "./transaction.js";
export { PreparedTransaction, READ_ONLY_SOURCE } from "./transaction.js";
export type { ProposalId, ReadOptions, WriteOptions } from "./treasury.js";
export { ConnectedTreasury, SUPPORTED_INTERFACE_VERSION, TreasuryClient } from "./treasury.js";
export type * from "./types.js";
export { ROLES } from "./types.js";
export { isValidAddress, isValidContractId } from "./validation.js";
