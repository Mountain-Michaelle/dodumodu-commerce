CREATE TABLE visitor_analytics_meta (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  started_on DATE NOT NULL
);

INSERT INTO visitor_analytics_meta (id, started_on)
VALUES (1, (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Lagos')::date);

CREATE TABLE visitor_days (
  visit_date DATE NOT NULL,
  ip_hash TEXT NOT NULL,
  hash_version SMALLINT NOT NULL CHECK (hash_version > 0),
  country TEXT,
  region TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (visit_date, hash_version, ip_hash)
);

CREATE TABLE visitor_year_snapshots (
  year INTEGER PRIMARY KEY,
  unique_visitors INTEGER NOT NULL CHECK (unique_visitors >= 0),
  complete BOOLEAN NOT NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  taken_at TIMESTAMP NOT NULL
);
