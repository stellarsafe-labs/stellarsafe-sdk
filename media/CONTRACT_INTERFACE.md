# StellarSafe Contract Interface — v1

This document is the **interface contract** between `stellarsafe-contracts`
(Rust/Soroban) and `@stellarsafe/sdk`. The SDK encodes and decodes exactly
what is described here. Any change to a function signature, type, event or
error code is a breaking change and must bump `interface_version`.

The contract reports its version in `get_config().interface_version`. The SDK
exposes the version it targets as `SUPPORTED_INTERFACE_VERSION` and checks it
in `TreasuryClient.assertCompatible()`.

Status: **v1**. Reference implementation: `stellarsafe-contracts/contracts/treasury`.
The SDK's unit tests check every call against the interface spec embedded in
the compiled wasm (`test/fixtures/stellarsafe_treasury.wasm`), and its
end-to-end suite runs the full lifecycle on testnet.

## Conventions

| Concept       | Soroban type                     | TypeScript type      |
| ------------- | -------------------------------- | -------------------- |
| Address       | `Address`                        | `string` (`G…`/`C…`) |
| Token amount  | `i128` (smallest unit)           | `bigint`             |
| Timestamp     | `u64` Unix seconds (ledger time) | `bigint`             |
| Duration      | `u64` seconds                    | `bigint`             |
| Proposal id   | `u64`, starting at 1             | `bigint`             |
| Count/version | `u32`                            | `number`             |
| Department    | `Symbol` (`[a-zA-Z0-9_]{1,32}`)  | `string`             |
| Memo, name    | `String` (≤ 256 bytes)           | `string`             |

Structs use `#[contracttype]` and are encoded as maps keyed by their
snake_case field names. Enums with unit variants are encoded as
`Vec[Symbol(variant)]`. `Option<T>` is `Void` or `T`.

## Types

```rust
#[contracttype]
pub enum Role { Proposer, Approver, Admin }   // cumulative privileges

#[contracttype]
pub struct Member { pub address: Address, pub role: Role }

#[contracttype]
pub struct ThresholdRule { pub min_amount: i128, pub approvals: u32 }

#[contracttype]
pub struct DepartmentLimit { pub department: Symbol, pub token: Address, pub limit: i128 }

#[contracttype]
pub struct SpendingPeriod { pub anchor: u64, pub length: u64 }

#[contracttype]
pub struct PolicyConfig {
    pub default_approvals: u32,
    pub thresholds: Vec<ThresholdRule>,
    pub recipient_allowlist_enabled: bool,
    pub allowed_recipients: Vec<Address>,
    pub allowed_tokens: Vec<Address>,        // empty = any token
    pub department_limits: Vec<DepartmentLimit>,
    pub period: SpendingPeriod,
    pub max_proposal_ttl: u64,
}

#[contracttype]
pub struct Policy {
    // all PolicyConfig fields, plus:
    pub version: u32,
    pub updated_at: u64,
}

#[contracttype]
pub struct PaymentRequest {
    pub token: Address,
    pub recipient: Address,
    pub amount: i128,
    pub department: Symbol,
    pub memo: String,
    pub expires_at: u64,
}

#[contracttype]
pub enum ProposalStatus { Pending, Executed, Cancelled }

#[contracttype]
pub struct Proposal {
    // all PaymentRequest fields, plus:
    pub id: u64,
    pub proposer: Address,
    pub created_at: u64,
    pub policy_version: u32,
    pub required_approvals: u32,
    pub approvals: Vec<Address>,
    pub status: ProposalStatus,
    pub closed_at: Option<u64>,
}

#[contracttype]
pub struct TreasuryConfig { pub name: String, pub proposal_count: u64, pub interface_version: u32 }

#[contracttype]
pub struct SpendInfo { pub period_index: u64, pub spent: i128 }
```

## Functions

Every write function takes the acting member as its first argument and calls
`caller.require_auth()`. By default the SDK makes that member the transaction
source, so one signature authorizes both the fee and the call. A different
account (a relayer or sponsor) can pay instead, with the member signing a
Soroban authorization entry.

### Constructor

Setup happens in `__constructor`, which runs atomically with deployment
(`createContractV2`). There is no separate `initialize` call, so nobody can
front-run a freshly deployed treasury and claim it.

| Function        | Args                                                                       | Who                    |
| --------------- | -------------------------------------------------------------------------- | ---------------------- |
| `__constructor` | `admin: Address, name: String, members: Vec<Member>, policy: PolicyConfig` | `admin` must authorize |

`admin` becomes an Admin; `members` must not repeat an address (including
the admin). The policy must be satisfiable by the initial approvers.

### Writes

| Function          | Args                                           | Returns           | Who                                |
| ----------------- | ---------------------------------------------- | ----------------- | ---------------------------------- |
| `add_member`      | `caller: Address, member: Address, role: Role` | `()`              | Admin                              |
| `remove_member`   | `caller: Address, member: Address`             | `()`              | Admin                              |
| `set_policy`      | `caller: Address, policy: PolicyConfig`        | `u32` new version | Admin                              |
| `propose_payment` | `proposer: Address, request: PaymentRequest`   | `u64` proposal id | any member                         |
| `approve_payment` | `approver: Address, proposal_id: u64`          | `()`              | Approver/Admin                     |
| `revoke_approval` | `approver: Address, proposal_id: u64`          | `()`              | the approver                       |
| `execute_payment` | `executor: Address, proposal_id: u64`          | `()`              | Approver/Admin                     |
| `cancel_payment`  | `caller: Address, proposal_id: u64`            | `()`              | proposer (while a member) or Admin |

