import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The end-to-end tests run the real fleet, which starts the plugin once per call.
    testTimeout: 180_000,
  },
});
