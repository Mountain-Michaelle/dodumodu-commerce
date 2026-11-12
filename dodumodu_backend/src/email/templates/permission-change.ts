export interface PermissionChangeData {
  perm: string;
  granted: boolean;
}

export function permissionChangeTemplate(data: PermissionChangeData): { subject: string; text: string } {
  const { perm, granted } = data;
  const subject = granted ? "A permission was granted" : "A permission was removed";
  const text = `Your "${perm}" permission was ${granted ? "granted" : "removed"}.`;
  return { subject, text };
}