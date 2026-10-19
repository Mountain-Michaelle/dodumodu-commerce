// scripts/auth/superuser.ts — pure, testable CLI-grammar for createsuperuser.
// Kept separate from the script so the argument rules (the part most likely to
// regress) have committed unit coverage without a database. The script imports
// parseSuperuserArgs and turns a thrown Error into a non-zero exit.
import { normalizeEmail } from "../../src/auth/crypto.js";

export interface SuperuserArgs {
  email: string;
  username?: string;
}

const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

/**
 * Exactly one required positional <email> and at most one optional
 * --username=<value>. Throws Error(message) on: no email, extra positionals,
 * unknown flags, duplicate/empty --username, invalid email, invalid username.
 * The caller maps a throw to exit(1) + the message (creates nothing).
 */
export function parseSuperuserArgs(argv: string[]): SuperuserArgs {
  const positionals: string[] = [];
  let username: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--username=")) {
      if (username !== undefined) throw new Error("Duplicate --username flag.");
      username = a.slice("--username=".length);
      if (!username) throw new Error("--username must not be empty.");
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length === 0) {
    throw new Error("Usage: npm run createsuperuser -- <email> [--username=<value>]");
  }
  if (positionals.length > 1) {
    throw new Error(`Expected exactly one email, got ${positionals.length} arguments.`);
  }
  const email = normalizeEmail(positionals[0]);
  if (!email) throw new Error(`Invalid email: ${JSON.stringify(positionals[0])}`);
  if (username !== undefined && !USERNAME_RE.test(username)) {
    throw new Error("username must match ^[a-z0-9_.-]{3,30}$");
  }
  return { email, username };
}
