// Cloudflare Workers composition root — this file is `main` in wrangler.toml
// and the only thing the production bundle is built from.
//
// It does exactly two things: register the Neon driver and hand over the shared
// app. Everything runtime-specific to the Worker (R2, KV, the bindings) arrives
// through the request's `env` object, so there is nothing else to wire up.
//
// Nothing local lives here on purpose: src/node.ts and src/dbDrivers/pg.ts are
// never imported from this file, which is what keeps `pg` and the local shims
// out of the Worker bundle. src/isolation.test.ts enforces that.
import { registerDbDriver } from "./db";
import { neonDriver } from "./dbDrivers/neon";
import { app } from "./app";

registerDbDriver(neonDriver);

export default app;
