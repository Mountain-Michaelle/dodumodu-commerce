// Convenience layer only. The backend re-validates everything, including the
// same quantity bounds (§6 step 5) — this exists purely so the customer sees
// an error before a round trip.
const PHONE_RE = /^\+?[0-9]{10,14}$/;

export function validateOrderForm(formEl, { maxOrderQuantity, requirePackage }) {
  const errors = {};
  const get = (name) => formEl.elements[name]?.value?.trim() || "";

  if (get("customerName").length < 2) errors.customerName = "Enter your full name";
  if (!PHONE_RE.test(get("phone"))) errors.phone = "Enter a valid phone number";
  if (!PHONE_RE.test(get("whatsapp"))) errors.whatsapp = "Enter a valid WhatsApp number";
  if (get("address").length < 5) errors.address = "Enter your full delivery address";
  if (get("state").length < 2) errors.state = "Select your state";
  if (!get("deliveryDate")) errors.deliveryDate = "Choose a delivery date";
  if (requirePackage && !get("packageId")) errors.packageId = "Choose a package";
  if (!get("paymentMethod")) errors.paymentMethod = "Choose a payment method";

  const quantity = parseInt(get("quantity"), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxOrderQuantity) {
    errors.quantity = `Enter a quantity between 1 and ${maxOrderQuantity}`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function collectOrderPayload(formEl, productId) {
  const get = (name) => formEl.elements[name]?.value?.trim();
  const packageId = get("packageId");
  return {
    productId,
    packageId: packageId || undefined,
    quantity: parseInt(get("quantity"), 10),
    customerName: get("customerName"),
    phone: get("phone"),
    whatsapp: get("whatsapp"),
    address: get("address"),
    state: get("state"),
    deliveryDate: get("deliveryDate"),
    paymentMethod: get("paymentMethod"),
    questionNotes: get("questionNotes") || undefined,
  };
}
