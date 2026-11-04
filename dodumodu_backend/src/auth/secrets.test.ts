import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAuthSecrets } from "./secrets";
import { AuthServerFaultError } from "./errors";

const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

test("loadAuthSecrets accepts configured 32-byte keys", () => {
  const secrets = loadAuthSecrets({
    DATABASE_URL: "",
    OTP_KEY: key,
    THROTTLE_KEY: key,
    TOTP_ENC_KEY: key,
  } as Parameters<typeof loadAuthSecrets>[0]);
  assert.equal(secrets.otpKey.length, 32);
  assert.equal(secrets.throttleKey.length, 32);
  assert.equal(secrets.totpEncKey.length, 32);
});

test("loadAuthSecrets maps malformed keys to an auth server fault", () => {
  assert.throws(
    () => loadAuthSecrets({
      DATABASE_URL: "",
      OTP_KEY: "not base64!",
      THROTTLE_KEY: key,
      TOTP_ENC_KEY: key,
    } as Parameters<typeof loadAuthSecrets>[0]),
    AuthServerFaultError,
  );
});
