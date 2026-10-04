// Remembers a half-filled order form so a dropped 4G connection or an
// accidental refresh doesn't cost the business a customer who was one field
// from the submit button.
//
// localStorage, not sessionStorage: the case this exists for is the tab being
// closed by the OS/browser when the phone runs out of memory, and the customer
// reopening the link later. Cleared on a confirmed order, and never used to
// pre-fill a *different* product page (the slug is part of the key).
const KEY_PREFIX = "skincare_order_draft:";
const STALE_MS = 1000 * 60 * 60 * 12; // a half-filled form older than 12h is a different shopping trip

// Only plain text the customer typed, and only the four identity/address fields
// the spec allows: name, phone, whatsapp, address. State, delivery date,
// quantity, payment method and notes always reset — a stale state would show
// the wrong pay-on-delivery option, a stale date may no longer be orderable,
// and a stale quantity would be a price promise the server doesn't keep.
const FIELDS = ["customerName", "phone", "whatsapp", "address"];

function storageAvailable() {
  try {
    const probe = `${KEY_PREFIX}__probe__`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false; // private mode / disabled storage: drafts are a nice-to-have
  }
}

export function saveDraft(formEl, slug) {
  if (!storageAvailable()) return;
  const draft = { savedAt: Date.now() };
  for (const name of FIELDS) {
    const value = formEl.elements[name]?.value;
    if (typeof value === "string" && value.trim()) draft[name] = value;
  }
  // State, quantity, delivery date, payment method, notes: deliberately never
  // stored — see FIELDS. Do not add them back here.
  try {
    window.localStorage.setItem(KEY_PREFIX + slug, JSON.stringify(draft));
  } catch {
    /* quota exceeded — a lost draft must never break checkout */
  }
}

export function loadDraft(slug) {
  if (!storageAvailable()) return null;
  let raw = null;
  try {
    raw = window.localStorage.getItem(KEY_PREFIX + slug);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== "object") return null;
    if (typeof draft.savedAt === "number" && Date.now() - draft.savedAt > STALE_MS) {
      clearDraft(slug);
      return null;
    }
    return draft;
  } catch {
    clearDraft(slug);
    return null;
  }
}

/**
 * Writes the draft back into the form. Returns how many fields were restored —
 * the caller only mentions the draft when it actually restored something, and
 * never overwrites a field the customer has already touched again.
 */
export function applyDraft(formEl, draft) {
  if (!draft) return 0;
  let restored = 0;
  for (const name of FIELDS) {
    const el = formEl.elements[name];
    if (!el || typeof draft[name] !== "string") continue;
    if (el.value) continue;
    el.value = draft[name];
    restored++;
  }
  return restored;
}

export function clearDraft(slug) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + slug);
  } catch {
    /* nothing to do */
  }
}
