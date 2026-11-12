import { EMAIL_BRAND } from "../brand";
import { emailLayout, escapeHtml } from "../layout";

export interface LoginCodeData {
  code: string;
}

/** GitHub-inspired OTP email body: clear heading, orange code block for easy
 * one-time select and copy, brand colors, no scripts. Code is plain text so it
 * remains readable and copyable even when CSS is stripped. */
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
            <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${EMAIL_BRAND.muted};">
              Enter the code below to complete your sign-in.<br \> It expires in 3 minutes.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 0 24px;">
            <div style="display:inline-block;background:${EMAIL_BRAND.accent};color:#F7A21B;
                font-size:32px;font-weight:800;letter-spacing:6px;
                padding:5px 30px;border-radius:12px;font-family:monospace;
                ${EMAIL_BRAND.font};">
              ${escapeHtml(code)}
            </div>
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