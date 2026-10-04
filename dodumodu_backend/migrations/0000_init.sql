CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,              -- kobo
  package_options JSONB NOT NULL DEFAULT '[]',
  seo_title TEXT,
  seo_description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  r2_key TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE testimonials (
  id SERIAL PRIMARY KEY,
  r2_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TYPE delivery_fee_type AS ENUM ('free', 'waybill');
CREATE TYPE delivery_date_choice AS ENUM ('today', 'tomorrow', 'next_tomorrow');
CREATE TYPE payment_method AS ENUM ('pay_now', 'cod');
CREATE TYPE order_status AS ENUM ('awaiting_payment', 'paid', 'failed', 'confirmed_cod', 'delivered');

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  address TEXT NOT NULL,
  state TEXT NOT NULL,
  delivery_fee_type delivery_fee_type NOT NULL,
  delivery_date delivery_date_choice NOT NULL,
  flagged_late BOOLEAN NOT NULL DEFAULT false,
  question_notes TEXT,
  payment_method payment_method NOT NULL,
  amount INTEGER NOT NULL,             -- kobo, snapshot at order time
  currency TEXT NOT NULL DEFAULT 'NGN',
  reference TEXT UNIQUE NOT NULL,
  status order_status NOT NULL DEFAULT 'awaiting_payment',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT NOT NULL,            -- 'webhook' | 'reconcile' | 'admin:<email>' | 'system'
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Helpful indexes for the lookups the app actually does.
CREATE INDEX idx_orders_status_created_at ON orders (status, created_at);
CREATE INDEX idx_orders_phone_address_product ON orders (phone, address, product_id, created_at);
CREATE INDEX idx_product_images_product_id ON product_images (product_id, display_order);
