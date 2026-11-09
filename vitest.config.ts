import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root config for the Next-app side (lib/**). The backend keeps its own
// config in backend/vitest.config.ts; its suites join the CI gate when
// PR #54 lands them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/__tests__/**/*.test.ts"],
    // Vitest's default is one worker per CPU minus one. On a 32-thread machine
    // 31 workers took up to 22 GB of commit and left no RAM free: workers died
    // ("Fatal process out of memory: Zone") and tests timed out at random. Past
    // 6 the suite gets no faster, one-time-password.test.ts alone takes 100 s.
    maxWorkers: Math.min(6, Math.max(availableParallelism() - 1, 1)),
    // A test that calls a paid provider must never join the suite: `npm test`
    // and CI would then bill real money on every run, silently. One such file
    // reached a commit on 2026-08-06 because nothing stopped it. Live probes
    // are written as *.live.test.ts, __live-* or __bench-*, gitignored, and run
    // by name. The names are the first line; vitest.setup.ts is the second, for
    // the paid call that arrives under an innocent filename.
    exclude: [
      "**/node_modules/**",
      "**/*.live.test.ts",
      "**/__live-*",
      "**/__bench-*",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
