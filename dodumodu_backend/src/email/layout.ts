import { EMAIL_BRAND } from "./brand";

/** HTML-escape dynamic content so it is safe inside email markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shared branded email layout (table-based, email-client-safe).
 * Wraps email body content with header and footer. Reusable by all templates. */
export function emailLayout({ title, body, footer }: { title: string; body: string; footer?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_BRAND.bg};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="620"
               style="max-width:620px;width:100%;background:${EMAIL_BRAND.surface};
                      border:1px solid ${EMAIL_BRAND.border};border-radius:16px;
                      font-family:${EMAIL_BRAND.font};color:${EMAIL_BRAND.text};">
          <tr>
            <td style="padding:32px 32px 24px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 32px;border-top:1px solid ${EMAIL_BRAND.border};">
              <p style="margin:0;font-size:13px;line-height:1.5;color:${EMAIL_BRAND.muted};">
                DODUMODU &mdash; Skincare. Pay on delivery.<br>
                ${footer ?? "If you didn't request this code, you can safely ignore this email."}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Label/value rows for notification emails (order details, device facts). Values are escaped here; empty values are skipped. */
export function detailList(rows: ReadonlyArray<readonly [label: string, value: string | null | undefined]>): string {
  const cells = rows
    .filter(([, value]) => value !== null && value !== undefined && String(value) !== "")
    .map(([label, value]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;font-size:13px;line-height:1.5;color:${EMAIL_BRAND.muted};vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-size:14px;line-height:1.5;color:${EMAIL_BRAND.text};word-break:break-word;">${escapeHtml(String(value))}</td>
        </tr>`)
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>`;
}