### Reads

| Function                | Args                                 | Returns                                      |
| ----------------------- | ------------------------------------ | -------------------------------------------- |
| `get_config`            | —                                    | `TreasuryConfig`                             |
| `get_policy`            | —                                    | `Policy`                                     |
| `get_members`           | —                                    | `Vec<Member>`                                |
| `get_role`              | `address: Address`                   | `Option<Role>`                               |
| `get_proposal`          | `proposal_id: u64`                   | `Proposal` (or `ProposalNotFound`)           |
| `get_pending_proposals` | —                                    | `Vec<Proposal>` with status `Pending`        |
| `get_proposals`         | `start: u64, limit: u32` (≤ 100)     | `Vec<Proposal>` with id ≥ `start`, ascending |
| `get_spent`             | `department: Symbol, token: Address` | `SpendInfo` for the current period           |

## Rules the contract must enforce

These are the trust guarantees. The SDK mirrors them in `checkPayment()` and
`getProposalState()` for UX only; the contract is authoritative.

1. **Approvals required** — `required_approvals` is fixed at proposal time:
   the `approvals` of the `ThresholdRule` with the largest `min_amount <= amount`,
   else `default_approvals`.
2. **Policy versioning** — `set_policy` increments `version`. A proposal whose
   `policy_version` differs from the current version cannot be approved or
   executed (`PolicyVersionMismatch`). It must be re-proposed.
3. **Expiry** — a proposal can be approved or executed while
   `ledger.timestamp() <= expires_at`. At proposal time
   `now < expires_at <= now + max_proposal_ttl`, else `InvalidExpiry`.
4. **Allowlists** — if `recipient_allowlist_enabled`, `recipient` must be in
   `allowed_recipients`. If `allowed_tokens` is non-empty, `token` must be in it.
   Checked at proposal **and** execution.
5. **Spending limits** — period index is
   `(now - anchor) / length` (0 if `now < anchor`). Executing adds `amount` to
   the `(department, token, period_index)` counter, which must stay `<= limit`.
   A department with no limit for a token cannot spend it. Counters live in
   contract storage, never off-chain.
6. **No double execution** — status moves `Pending → Executed|Cancelled`
   exactly once; any later action fails with `ProposalNotPending`.
7. **Member removal** — removing a member deletes their approvals from all
   pending proposals. The last Admin cannot be removed (`LastAdmin`).
8. **Distinct approvals** — one approval per member per proposal (`AlreadyApproved`).
9. **Execution re-checks everything** — role, status, expiry, policy version,
   approval count (counting only current members), allowlists, limit and
   treasury balance, then records the spend and marks the proposal executed
   **before** calling the token contract's `transfer`.
10. **Bounded work** — members, thresholds, allowlist entries and department
    limits are each capped at 50 (`InvalidPolicy`), pending proposals at 100
    (`TooManyPending`), memos and names at 256 bytes (`MemoTooLong`), and
    `get_proposals` pages at 100. This keeps every call within Soroban's
    resource limits.
11. **Storage lifetime** — every write extends the TTL of the instance and
    of the entries it touches to ~30 days.

## Events

Topics: `[Symbol("stellarsafe"), Symbol(<name>), ...]`.

| Name               | Extra topics       | Data                                                                                |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------- |
| `initialized`      | —                  | `{ name: String, admin: Address, policy_version: u32 }`                             |
| `member_added`     | `member: Address`  | `Role`                                                                              |
| `member_removed`   | `member: Address`  | `{}` (empty map)                                                                    |
| `policy_updated`   | —                  | `u32` new version                                                                   |
| `proposed`         | `proposal_id: u64` | `{ proposer, token, recipient, amount: i128, department: Symbol, expires_at: u64 }` |
| `approved`         | `proposal_id: u64` | `{ approver: Address, approvals: u32 }`                                             |
| `approval_revoked` | `proposal_id: u64` | `{ approver: Address, approvals: u32 }`                                             |
| `executed`         | `proposal_id: u64` | `{ executor, token, recipient, amount: i128, department: Symbol }`                  |
| `cancelled`        | `proposal_id: u64` | `{ by: Address }`                                                                   |

`approvals` in `approved`/`approval_revoked` is the count after the change.

## Errors (`#[contracterror]`, `u32`)

| Code | Name                  | Code | Name                    |
| ---: | --------------------- | ---: | ----------------------- |
|    1 | `AlreadyInitialized`  |   11 | `InsufficientApprovals` |
|    2 | `NotInitialized`      |   12 | `RecipientNotAllowed`   |
|    3 | `Unauthorized`        |   13 | `SpendingLimitExceeded` |
|    4 | `NotMember`           |   14 | `PolicyVersionMismatch` |
|    5 | `MemberAlreadyExists` |   15 | `InvalidAmount`         |
|    6 | `ProposalNotFound`    |   16 | `InvalidPolicy`         |
|    7 | `ProposalNotPending`  |   17 | `InvalidExpiry`         |
|    8 | `ProposalExpired`     |   18 | `LastAdmin`             |
|    9 | `AlreadyApproved`     |   19 | `InsufficientBalance`   |
|   10 | `NotApproved`         |   20 | `TokenNotAllowed`       |
|      |                       |   21 | `MemoTooLong`           |
|      |                       |   22 | `TooManyPending`        |

`AlreadyInitialized` (1) is reserved; with constructor-based setup it cannot occur.
