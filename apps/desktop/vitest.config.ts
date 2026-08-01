import { defineConfig } from "vitest/config";

const windows = process.platform === "win32";

export default defineConfig({
  test: {
    ...(windows ? { maxWorkers: 4, testTimeout: 30_000 } : {}),
  },
});
