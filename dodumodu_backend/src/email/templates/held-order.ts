import { EMAIL_BRAND } from "../brand";
import { detailList, emailLayout, escapeHtml } from "../layout";
import { clean } from "../../services/orderBackupMailer";

export interface HeldOrderData {
  id: number;
  customerName: string;
  phone: string;
  reason: string;
  reference: string;
  ip: string | null;
  deviceId: string | null;
  browser: string | null;
  clientKind: string | null;
  receivedAt: string;
  /** The order exactly as the customer sent it (secrets already removed by the caller). */
  fields: ReadonlyArray<readonly [string, string]>;
}

/** An order held back because its phone number looks like a flood. Sent to SPAM_ORDER_EMAIL. */
export function heldOrderTemplate(data: HeldOrderData): { subject: string; text: string; html: string; idempotencyKey: string } {
  const subject = `[HELD - SPAM?] ${clean(data.customerName, 60)} · ${clean(data.phone, 20)}`;
  const facts: Array<readonly [string, string]> = [
    ["Reason", clean(data.reason, 300)],
    ["Reference shown to customer", clean(data.reference, 40)],
    ["IP", data.ip ?? "unknown"],
    ["Device", data.deviceId ?? "none"],
    ["Browser", `${data.browser ?? "unknown"} (${data.clientKind ?? "unknown"})`],
    ["Received", clean(data.receivedAt, 40)],
  ];
  const intro = "This order was NOT saved to the orders list because it looks like a flood from one phone number. " +
    "The customer saw a normal \"order received\" page. If it is a real order, open the admin console → Abuse & spam → Spam orders and press \"Release as order\".";

  const text = `${intro}\n\n${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${data.fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;

  const html = emailLayout({
    title: "Order held for review",
    footer: "Automatic notice from the DODUMODU order system. Nothing was blocked.",
    body: `
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:${EMAIL_BRAND.text};">Order held for review</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">${escapeHtml(intro)}</p>
      ${detailList(facts)}
      <h2 style="margin:24px 0 8px;font-size:16px;font-weight:700;color:${EMAIL_BRAND.text};">Order details</h2>
      ${detailList(data.fields)}`,
  });
  return { subject, text, html, idempotencyKey: `held-order:${data.id}` };
}
