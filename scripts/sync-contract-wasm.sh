#!/usr/bin/env sh
# Build the treasury contract and copy the wasm into test fixtures.
#   scripts/sync-contract-wasm.sh [path-to-stellarsafe-contracts]
set -eu
CONTRACTS="${1:-../stellarsafe-contracts}"
(cd "$CONTRACTS" && ./build.sh)
cp "$CONTRACTS/target/wasm32v1-none/release/stellarsafe_treasury.wasm" test/fixtures/
sha256sum test/fixtures/stellarsafe_treasury.wasm | cut -d' ' -f1 > test/fixtures/stellarsafe_treasury.wasm.sha256
echo "Updated fixture: $(cat test/fixtures/stellarsafe_treasury.wasm.sha256)"
echo "Run 'npm test' to check the SDK still conforms to the contract interface."
