// Argon2id for the passphrase (spec §9, decision 1). Pure-WASM via hash-wasm,
// which ships precompiled WASM so it imports on Cloudflare Workers with no
// runtime compile and no nodejs_compat requirement.
//
// Why Argon2id and not a faster KDF: the passphrase is the one factor a person
// reuses, so the stored form must be expensive to attack offline even after a
// database leak. The tradeoff is CPU time, which on Workers is billed and capped,
// so the parameters are a deliberate balance (see the CPU measurement in
// PROGRESS.md) rather than the strongest possible. A 64-byte PHC-encoded output
// keeps the whole parameter set + salt inside the one string we store, so the
// verifier never has to trust stored parameters.

import { argon2id, argon2Verify } from "hash-wasm";

// Chosen from the measured CPU on wrangler dev / the preview Worker (see
// PROGRESS.md). memorySize is in KiB. 19 MiB / t=2 / p=1 keeps a single hash
// comfortably inside a Workers request while still being materially expensive
// offline. These are encoded into the hash, so changing them later only affects
// newly enrolled phrases (verification reads them from the stored string).
const MEMORY_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LEN = 32;
const SALT_LEN = 16;

/** Hash a new passphrase into a self-describing PHC string (store this). */
export async function hashPhrase(phrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  return argon2id({
    password: phrase,
    salt,
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: HASH_LEN,
    outputType: "encoded",
  });
}

/** Verify a candidate against a stored PHC string. Constant-time via WASM. */
export async function verifyPhrase(stored: string, phrase: string): Promise<boolean> {
  return argon2Verify({ password: phrase, hash: stored });
}

/**
 * Verify against a fixed, throwaway hash. Used for the dummy-flow phrase stage
 * so an unknown email burns the same Argon2 CPU as a real one (spec §6: dummy
 * flows match in shape, including timing, not just in response body).
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$decgOdFNrPUcqLqEXAsi79hvkhkTXx76Av/wPAEo1oI";
export async function verifyDummyPhrase(phrase: string): Promise<boolean> {
  return argon2Verify({ password: phrase, hash: DUMMY_HASH });
}
