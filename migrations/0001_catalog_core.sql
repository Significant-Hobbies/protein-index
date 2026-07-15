PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('official', 'brand', 'open_data', 'retailer', 'label', 'fixture')),
  identity_authority INTEGER NOT NULL CHECK (identity_authority BETWEEN 0 AND 100),
  nutrition_authority INTEGER NOT NULL CHECK (nutrition_authority BETWEEN 0 AND 100),
  ingredient_authority INTEGER NOT NULL CHECK (ingredient_authority BETWEEN 0 AND 100),
  license_url TEXT,
  retention_notes TEXT NOT NULL,
  credential_requirement TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  adapter_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sample', 'production')),
  input_identifier TEXT NOT NULL,
  input_hash TEXT,
  input_bytes INTEGER,
  advertised_total INTEGER,
  records_read INTEGER NOT NULL DEFAULT 0,
  india_records INTEGER NOT NULL DEFAULT 0,
  staged_records INTEGER NOT NULL DEFAULT 0,
  invalid_records INTEGER NOT NULL DEFAULT 0,
  duplicate_records INTEGER NOT NULL DEFAULT 0,
  terminal_evidence TEXT CHECK (terminal_evidence IN ('end_of_file', 'limit', 'error')),
  source_complete INTEGER NOT NULL DEFAULT 0 CHECK (source_complete IN (0, 1)),
  market_complete INTEGER NOT NULL DEFAULT 0 CHECK (market_complete = 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_summary TEXT,
  manifest_json TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  product_kind TEXT NOT NULL DEFAULT 'retail_packaged',
  gtin TEXT UNIQUE CHECK (gtin IS NULL OR length(gtin) = 14),
  brand TEXT NOT NULL,
  brand_normalized TEXT NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  flavour TEXT,
  flavour_normalized TEXT,
  category TEXT NOT NULL,
  category_raw TEXT,
  net_quantity_grams REAL CHECK (net_quantity_grams IS NULL OR net_quantity_grams > 0),
  serving_size_grams REAL CHECK (serving_size_grams IS NULL OR serving_size_grams > 0),
  image_url TEXT,
  nutrition_image_url TEXT,
  ingredient_image_url TEXT,
  marketed_protein INTEGER CHECK (marketed_protein IS NULL OR marketed_protein IN (0, 1)),
  marketed_reasons_json TEXT NOT NULL DEFAULT '[]',
  nutritionally_protein_dense INTEGER CHECK (nutritionally_protein_dense IS NULL OR nutritionally_protein_dense IN (0, 1)),
  nutrition_reasons_json TEXT NOT NULL DEFAULT '[]',
  classifier_version TEXT NOT NULL,
  completeness INTEGER NOT NULL DEFAULT 0 CHECK (completeness BETWEEN 0 AND 100),
  completeness_missing_json TEXT NOT NULL DEFAULT '[]',
  identity_authority INTEGER NOT NULL DEFAULT 0 CHECK (identity_authority BETWEEN 0 AND 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_record_id TEXT NOT NULL,
  product_id TEXT REFERENCES products(id),
  source_url TEXT,
  content_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  first_seen_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  last_seen_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  raw_evidence_json TEXT NOT NULL,
  resolution_rule TEXT,
  UNIQUE (source_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS nutrition_facts (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id),
  status TEXT NOT NULL CHECK (status IN ('missing', 'unverified', 'verified', 'conflict')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  authority INTEGER NOT NULL DEFAULT 0 CHECK (authority BETWEEN 0 AND 100),
  basis TEXT NOT NULL CHECK (basis IN ('per_100g', 'per_100ml', 'per_serving', 'unknown')),
  preparation_state TEXT NOT NULL CHECK (preparation_state IN ('as_sold', 'prepared', 'unknown')),
  calories REAL CHECK (calories IS NULL OR calories >= 0),
  protein_grams REAL CHECK (protein_grams IS NULL OR protein_grams BETWEEN 0 AND 100),
  carbohydrate_grams REAL CHECK (carbohydrate_grams IS NULL OR carbohydrate_grams BETWEEN 0 AND 100),
  sugar_grams REAL CHECK (sugar_grams IS NULL OR sugar_grams BETWEEN 0 AND 100),
  fat_grams REAL CHECK (fat_grams IS NULL OR fat_grams BETWEEN 0 AND 100),
  saturated_fat_grams REAL CHECK (saturated_fat_grams IS NULL OR saturated_fat_grams BETWEEN 0 AND 100),
  fibre_grams REAL CHECK (fibre_grams IS NULL OR fibre_grams BETWEEN 0 AND 100),
  sodium_mg REAL CHECK (sodium_mg IS NULL OR sodium_mg >= 0),
  label_verified_at TEXT,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nutrient_values (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  nutrient_code TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  basis TEXT NOT NULL,
  preparation_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified', 'verified', 'conflict')),
  observed_at TEXT NOT NULL,
  UNIQUE (source_record_id, nutrient_code, basis, preparation_state)
);

CREATE TABLE IF NOT EXISTS ingredient_statements (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id),
  raw_text TEXT,
  language TEXT,
  status TEXT NOT NULL CHECK (status IN ('missing', 'unverified', 'verified', 'conflict')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  authority INTEGER NOT NULL DEFAULT 0 CHECK (authority BETWEEN 0 AND 100),
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_ingredients (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  parent_id TEXT REFERENCES product_ingredients(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  raw_text TEXT NOT NULL,
  normalized_name TEXT,
  percentage REAL CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
  resolved INTEGER NOT NULL DEFAULT 1 CHECK (resolved IN (0, 1)),
  UNIQUE (source_record_id, parent_id, position)
);

CREATE TABLE IF NOT EXISTS product_allergens (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  declaration TEXT NOT NULL CHECK (declaration IN ('contains', 'may_contain', 'source_tag')),
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  PRIMARY KEY (product_id, name, declaration, source_record_id)
);

CREATE TABLE IF NOT EXISTS product_additives (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  PRIMARY KEY (product_id, identifier, source_record_id)
);

CREATE TABLE IF NOT EXISTS field_observations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  field_path TEXT NOT NULL,
  raw_value_json TEXT NOT NULL,
  normalized_value_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  authority INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 100),
  observed_at TEXT NOT NULL,
  evidence_url TEXT,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  value_hash TEXT NOT NULL,
  UNIQUE (source_record_id, field_path, value_hash)
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id),
  retailer TEXT NOT NULL,
  retailer_listing_id TEXT NOT NULL,
  pincode TEXT,
  seller TEXT,
  mrp REAL CHECK (mrp IS NULL OR mrp >= 0),
  selling_price REAL NOT NULL CHECK (selling_price >= 0),
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (retailer, retailer_listing_id, pincode, seller, observed_at)
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id),
  retailer TEXT NOT NULL,
  retailer_listing_id TEXT NOT NULL,
  stars REAL NOT NULL CHECK (stars BETWEEN 0 AND 5),
  rating_count INTEGER NOT NULL CHECK (rating_count >= 0),
  review_count INTEGER CHECK (review_count IS NULL OR review_count >= 0),
  observed_at TEXT NOT NULL,
  UNIQUE (retailer, retailer_listing_id, observed_at)
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('identity', 'invalid_gtin', 'nutrition_validation', 'nutrition_conflict', 'ingredient_conflict', 'coverage_gap')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  source_record_id TEXT REFERENCES source_records(id),
  product_id TEXT REFERENCES products(id),
  candidate_product_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL,
  decision TEXT,
  decision_rationale TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_search ON products(brand_normalized, name_normalized);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category, nutritionally_protein_dense, marketed_protein);
CREATE INDEX IF NOT EXISTS idx_products_verification ON nutrition_facts(status, product_id);
CREATE INDEX IF NOT EXISTS idx_source_records_hash ON source_records(source_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source ON ingestion_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_product_field ON field_observations(product_id, field_path, selected);
CREATE INDEX IF NOT EXISTS idx_offers_product_time ON offers(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ratings_product_time ON ratings(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_open ON review_items(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_ingredients_product_position ON product_ingredients(product_id, parent_id, position);
