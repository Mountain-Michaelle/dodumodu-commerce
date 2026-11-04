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

test("loadAuthSecrets reports stable metadata for missing and malformed secrets", () => {
  let missing: unknown;
  try {
    loadAuthSecrets({
      DATABASE_URL: "",
      OTP_KEY: undefined,
      THROTTLE_KEY: key,
      TOTP_ENC_KEY: key,
    } as Parameters<typeof loadAuthSecrets>[0]);
  } catch (error) {
    missing = error;
  }
  assert.ok(missing instanceof AuthServerFaultError);
  assert.equal(missing.code, "AUTH_SECRET_MISSING");
  assert.equal(missing.stage, "secrets.load");
  assert.equal(missing.category, "configuration");

  let malformed: unknown;
  try {
    loadAuthSecrets({
      DATABASE_URL: "",
      OTP_KEY: "not base64!",
      THROTHLE_KEY: key,
      TOTP_ENC_KEY: key,
    } as Parameters<typeof loadAuthSecrets>[0]);
  } catch (error) {
    malformed = error;
  }
  assert.ok(malformed instanceof AuthServerFaultError);
  assert.equal(malformed.code, "AUTH_SECRET_INVALID");
  assert.equal(malformed.stage, "secrets.load");
  assert.equal(malformed.category, "configuration");
});
