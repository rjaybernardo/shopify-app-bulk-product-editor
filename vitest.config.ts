import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the React Router plugin isn't loaded for tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
  },
});
