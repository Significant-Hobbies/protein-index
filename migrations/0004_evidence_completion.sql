CREATE TABLE evidence_outcomes (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field_family TEXT NOT NULL CHECK (field_family IN ('identity', 'nutrition', 'ingredients')),
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'not_applicable', 'not_declared')),
  source_record_id TEXT REFERENCES source_records(id),
  evidence_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  notes TEXT NOT NULL,
  PRIMARY KEY (product_id, field_family)
);

CREATE INDEX idx_evidence_outcomes_completion
  ON evidence_outcomes(field_family, outcome, product_id);
