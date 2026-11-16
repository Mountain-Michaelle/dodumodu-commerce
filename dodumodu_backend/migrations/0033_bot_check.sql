-- Per-product bot check switch (live, read at request time: no rebuild) and the outcome recorded on each order.
-- orders.bot_check: 'verified' | 'missing' (no token arrived) | 'unverified' (token could not be checked: Cloudflare slow/down,
-- expired) | 'off' (the product has the check switched off). NULL = placed before this existed, or entered by hand.
ALTER TABLE products ADD COLUMN IF NOT EXISTS bot_check_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_check text;
CREATE INDEX IF NOT EXISTS orders_ip_botcheck_recent ON orders (created_from_ip, created_at) WHERE bot_check IN ('missing', 'unverified');
