import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  new URL("./migrations", import.meta.url).pathname,
);
const migrationModule = "virtual:web-migrations";
const migrationPlugin = {
  name: "web-migrations",
  resolveId(id: string) {
    return id === migrationModule ? `\0${migrationModule}` : undefined;
  },
  load(id: string) {
    return id === `\0${migrationModule}`
      ? `export default ${JSON.stringify(migrations)};`
      : undefined;
  },
};

export default defineConfig({
  plugins: [
    migrationPlugin,
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    sequence: { concurrent: false },
  },
});
