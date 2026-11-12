import { clean } from "../../services/orderBackupMailer";

export interface OrderBackupData {
  customerName: string | undefined;
  quantity: string | undefined;
  productId: string | undefined;
  state: string | undefined;
  idempotencyKey: string | undefined;
}

export function orderBackupTemplate(data: OrderBackupData): { subject: string; text: string; idempotencyKey: string } {
  const { customerName, quantity, productId, state, idempotencyKey } = data;
  const subject = `[ORDER] ${clean(customerName, 60)} · ${clean(quantity, 6)}x product ${clean(productId, 12)} · ${clean(state, 30)}`;
  const lines: string[] = [
    `customerName: ${clean(customerName, 1000)}`,
    `quantity: ${clean(quantity, 1000)}`,
    `productId: ${clean(productId, 1000)}`,
    `state: ${clean(state, 1000)}`,
    `receivedAt: ${new Date().toISOString()}`,
  ];
  const text = `A new order reached the backend. Saved independently of the database.\n\n${lines.join("\n")}\n`;
  return { subject, text, idempotencyKey: `order-backup:${clean(idempotencyKey, 100)}` };
}

