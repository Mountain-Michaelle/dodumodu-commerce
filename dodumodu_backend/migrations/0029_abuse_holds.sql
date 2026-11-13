-- Spam holds and rotating-phone-flood (RPF) suspects. Additive: two new tables and one nullable column.
--
-- held_orders  : an order that a verified-spam rule kept OUT of `orders`. The customer was shown the normal thank-you
--                page; the full payload is kept here (and emailed) so a wrongly held order can be released with one
--                click. Nothing here is a block - only a person blocks.
-- abuse_alerts : a suspected rotating-phone flood. The orders themselves ARE stored; the alert tells an admin that
--                one device or address is placing orders under many different phones, with what is needed to block it.
-- orders.abuse_tag : 'rpf_suspect' on orders that belong to an open alert, so the orders list can be filtered by it.

CREATE TABLE IF NOT EXISTS held_orders (
  id               bigserial PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,
  reference        text NOT NULL,
  phone_norm       text,
  phone            text NOT NULL,
  customer_name    text NOT NULL,
  address          text NOT NULL,
  ip               text,
  device_id        text,
  client_kind      text,
  browser          text,
  reason           text NOT NULL,
  payload          jsonb NOT NULL,
  emailed          boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'dismissed')),
  released_order_id integer,
  resolved_by      text,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS held_orders_phone_idx   ON held_orders (phone_norm, created_at DESC);
CREATE INDEX IF NOT EXISTS held_orders_status_idx  ON held_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS abuse_alerts (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL DEFAULT 'rpf_suspect' CHECK (kind IN ('rpf_suspect')),
  subject_scope    text NOT NULL CHECK (subject_scope IN ('ip', 'device')),
  subject_value    text NOT NULL,
  ip               text,
  device_id        text,
  client_kind      text,
  browser          text,
  distinct_phones  integer NOT NULL,
  order_count      integer NOT NULL,
  order_ids        integer[] NOT NULL DEFAULT '{}',
  window_minutes   integer NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked', 'dismissed')),
  emailed          boolean NOT NULL DEFAULT false,
  resolved_by      text,
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- One OPEN alert per subject: new evidence updates it instead of raising a second alarm.
CREATE UNIQUE INDEX IF NOT EXISTS abuse_alerts_open_subject_uq
  ON abuse_alerts (subject_scope, subject_value) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS abuse_alerts_status_idx ON abuse_alerts (status, created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS abuse_tag text;
CREATE INDEX IF NOT EXISTS orders_abuse_tag_idx ON orders (abuse_tag) WHERE abuse_tag IS NOT NULL;
