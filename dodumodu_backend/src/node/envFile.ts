// Root .env loading for the local Node entry. Node's own parser, no dependency.
// The file is optional and never committed; see the .env.example next to it.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** dodumodu_backend/ */
export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** the repository root, which is where the single shared .env lives */
export const repoRoot = resolve(backendRoot, "..");
export const rootEnvPath = join(repoRoot, ".env");

/**
 * Loads the repository-root .env into process.env and reports whether it found
 * one. Real environment variables always win — loadEnvFile never overwrites
 * them — so `DATABASE_URL=... npm run db:migrate` still overrides the file, and
 * a CI run with everything already exported needs no .env at all.
 */
export function loadRootEnv(): boolean {
  if (!existsSync(rootEnvPath)) return false;
  process.loadEnvFile(rootEnvPath);
  return true;
}