import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        exclude: ["node_modules", ".next"],
        // Test-isolation guardrails — points DB/network env at unroutable addresses so
        // an unmocked test fails fast instead of silently hitting the live local DB.
        // See vitest.setup.ts for the full incident rationale.
        setupFiles: ["./vitest.setup.ts"],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
