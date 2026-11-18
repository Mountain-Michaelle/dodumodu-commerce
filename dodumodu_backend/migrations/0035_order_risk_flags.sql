-- Internal risk classification of an order. NEVER shown to customers and never a reason to refuse an order: an order is
-- always stored, and these columns only tell the person reviewing it what to look at.
--
--   risk_flags      'unverified_burst'  many orders without a verified bot check from one address in an hour
--                   'probable_duplicate' looks like a repeat of an open order (see src/abuse/duplicateOrders.ts)
--                   'bot_check_failed'  Cloudflare refused the token the page sent
--   duplicate_refs  the earlier orders a probable duplicate resembles:
--                   [{ "id": 12, "reference": "ddmd-...", "reason": "same_number_and_name", "minutesApart": 4 }]
--
-- bot_check (0033) additionally gains the value 'failed'; it is plain text, so no change is needed there.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS duplicate_refs jsonb;
