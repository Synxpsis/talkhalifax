import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.test.jsonc" },
    remoteBindings: false,
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
  })],
  test: { include: ["test/unit/**/*.test.ts"], setupFiles: ["./test/unit/setup.ts"] },
}));
