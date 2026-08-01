import { defineConfig } from "vitest/config";

const windows = process.platform === "win32";

export default defineConfig({
  test: {
    ...(windows ? { maxWorkers: 2, testTimeout: 60_000 } : {}),
  },
});
