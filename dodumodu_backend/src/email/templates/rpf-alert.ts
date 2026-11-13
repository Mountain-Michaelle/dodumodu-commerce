import { EMAIL_BRAND } from "../brand";
import { detailList, emailLayout, escapeHtml } from "../layout";
import { clean } from "../../services/orderBackupMailer";

export interface RpfAlertData {
  id: number;
  scope: "ip" | "device";
  distinctPhones: number;
  orderCount: number;
  windowMinutes: number;
  ip: string | null;
  deviceId: string | null;
  browser: string | null;
  clientKind: string | null;
  orderIds: number[];
  raisedAt: string;
}

/** One device or address ordering under many different phone numbers (a "rotating phone flood"). Informational only. */
export function rpfAlertTemplate(data: RpfAlertData): { subject: string; text: string; html: string; idempotencyKey: string } {
  const what = data.scope === "ip" ? "internet address" : "device";
  const subject = `[RPF SUSPECT] ${data.distinctPhones} different phones from one ${data.scope === "ip" ? "address" : "device"}`;
  const facts: Array<readonly [string, string]> = [
    ["IP", data.ip ?? "unknown"],
    ["Device", data.deviceId ?? "none"],
    ["Browser", `${data.browser ?? "unknown"} (${data.clientKind ?? "unknown"})`],
    ["Order ids", data.orderIds.join(", ")],
    ["Alert", `#${data.id} raised ${clean(data.raisedAt, 40)}`],
  ];
  const intro = `One ${what} has placed orders under ${data.distinctPhones} different phone numbers in ${data.windowMinutes} minutes ` +
    `(${data.orderCount} orders). The orders were STORED normally and nothing was blocked.`;
  const action = "To block it: admin console → Abuse & spam → RPF suspects → Block. Only admins can block, and you will be asked for your authenticator code.";

  const text = `${intro}\n\n${action}\n\n${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;

  const html = emailLayout({
    title: "RPF suspect",
    footer: "Automatic notice from the DODUMODU order system. Nothing was blocked.",
    body: `
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:${EMAIL_BRAND.text};">RPF suspect</h1>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">${escapeHtml(intro)}</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">${escapeHtml(action)}</p>
      ${detailList(facts)}`,
  });
  return { subject, text, html, idempotencyKey: `rpf-alert:${data.id}` };
}
