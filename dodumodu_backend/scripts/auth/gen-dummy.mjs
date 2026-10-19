import { argon2id } from "hash-wasm";
const h = await argon2id({
  password: "dummy-phrase-for-timing-only",
  salt: new Uint8Array(16),
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
  outputType: "encoded",
});
console.log("DUMMY_HASH=" + h);
