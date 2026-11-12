// Backward-compatible re-exports from the modular email architecture.
// src/email/ owns the implementation; this module preserves existing imports.

// Provider interface and implementations
export type { EmailProvider } from "../email/provider";
export {
  resendProvider,
  nullProvider,
  unconfiguredProvider,
  captureProvider,
  testMailbox,
  providerFor,
  providerForEnv,
  fromForEnv,
  sendInBackground,
} from "../email/provider";

// Auth email senders (use shared templates from src/email/templates/)
export {
  sendLoginCode,
  sendBackupUsed,
  sendPermChange,
  sendDeniedAlert,
  sendNewNetwork,
  sendDeviceEvent,
} from "../email/senders/auth-emails";

