import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "drizzle-kit";

// Same root .env the app and the migrator read, so "npm run db:generate" works
// in a fresh clone without exporting anything first. Never overrides a real
// environment variable.
const rootEnvPath = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), ".env");
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    // `db:generate` only reads the schema file, so this value is never dialled
    // — a placeholder keeps the command usable with no database configured.
    url: process.env.DATABASE_URL ?? "postgresql://localhost/dodumodu",
  },
} satisfies Config;
