import type { EmailProvider } from "../provider";
import { loginCodeTemplate } from "../templates/login-code";
import { backupUsedTemplate } from "../templates/backup-used";
import { permissionChangeTemplate } from "../templates/permission-change";
import { deniedAlertTemplate } from "../templates/denied-alert";
import { newNetworkTemplate } from "../templates/new-network";
import { deviceEventTemplate } from "../templates/device-event";

/** The login-code email (code never logged). Returns true when Resend accepts. */
export async function sendLoginCode(
  provider: EmailProvider, to: string, code: string,
  idempotencyKey?: string,
): Promise<boolean> {
  const { subject, text, html } = loginCodeTemplate({ code });
  return provider.send(to, subject, text, idempotencyKey ?? `login-code:${to}`, html);
}

/** Permission change for the affected user (spec §5.10). */
export async function sendBackupUsed(
  provider: EmailProvider, to: string, remaining: number,
): Promise<void> {
  const { subject, text } = backupUsedTemplate({ remaining });
  await provider.send(to, subject, text, `backup-used:${to}`);
}

/** Permission change for the affected user (spec §5.10). */
export async function sendPermChange(
  provider: EmailProvider, to: string, perm: string, granted: boolean,
): Promise<void> {
  const { subject, text } = permissionChangeTemplate({ perm, granted });
  await provider.send(to, subject, text, `perm:${to}:${perm}:${granted}`);
}

/** Sign-in attempt from an unrecognized device (denied path, max 1 / 6 h). */
export async function sendDeniedAlert(
  provider: EmailProvider, to: string,
): Promise<void> {
  const { subject, text } = deniedAlertTemplate();
  await provider.send(to, subject, text, `denied-alert:${to}`);
}

/** Sign-in from a new network (strict tier). No full IP, no UA beyond a hint. */
export async function sendNewNetwork(
  provider: EmailProvider, to: string, country: string | null,
): Promise<void> {
  const { subject, text } = newNetworkTemplate({ country });
  await provider.send(to, subject, text, `new-network:${to}`);
}

/** A device was invited or registered (spec §5.10). */
export async function sendDeviceEvent(
  provider: EmailProvider, to: string, kind: "invited" | "registered",
): Promise<void> {
  const { subject, text } = deviceEventTemplate({ kind });
  await provider.send(to, subject, text, `device-${kind}:${to}`);
}