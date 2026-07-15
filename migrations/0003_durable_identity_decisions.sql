ALTER TABLE products ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE source_records ADD COLUMN identity_hash TEXT;

CREATE TABLE identity_decisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_record_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  identity_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('match', 'create_new', 'no_match')),
  target_product_id TEXT REFERENCES products(id),
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (source_id, source_record_key, identity_hash)
);

CREATE INDEX idx_identity_decisions_lookup
  ON identity_decisions(source_id, source_record_key, identity_hash, active);
CREATE INDEX idx_products_active_search
  ON products(is_active, brand_normalized, name_normalized);
