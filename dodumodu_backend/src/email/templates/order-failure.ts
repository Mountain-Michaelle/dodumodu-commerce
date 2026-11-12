import { clean } from "../../services/orderBackupMailer";

export interface OrderFailureData {
  reason: string;
  detail: string;
  customerName: string | undefined;
  quantity: string | undefined;
  productId: string | undefined;
  state: string | undefined;
  idempotencyKey: string | undefined;
}

export function orderFailureTemplate(data: OrderFailureData): { subject: string; text: string; idempotencyKey: string } {
  const { reason, detail, customerName, quantity, productId, state, idempotencyKey: idempotencyKeyRaw } = data;
  const subject = `[ORDER NOT SAVED] ${clean(reason, 40)} · ${clean(customerName, 60)} · ${clean(quantity, 6)}x product ${clean(productId, 12)} · ${clean(state, 30)}`;
  const lines: string[] = [
    `customerName: ${clean(customerName, 1000)}`,
    `quantity: ${clean(quantity, 1000)}`,
    `productId: ${clean(productId, 1000)}`,
    `state: ${clean(state, 1000)}`,
    `receivedAt: ${new Date().toISOString()}`,
  ];
  const text = `An order was received but could NOT be saved. Contact the customer or enter it manually.\n\nreason: ${clean(reason, 80)}\nerror: ${clean(detail, 300)}\n\n${lines.join("\n")}\n`;
  const idempotencyKey = `order-failed:${clean(idempotencyKeyRaw, 100)}:${clean(reason, 30)}`;
  return { subject, text, idempotencyKey };
}