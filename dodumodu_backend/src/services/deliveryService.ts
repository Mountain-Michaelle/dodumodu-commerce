import { isStateInList } from "./nigeriaStates";

// Africa/Lagos is a fixed UTC+1 offset, no DST — safe to hardcode the +1 hour.
export type DeliveryDateChoice = "today" | "tomorrow" | "next_tomorrow";

// "Free" here means "we pay the rider". Every other state is waybill (the
// customer pays the rider on arrival) — which is why COD in a waybill state is
// perfectly normal, and why who may *choose* COD is a separate question,
// answered by codPolicyService.ts.
const FREE_DELIVERY_STATES = ["Lagos", "Ogun"];

export const deliveryService = {
  /** Exposed for page copy / admin hints. This list remains the authority. */
  freeDeliveryStates(): string[] {
    return [...FREE_DELIVERY_STATES];
  },

  getDeliveryOptions(nowUtc: Date = new Date()): DeliveryDateChoice[] {
    const watHour = (nowUtc.getUTCHours() + 1) % 24;
    if (watHour < 15) {
      return ["today", "tomorrow", "next_tomorrow"];
    }
    return ["tomorrow", "next_tomorrow"]; // 'today' never appears after 3pm WAT
  },

  validateSubmittedDate(
    nowUtc: Date,
    submittedDate: DeliveryDateChoice,
  ): { accepted: true; flaggedLate: boolean } {
    const options = this.getDeliveryOptions(nowUtc);
    if (submittedDate === "today" && !options.includes("today")) {
      return { accepted: true, flaggedLate: true }; // never reject, just flag
    }
    return { accepted: true, flaggedLate: false };
  },

  // Matched the same way the COD gate matches states: "lagos", "Lagos State" and
  // " lagos " are all Lagos. A false negative here silently bills a customer in
  // a free-delivery state for waybill, and the page copy promises free delivery.
  getDeliveryFee(state: string): "free" | "waybill" {
    return isStateInList(state, FREE_DELIVERY_STATES) ? "free" : "waybill";
  },
};

