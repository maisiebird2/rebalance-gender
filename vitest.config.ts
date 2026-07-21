import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

// Mirrors the "@/*" -> "./src/*" path alias from tsconfig.json so test
// files can import app code the same way the app itself does.
export default defineConfig({
  test: {
    environment: "node",
    // Git worktrees live under .claude/worktrees/ and hold full copies of the
    // source tree. Without this, the default glob collects every worktree's
    // tests alongside the working tree's, so each failure is reported once per
    // worktree and stale branches can fail an otherwise-clean run.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
