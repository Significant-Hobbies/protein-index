CREATE TABLE evidence_decisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_record_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  source_content_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64),
  field_family TEXT NOT NULL CHECK (field_family = 'nutrition'),
  decision TEXT NOT NULL CHECK (decision IN ('verify', 'reject')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  evidence_url TEXT NOT NULL CHECK (evidence_url LIKE 'https://%'),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) >= 3),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE UNIQUE INDEX idx_evidence_decisions_active_candidate
  ON evidence_decisions(source_id, source_record_key, candidate_hash, field_family)
  WHERE active = 1;

CREATE INDEX idx_evidence_decisions_replay
  ON evidence_decisions(source_id, source_record_key, source_content_hash, candidate_hash, active);

CREATE INDEX idx_evidence_decisions_product
  ON evidence_decisions(product_id, field_family, active);
