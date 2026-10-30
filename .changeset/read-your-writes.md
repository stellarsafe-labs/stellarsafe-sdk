---
"@stellarsafe/sdk": patch
---

Fix stale reads after a confirmed write on load-balanced RPC endpoints. Clients now wait for the RPC to reach the ledger of their last write before reading or simulating, never reuse a sequence number from a lagging node, and accept an explicit `minLedger` read option.
