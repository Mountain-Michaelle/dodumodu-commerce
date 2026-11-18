// Probable-duplicate detection. A PURE function of facts, so every case that must not touch a real customer is a unit test.
//
// It only ever LABELS an order for a person to look at. It cannot refuse, hold or alter anything: a customer who really does
// want a second order (a gift, a top-up, a repeat purchase) must never be inconvenienced by it, so it is deliberately narrow:
//
//   * only orders for the SAME product,
//   * only orders still OPEN (not delivered, cancelled or failed): a customer buying again after a delivery is a repeat
//     purchase, which is the business working, not a duplicate,
//   * only orders from the last 24 hours,
//   * and the two orders must share who they are (the same phone/WhatsApp number, or the same name AND address) or arrive
//     within minutes of each other from the same number (a double tap, a reload, a second device).
import { normalizePhone } from "../shared/normalizePhone";

export const DUPLICATE_WINDOW_MS = 24 * 3_600_000;
export const DOUBLE_SUBMIT_MS = 15 * 60_000;
const MAX_REFS = 5;
const CLOSED_STATUSES = new Set(["delivered", "cancelled", "failed"]);

export interface NewOrderFacts {
  productId: number;
  phone: string;
  whatsapp: string;
  customerName: string;
  address: string;
  createdAt: Date;
}

export interface CandidateOrder {
  id: number;
  reference: string;
  productId: number;
  phone: string;
  whatsapp: string;
  customerName: string;
  address: string;
  status: string;
  createdAt: Date;
}

export type DuplicateReason = "same_number_within_minutes" | "same_number_and_name" | "same_number_and_address" | "same_name_and_address";
export interface DuplicateRef { id: number; reference: string; reason: DuplicateReason; minutesApart: number }

const words = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const numbersOf = (phone: string, whatsapp: string): Set<string> => {
  const out = new Set<string>();
  for (const raw of [phone, whatsapp]) {
    const n = normalizePhone(raw);
    if (n) out.add(n);
  }
  return out;
};

export function findDuplicates(order: NewOrderFacts, candidates: CandidateOrder[]): DuplicateRef[] {
  const mine = numbersOf(order.phone, order.whatsapp);
  const name = words(order.customerName);
  const address = words(order.address);
  const refs: DuplicateRef[] = [];

  for (const c of candidates) {
    if (c.productId !== order.productId) continue;
    if (CLOSED_STATUSES.has(c.status)) continue;
    const apartMs = order.createdAt.getTime() - c.createdAt.getTime();
    if (apartMs < 0 || apartMs > DUPLICATE_WINDOW_MS) continue;

    const theirs = numbersOf(c.phone, c.whatsapp);
    const sameNumber = [...mine].some((n) => theirs.has(n));
    const sameName = name !== "" && name === words(c.customerName);
    const sameAddress = address !== "" && address === words(c.address);

    let reason: DuplicateReason | null = null;
    if (sameNumber && sameName) reason = "same_number_and_name";
    else if (sameNumber && sameAddress) reason = "same_number_and_address";
    else if (sameNumber && apartMs <= DOUBLE_SUBMIT_MS) reason = "same_number_within_minutes";
    else if (!sameNumber && sameName && sameAddress) reason = "same_name_and_address";
    if (!reason) continue;
    refs.push({ id: c.id, reference: c.reference, reason, minutesApart: Math.round(apartMs / 60_000) });
  }
  // Most recent first, and bounded: a flag is a pointer for a human, not an export.
  return refs.sort((a, b) => a.minutesApart - b.minutesApart).slice(0, MAX_REFS);
}
