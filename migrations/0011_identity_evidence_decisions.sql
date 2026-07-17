CREATE TABLE identity_evidence_decisions (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 28 AND
    substr(id, 1, 4) = 'ied_' AND
    substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_record_key TEXT NOT NULL CHECK (
    length(trim(source_record_key)) BETWEEN 1 AND 512
  ),
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  identity_hash TEXT NOT NULL CHECK (
    length(identity_hash) = 64 AND
    identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_url TEXT NOT NULL CHECK (
    length(evidence_url) BETWEEN 9 AND 2048 AND
    evidence_url LIKE 'https://%'
  ),
  source_observed_at TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (
    length(trim(rationale)) BETWEEN 3 AND 2000
  ),
  decided_by TEXT NOT NULL CHECK (
    length(trim(decided_by)) BETWEEN 1 AND 200
  ),
  decided_at TEXT NOT NULL,
  UNIQUE (product_id, source_record_id, identity_hash)
);

CREATE INDEX idx_identity_evidence_decisions_replay
  ON identity_evidence_decisions(
    source_id,
    source_record_key,
    identity_hash,
    source_record_id,
    product_id
  );

CREATE INDEX idx_identity_evidence_decisions_product
  ON identity_evidence_decisions(product_id, decided_at DESC, id DESC);

CREATE TRIGGER identity_evidence_decisions_validate_insert
BEFORE INSERT ON identity_evidence_decisions
WHEN
  length(NEW.id) <> 28 OR
  substr(NEW.id, 1, 4) <> 'ied_' OR
  substr(NEW.id, 5) GLOB '*[^0-9a-f]*' OR
  length(trim(NEW.source_record_key)) NOT BETWEEN 1 AND 512 OR
  length(NEW.identity_hash) <> 64 OR
  NEW.identity_hash GLOB '*[^0-9a-f]*' OR
  length(NEW.evidence_url) NOT BETWEEN 9 AND 2048 OR
  substr(NEW.evidence_url, 1, 8) <> 'https://' OR
  length(trim(NEW.rationale)) NOT BETWEEN 3 AND 2000 OR
  length(trim(NEW.decided_by)) NOT BETWEEN 1 AND 200
BEGIN
  SELECT RAISE(ABORT, 'identity evidence decision is malformed');
END;

CREATE TRIGGER identity_evidence_decisions_current_binding_insert
BEFORE INSERT ON identity_evidence_decisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM source_records record
    JOIN products product ON product.id = NEW.product_id
    WHERE record.id = NEW.source_record_id
      AND record.source_id = NEW.source_id
      AND record.source_record_id = NEW.source_record_key
      AND record.product_id = NEW.product_id
      AND record.identity_hash = NEW.identity_hash
      AND record.observed_at = NEW.source_observed_at
      AND product.is_active = 1
  ) THEN RAISE(ABORT, 'identity evidence current source binding mismatch') END;
END;

CREATE TRIGGER identity_evidence_decisions_replay_collision
BEFORE INSERT ON identity_evidence_decisions
WHEN EXISTS (
  SELECT 1
  FROM identity_evidence_decisions existing
  WHERE (
    existing.id = NEW.id OR
    (
      existing.product_id = NEW.product_id AND
      existing.source_record_id = NEW.source_record_id AND
      existing.identity_hash = NEW.identity_hash
    )
  ) AND (
    existing.id IS NOT NEW.id OR
    existing.product_id IS NOT NEW.product_id OR
    existing.source_id IS NOT NEW.source_id OR
    existing.source_record_key IS NOT NEW.source_record_key OR
    existing.source_record_id IS NOT NEW.source_record_id OR
    existing.identity_hash IS NOT NEW.identity_hash OR
    existing.evidence_url IS NOT NEW.evidence_url OR
    existing.rationale IS NOT NEW.rationale OR
    existing.decided_by IS NOT NEW.decided_by
  )
)
BEGIN
  SELECT RAISE(ABORT, 'identity evidence decision conflict');
END;

CREATE TRIGGER identity_evidence_decisions_no_update
BEFORE UPDATE ON identity_evidence_decisions
BEGIN
  SELECT RAISE(ABORT, 'identity evidence decisions are immutable');
END;

CREATE TRIGGER identity_evidence_decisions_no_delete
BEFORE DELETE ON identity_evidence_decisions
BEGIN
  SELECT RAISE(ABORT, 'identity evidence decisions are immutable');
END;
