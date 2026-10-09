// Which delivery dates the form offers. Same rule the backend applies when it
// quotes a dispatch window: after the 3pm WAT cutoff, "today" is gone.
//
// WAT is UTC+1 year-round (no DST), so adding 60 minutes to the UTC timestamp
// and reading back UTC parts is exact — no Intl timezone database, which older
// Android WebViews get wrong or lack data for.
const WAT_OFFSET_MINUTES = 60;
const CUTOFF_HOUR = 15;

const LABELS = { today: "Today", tomorrow: "Tomorrow", next_tomorrow: "Day after tomorrow" };

function watParts(date) {
  return new Date(date.getTime() + WAT_OFFSET_MINUTES * 60_000);
}

function sameDay(a, b) {
  const x = watParts(a);
  const y = watParts(b);
  return x.getUTCFullYear() === y.getUTCFullYear()
    && x.getUTCMonth() === y.getUTCMonth()
    && x.getUTCDate() === y.getUTCDate();
}

/** True when it is 15:00 WAT or later — same-day dispatch is off the table. */
export function isPastCutoff(now = new Date()) {
  return watParts(now).getUTCHours() >= CUTOFF_HOUR;
}

/**
 * The offered values, in the order they should appear. Empty string is never
 * returned; the caller keeps the "Select a date" placeholder in the markup.
 */
export function deliveryChoices(now = new Date()) {
  return isPastCutoff(now) ? ["tomorrow", "next_tomorrow"] : ["today", "tomorrow", "next_tomorrow"];
}

export function deliveryLabel(value) {
  return LABELS[value] || value;
}

/** Whether a stored (possibly stale, possibly restored-from-draft) value is still orderable. */
export function isDeliveryChoice(value, now = new Date()) {
  return deliveryChoices(now).includes(value);
}
