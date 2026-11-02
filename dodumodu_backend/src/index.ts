// Cloudflare Workers composition root — this file is `main` in wrangler.toml
// and the only thing the production bundle is built from.
//
// All routing (storefront, admin namespace, media, health) lives in src/app.ts;
// this file only registers the Neon driver and exports the shared app.
//
// Nothing local lives here on purpose: src/node.ts and src/dbDrivers/pg.ts are
// never imported from this file, which is what keeps `pg` and the local shims
// out of the Worker bundle. src/isolation.test.ts enforces that.
import { registerDbDriver } from "./db";
import { neonDriver } from "./dbDrivers/neon";
import { app } from "./app";

registerDbDriver(neonDriver);
export default app;
