import { defineConfig } from "vite";

export default defineConfig({
  // The SDK is linked from the repo root (file:../..), which has its own
  // node_modules. Dedupe so the app ships one copy of stellar-sdk.
  resolve: { dedupe: ["@stellar/stellar-sdk"] },
  // Stellar SDK + wallet modules are large; this is a demo, not a perf baseline.
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
