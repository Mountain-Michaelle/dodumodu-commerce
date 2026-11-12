export type DeviceEventKind = "invited" | "registered";

export interface DeviceEventData {
  kind: DeviceEventKind;
}

export function deviceEventTemplate(data: DeviceEventData): { subject: string; text: string } {
  const { kind } = data;
  const subject = kind === "invited" ? "A new device was invited" : "A new device was registered";
  const text =
    kind === "invited"
      ? "A trusted-device invite was created for your admin account. It works once and expires in 15 minutes."
      : "A new trusted device was just registered for your admin account. If this wasn't you, revoke it now.";
  return { subject, text };
}