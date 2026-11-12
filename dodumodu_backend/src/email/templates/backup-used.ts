export interface BackupUsedData {
  remaining: number;
}

export function backupUsedTemplate(data: BackupUsedData): { subject: string; text: string } {
  const { remaining } = data;
  const text = `One of your backup codes was just used to sign in. You have ${remaining} left. If this wasn't you, reset your authenticator now.`;
  return { subject: "A backup code was used", text };
}