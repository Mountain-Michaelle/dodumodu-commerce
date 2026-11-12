import { EMAIL_BRAND } from "../brand";
import { emailLayout, escapeHtml } from "../layout";

export interface LoginCodeData {
  code: string;
}

/** GitHub-inspired OTP email body: clear heading, dark code block with orange digits for easy
 * one-time select and copy, brand colors, no scripts. Code is plain text so it
 * remains readable and copyable even when CSS is stripped.
 *
 * Email clients cannot run JavaScript, so a true "copy" button is not possible.
 * Instead the code sits in its own cell with `user-select:all`, so a single
 * click / tap-and-hold selects the whole code in clients that honour it. */
export function loginCodeTemplate(data: LoginCodeData): { subject: string; text: string; html: string } {
  const { code } = data;
  const text = `Your code is ${code}. Code expires in 3 minutes. If you did not request it, ignore this email.`;

  const html = emailLayout({
    title: "Your sign-in code",
    body: `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:0 0 20px;">
            <h1 style="margin:0 0 10px;font-size:25px;font-weight:700;color:${EMAIL_BRAND.text};">
              Your sign-in code
            </h1>
            <p style="margin:0 0 10px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">
              Enter the code below to complete your sign-in.<br> Code expires in 3 minutes.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 0 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
              <tr>
                <td align="center" bgcolor="${EMAIL_BRAND.accent}"
                    style="background-color:${EMAIL_BRAND.accent};color:${EMAIL_BRAND.onAccent};
                           font-family:${EMAIL_BRAND.mono};font-size:25px;line-height:1;
                           font-weight:800;letter-spacing:6px;padding:16px 24px 12px 30px;
                           border-radius:12px;-webkit-user-select:all;user-select:all;">
                  ${escapeHtml(code)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 16px;font-size:14px;line-height:1.5;color:${EMAIL_BRAND.muted};">
            If you didn't request this code,
            you can safely ignore this email.
          </td>
        </tr>
      </table>
    `,
  });

  return { subject: "Your sign-in code", text, html };
}