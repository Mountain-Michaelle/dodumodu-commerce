import { EMAIL_BRAND } from "../brand";
import { emailLayout, escapeHtml } from "../layout";

export interface LoginCodeData {
  code: string;
}

/** GitHub-inspired OTP email body: clear heading, individually separated selectable
 * digit boxes, brand colors, no scripts. Digits are plain text so they remain
 * readable and copyable even when CSS is stripped. */
export function loginCodeTemplate(data: LoginCodeData): { subject: string; text: string; html: string } {
  const { code } = data;
  const text = `Your code is ${code}. It expires in 3 minutes. If you did not request it, ignore this email.`;

  const digits = code.split("").map((d) => {
    const digit = escapeHtml(d);
    return `<td align="center" style="padding:0;"><span style="display:inline-block;width:44px;height:56px;line-height:56px;text-align:center;background:${EMAIL_BRAND.surface};border:1px solid ${EMAIL_BRAND.border};border-radius:10px;font-size:28px;font-weight:700;color:${EMAIL_BRAND.text};font-variant-numeric:tabular-nums;letter-spacing:0;">${digit}</span></td>`;
  }).join("");

  const html = emailLayout({
    title: "Your sign-in code",
    body: `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:0 0 20px;">
            <h1 style="margin:0 0 10px;font-size:20px;font-weight:700;color:${EMAIL_BRAND.text};">
              Your sign-in code
            </h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">
              Enter the code below to complete your sign-in. It expires in 3 minutes.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 0 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr style="height:56px;">${digits}</tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 16px;font-size:14px;line-height:1.5;color:${EMAIL_BRAND.muted};">
            Copy the code above by selecting it. If you didn't request this code,
            you can safely ignore this email.
          </td>
        </tr>
      </table>
    `,
  });

  return { subject: "Your sign-in code", text, html };
}