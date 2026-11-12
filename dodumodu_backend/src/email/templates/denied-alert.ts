export function deniedAlertTemplate(): { subject: string; text: string } {
  const subject = "Sign-in attempt on an unrecognized device";
  const text = "Someone just tried to sign in to your admin account from a device we do not recognize. No code was sent. If this wasn't you, no action is needed.";
  return { subject, text };
}