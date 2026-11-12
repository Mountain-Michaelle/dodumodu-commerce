export interface NewNetworkData {
  country: string | null;
}

export function newNetworkTemplate(data: NewNetworkData): { subject: string; text: string } {
  const { country } = data;
  const subject = "Sign-in from a new network";
  const text = `Your admin account was just signed in from a new network${country ? ` (${country})` : ""}. Extra checks are on for this session.`;
  return { subject, text };
}