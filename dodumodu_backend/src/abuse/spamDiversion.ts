// Orchestration for the two order-abuse rules. Nothing here can refuse a customer:
//
//   * decideHold  - an unproven phone that has flooded the form (spamDetect.decideSpam) has this order HELD: kept out
//                   of `orders`, saved in held_orders and emailed to SPAM_ORDER_EMAIL, while the customer is shown the
//                   normal thank-you page. Every doubt resolves to "store it normally":
//                     - action off/shadow, phone not resolvable, any database error        -> stored
//                     - SPAM_ORDER_EMAIL or the mail provider not configured                -> stored
//                     - the announcement email reports a failure                            -> un-held, stored
//   * evaluateRpf - after an order is STORED, a device/address using many different untrusted phones raises an alert
//                   (email + in-app notification + 'rpf_suspect' tag). Orders are never touched beyond the tag.
//
// Blocking is a separate, human act (routes/admin/abuse.ts): admin role + authenticator step-up.
import type { Db } from "../db";
import type { Env } from "../env";
import type { OrderInput } from "../validation/orderSchema";
import { normalizePhone } from "../shared/normalizePhone";
import { generateReference, orderService, ProductNotFoundError, PackageNotFoundError, InvalidQuantityError } from "../services/orderService";
import { notificationService } from "../services/notificationService";
import { canAnnounceHeld, sendHeldOrderMail, sendRpfAlertMail } from "../email/senders/abuse-emails";
import { logError, logWarn } from "../shared/logger";
import { spamConfigFrom } from "./spamConfig";
import { decideSpam, decideRpf } from "./spamDetect";
import * as repo from "./holdRepo";

const ANNOUNCE_WAIT_MS = 3000;

export interface RequestMeta { ip: string | null; deviceId: string | null; clientKind: string | null; browser: string | null }

export type OrderView = Awaited<ReturnType<typeof orderService.previewOrder>>;
export type HoldOutcome = { hold: false } | { hold: true; held: repo.HeldRow; retry: boolean; view: OrderView };

const raw = (env: Env) => env as unknown as Record<string, string | undefined>;
const maskTail = (p: string) => (p.length > 4 ? `…${p.slice(-4)}` : "…");

export async function decideHold(db: Db, env: Env, input: OrderInput, meta: RequestMeta): Promise<HoldOutcome> {
  try {
    const cfg = spamConfigFrom(raw(env));
    if (cfg.action === "off") return { hold: false };

    // A retry of an order that was already held is answered the same way and never counted twice.
    const existing = await repo.findHeldByKey(db, input.idempotencyKey);
    if (existing) return { hold: true, held: existing, retry: true, view: await orderService.previewOrder(db, env, input) };

    const phoneNorm = normalizePhone(input.phone);
    if (!phoneNorm) return { hold: false };                       // cannot identify the customer: never judge them

    const facts = await repo.phoneFacts(db, cfg, { phoneNorm, customerName: input.customerName, address: input.address });
    const verdict = decideSpam(facts, cfg);
    if (!verdict.spam) return { hold: false };

    if (cfg.action === "shadow") {
      logWarn("spam_shadow_would_hold", { phone: maskTail(phoneNorm), prior: facts.prior, similar: facts.similar, burst: facts.burst, reason: verdict.reason ?? "" });
      return { hold: false };
    }
    if (!canAnnounceHeld(env)) {
      logWarn("spam_hold_skipped_unconfigured", { phone: maskTail(phoneNorm) });
      return { hold: false };
    }

    // Validate BEFORE holding anything: a request a stored order would have been refused for (unknown product, bad
    // package or quantity) is refused the same way and leaves no held row and no email behind.
    const view = await orderService.previewOrder(db, env, input);

    const { turnstileToken: _omit, ...payload } = input as OrderInput & { turnstileToken?: string };
    const held = await repo.insertHeld(db, {
      idempotencyKey: input.idempotencyKey, reference: generateReference(), phoneNorm, phone: input.phone,
      customerName: input.customerName, address: input.address, ip: meta.ip, deviceId: meta.deviceId,
      clientKind: meta.clientKind, browser: meta.browser, reason: verdict.reason ?? "repeated orders",
      payload: payload as Record<string, unknown>,
    });
    if (!held) {
      const again = await repo.findHeldByKey(db, input.idempotencyKey);          // lost a race with the same retry
      return again ? { hold: true, held: again, retry: true, view } : { hold: false };
    }

    // The announcement is what makes holding safe, so it is awaited (briefly). A reported failure un-holds the order;
    // a slow provider keeps it held - it is on the admin screen either way.
    const mail = await Promise.race([
      sendHeldOrderMail(env, held),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), ANNOUNCE_WAIT_MS)),
    ]);
    if (mail === "failed" || mail === "skipped") {
      await repo.deleteHeld(db, held.id).catch(() => undefined);
      logWarn("spam_hold_reverted_mail_failed", { heldId: held.id });
      return { hold: false };
    }
    if (mail === "sent") await repo.markHeldEmailed(db, held.id).catch(() => undefined);
    await notificationService.createForAdmins(db, {
      type: "spam_held", title: "Order held as spam",
      body: `${held.customer_name} - ${maskTail(held.phone)} - ${held.reason}. Review under Abuse & spam.`,
      href: "/abuse", dedupeKey: `held:${held.id}`,
    }).catch(() => undefined);
    return { hold: true, held, retry: false, view };
  } catch (err) {
    // A bad request is the caller's to hear about, exactly as for a stored order; every other fault fails open.
    if (err instanceof ProductNotFoundError || err instanceof PackageNotFoundError || err instanceof InvalidQuantityError) throw err;
    logError("spam_hold_failed_open", err);                       // any fault: the order is simply stored
    return { hold: false };
  }
}

/** After an order is stored. Never throws; callers run it in the background. */
export async function evaluateRpf(db: Db, env: Env, meta: RequestMeta): Promise<void> {
  try {
    const cfg = spamConfigFrom(raw(env));
    if (cfg.rpfMode === "off") return;
    const subjects: Array<{ scope: "ip" | "device"; value: string }> = [];
    if (meta.deviceId) subjects.push({ scope: "device", value: meta.deviceId });
    if (meta.ip) subjects.push({ scope: "ip", value: meta.ip });
    for (const s of subjects) {
      const facts = await repo.subjectFacts(db, cfg, s.scope, s.value);
      if (!decideRpf(s.scope, facts, cfg)) continue;
      const { row, created } = await repo.upsertOpenAlert(db, {
        scope: s.scope, value: s.value, ip: meta.ip, deviceId: meta.deviceId, clientKind: meta.clientKind, browser: meta.browser,
        phones: facts.untrustedPhones, orders: facts.orders, orderIds: facts.orderIds, windowMinutes: cfg.rpfWindowMinutes,
      });
      await repo.tagOrders(db, facts.orderIds, "rpf_suspect");
      if (!created) continue;                                    // already raised: numbers refreshed, nobody re-alarmed
      const mail = await sendRpfAlertMail(env, db, row);
      if (mail === "sent") await repo.markAlertEmailed(db, row.id).catch(() => undefined);
      await notificationService.createForAdmins(db, {
        type: "rpf_suspect", title: "RPF suspect",
        body: `${facts.untrustedPhones} phones from one ${s.scope === "ip" ? "address" : "device"} in ${cfg.rpfWindowMinutes} min. Review under Abuse & spam.`,
        href: "/abuse", dedupeKey: `rpf:${row.id}`,
      }).catch(() => undefined);
    }
  } catch (err) {
    logError("rpf_evaluate_failed", err);
  }
}
