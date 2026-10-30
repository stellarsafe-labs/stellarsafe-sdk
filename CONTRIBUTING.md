# Contributing to @stellarsafe/sdk

Thanks for helping! This guide covers setup, standards and the review process.

## Setup

```sh
git clone https://github.com/stellarsafe-labs/stellarsafe-sdk
cd stellarsafe-sdk
npm ci
npm run ci
```

Node.js ≥ 22.12 is required (see `.nvmrc`).

## Project layout

```
src/
  client.ts        StellarSafeClient: configuration, network, events
  treasury.ts      TreasuryClient: typed reads and writes for one treasury
  transaction.ts   build → simulate → assemble → sign → submit pipeline
  codec.ts         strict ScVal encoders/decoders for contract types
  events.ts        contract event decoding
  policy.ts        offline policy evaluation helpers (advisory)
  amount.ts        exact decimal ⇄ bigint conversion
  errors.ts        error classes and contract error codes
  types.ts         domain types mirroring the contract
test/
  unit/            fast tests; the RPC is faked (test/helpers/fake-rpc.ts)
  integration/     testnet tests, opt-in
docs/
  CONTRACT_INTERFACE.md   the interface the SDK and contract share
```

## Standards

- **TypeScript strict mode**, no `any`, no non-null assertions.
- **Biome** for lint and formatting: `npm run lint:fix`.
- **Tests required** for every behaviour change. Coverage thresholds are
  enforced in CI (90% lines/functions/statements, 85% branches).
- **Public API changes** need TSDoc comments and a README update if user-facing.
- **Contract interface changes** must update `docs/CONTRACT_INTERFACE.md`
  and be coordinated with `stellarsafe-contracts`.
- No new runtime dependencies without discussion in an issue first.

## Changesets

Every user-visible change needs a changeset:

```sh
npx changeset
```

Pick `patch` for fixes, `minor` for features, `major` for breaking changes
(pre-1.0, breaking changes are `minor`). The release workflow turns changesets
into version bumps and changelog entries.

## Pull requests

1. Open or comment on an issue first for anything non-trivial.
2. Keep PRs focused; one concern per PR.
3. Make sure `npm run ci` passes locally.
4. Fill in the PR template, including how you tested.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Good first issues

Look for the `good first issue` and `help wanted` labels. Each issue lists
acceptance criteria and a definition of done.
