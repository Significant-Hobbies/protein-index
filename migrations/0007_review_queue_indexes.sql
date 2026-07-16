CREATE INDEX IF NOT EXISTS idx_review_status_type_priority
  ON review_items(status, type, priority DESC, created_at, id);

CREATE INDEX IF NOT EXISTS idx_source_records_product_source
  ON source_records(product_id, source_id);
