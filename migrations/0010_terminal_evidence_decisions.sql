CREATE TABLE terminal_evidence_decisions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 8 AND 200 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_record_key TEXT NOT NULL CHECK (length(trim(source_record_key)) > 0),
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  source_content_hash TEXT NOT NULL CHECK (
    length(source_content_hash) = 64 AND
    source_content_hash = lower(source_content_hash) AND
    source_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  product_id TEXT NOT NULL REFERENCES products(id),
  field_family TEXT NOT NULL CHECK (field_family IN ('nutrition', 'ingredients')),
  outcome TEXT NOT NULL CHECK (outcome IN ('not_declared', 'not_applicable')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('source', 'label')),
  label_asset_id TEXT REFERENCES label_evidence_assets(id),
  label_content_sha256 TEXT CHECK (
    label_content_sha256 IS NULL OR (
      length(label_content_sha256) = 64 AND
      label_content_sha256 = lower(label_content_sha256) AND
      label_content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 3 AND 2000),
  decided_by TEXT NOT NULL CHECK (length(trim(decided_by)) BETWEEN 1 AND 512),
  decided_at TEXT NOT NULL CHECK (length(trim(decided_at)) > 0),
  supersedes_decision_id TEXT UNIQUE REFERENCES terminal_evidence_decisions(id),
  CHECK (supersedes_decision_id IS NULL OR supersedes_decision_id <> id),
  CHECK (
    (evidence_kind = 'source' AND label_asset_id IS NULL AND label_content_sha256 IS NULL) OR
    (evidence_kind = 'label' AND label_asset_id IS NOT NULL AND label_content_sha256 IS NOT NULL)
  )
);

CREATE INDEX idx_terminal_evidence_decisions_current
  ON terminal_evidence_decisions(product_id, field_family, decided_at DESC, id);

CREATE INDEX idx_terminal_evidence_decisions_source_binding
  ON terminal_evidence_decisions(
    source_record_id,
    source_content_hash,
    product_id,
    field_family
  );

CREATE INDEX idx_terminal_evidence_decisions_label_binding
  ON terminal_evidence_decisions(label_asset_id, label_content_sha256)
  WHERE label_asset_id IS NOT NULL;

CREATE VIEW current_label_evidence_assets AS
SELECT id, subject_source_record_id, subject_source_content_hash, product_id,
  field_family, source_image_id, source_image_revision, requested_url,
  effective_url, content_sha256, byte_length, media_type, fetched_at
FROM (
  SELECT asset.*,
    ROW_NUMBER() OVER (
      PARTITION BY asset.subject_source_record_id,
        asset.subject_source_content_hash,
        asset.field_family,
        asset.source_image_id,
        COALESCE(asset.source_image_revision, '')
      ORDER BY asset.fetched_at DESC, asset.id DESC
    ) AS current_rank
  FROM label_evidence_assets asset
)
WHERE current_rank = 1;

CREATE TRIGGER terminal_evidence_decisions_binding_insert
BEFORE INSERT ON terminal_evidence_decisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM source_records source_record
    WHERE source_record.id = NEW.source_record_id
      AND source_record.source_id = NEW.source_id
      AND source_record.source_record_id = NEW.source_record_key
      AND source_record.content_hash = NEW.source_content_hash
      AND source_record.product_id = NEW.product_id
      AND (NEW.evidence_kind <> 'source' OR source_record.source_url LIKE 'https://%')
  ) THEN RAISE(ABORT, 'terminal evidence source binding mismatch') END;

  SELECT CASE WHEN NEW.evidence_kind = 'label' AND NOT EXISTS (
    SELECT 1
    FROM current_label_evidence_assets asset
    WHERE asset.id = NEW.label_asset_id
      AND asset.subject_source_record_id = NEW.source_record_id
      AND asset.subject_source_content_hash = NEW.source_content_hash
      AND asset.product_id = NEW.product_id
      AND asset.field_family = NEW.field_family
      AND asset.content_sha256 = NEW.label_content_sha256
  ) THEN RAISE(ABORT, 'terminal evidence label binding mismatch') END;
END;

CREATE TRIGGER terminal_evidence_decisions_replay_collision
BEFORE INSERT ON terminal_evidence_decisions
WHEN EXISTS (
  SELECT 1
  FROM terminal_evidence_decisions existing
  WHERE existing.id = NEW.id AND (
    existing.idempotency_key IS NOT NEW.idempotency_key OR
    existing.source_id IS NOT NEW.source_id OR
    existing.source_record_key IS NOT NEW.source_record_key OR
    existing.source_record_id IS NOT NEW.source_record_id OR
    existing.source_content_hash IS NOT NEW.source_content_hash OR
    existing.product_id IS NOT NEW.product_id OR
    existing.field_family IS NOT NEW.field_family OR
    existing.outcome IS NOT NEW.outcome OR
    existing.evidence_kind IS NOT NEW.evidence_kind OR
    existing.label_asset_id IS NOT NEW.label_asset_id OR
    existing.label_content_sha256 IS NOT NEW.label_content_sha256 OR
    existing.rationale IS NOT NEW.rationale OR
    existing.decided_by IS NOT NEW.decided_by OR
    existing.supersedes_decision_id IS NOT NEW.supersedes_decision_id
  )
) OR EXISTS (
  SELECT 1
  FROM terminal_evidence_decisions existing
  WHERE existing.idempotency_key = NEW.idempotency_key AND (
    existing.source_id IS NOT NEW.source_id OR
    existing.source_record_key IS NOT NEW.source_record_key OR
    existing.source_record_id IS NOT NEW.source_record_id OR
    existing.source_content_hash IS NOT NEW.source_content_hash OR
    existing.product_id IS NOT NEW.product_id OR
    existing.field_family IS NOT NEW.field_family OR
    existing.outcome IS NOT NEW.outcome OR
    existing.evidence_kind IS NOT NEW.evidence_kind OR
    existing.label_asset_id IS NOT NEW.label_asset_id OR
    existing.label_content_sha256 IS NOT NEW.label_content_sha256 OR
    existing.rationale IS NOT NEW.rationale OR
    existing.decided_by IS NOT NEW.decided_by OR
    existing.supersedes_decision_id IS NOT NEW.supersedes_decision_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'terminal evidence decision replay collision');
END;

CREATE TRIGGER terminal_evidence_decisions_requires_supersession
BEFORE INSERT ON terminal_evidence_decisions
WHEN NEW.supersedes_decision_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM terminal_evidence_decisions existing
    WHERE existing.source_id = NEW.source_id
      AND existing.source_record_key = NEW.source_record_key
      AND existing.source_record_id = NEW.source_record_id
      AND existing.source_content_hash = NEW.source_content_hash
      AND existing.product_id = NEW.product_id
      AND existing.field_family = NEW.field_family
      AND existing.evidence_kind = NEW.evidence_kind
      AND existing.label_asset_id IS NEW.label_asset_id
      AND existing.label_content_sha256 IS NEW.label_content_sha256
      AND NOT EXISTS (
        SELECT 1 FROM terminal_evidence_decisions child
        WHERE child.supersedes_decision_id = existing.id
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM terminal_evidence_decisions replay
    WHERE replay.idempotency_key = NEW.idempotency_key
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal evidence correction requires explicit supersession');
END;

CREATE TRIGGER terminal_evidence_decisions_supersession_insert
BEFORE INSERT ON terminal_evidence_decisions
WHEN NEW.supersedes_decision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM terminal_evidence_decisions previous
    WHERE previous.id = NEW.supersedes_decision_id
      AND previous.source_id = NEW.source_id
      AND previous.source_record_key = NEW.source_record_key
      AND previous.source_record_id = NEW.source_record_id
      AND previous.source_content_hash = NEW.source_content_hash
      AND previous.product_id = NEW.product_id
      AND previous.field_family = NEW.field_family
      AND previous.evidence_kind = NEW.evidence_kind
      AND previous.label_asset_id IS NEW.label_asset_id
      AND previous.label_content_sha256 IS NEW.label_content_sha256
  ) THEN RAISE(ABORT, 'terminal evidence supersession lineage mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM terminal_evidence_decisions child
    WHERE child.supersedes_decision_id = NEW.supersedes_decision_id
  ) THEN RAISE(ABORT, 'terminal evidence decision already superseded') END;
END;

CREATE TRIGGER terminal_evidence_decisions_no_update
BEFORE UPDATE ON terminal_evidence_decisions
BEGIN
  SELECT RAISE(ABORT, 'terminal evidence decisions are immutable');
END;

CREATE TRIGGER terminal_evidence_decisions_no_delete
BEFORE DELETE ON terminal_evidence_decisions
BEGIN
  SELECT RAISE(ABORT, 'terminal evidence decisions are immutable');
END;

CREATE VIEW current_terminal_evidence_decisions AS
SELECT decision.id,
  decision.idempotency_key,
  decision.source_id,
  decision.source_record_key,
  decision.source_record_id,
  decision.source_content_hash,
  decision.product_id,
  decision.field_family,
  decision.outcome,
  decision.evidence_kind,
  decision.label_asset_id,
  decision.label_content_sha256,
  decision.rationale,
  decision.decided_by,
  decision.decided_at,
  decision.supersedes_decision_id,
  source_record.source_url,
  source_record.observed_at AS source_observed_at,
  CASE decision.field_family
    WHEN 'nutrition' THEN source.nutrition_authority
    ELSE source.ingredient_authority
  END AS source_authority,
  CASE decision.evidence_kind
    WHEN 'label' THEN label.effective_url
    ELSE source_record.source_url
  END AS evidence_url
FROM terminal_evidence_decisions decision
JOIN source_records source_record
  ON source_record.id = decision.source_record_id
 AND source_record.source_id = decision.source_id
 AND source_record.source_record_id = decision.source_record_key
 AND source_record.content_hash = decision.source_content_hash
 AND source_record.product_id = decision.product_id
JOIN sources source ON source.id = decision.source_id
LEFT JOIN terminal_evidence_decisions child
  ON child.supersedes_decision_id = decision.id
LEFT JOIN current_label_evidence_assets label
  ON decision.evidence_kind = 'label'
 AND label.id = decision.label_asset_id
 AND label.subject_source_record_id = decision.source_record_id
 AND label.subject_source_content_hash = decision.source_content_hash
 AND label.product_id = decision.product_id
 AND label.field_family = decision.field_family
 AND label.content_sha256 = decision.label_content_sha256
WHERE child.id IS NULL
  AND (
    (decision.evidence_kind = 'source' AND source_record.source_url LIKE 'https://%') OR
    (decision.evidence_kind = 'label' AND label.id IS NOT NULL)
  );

CREATE VIEW terminal_evidence_projection_candidates AS
SELECT current.*,
  ROW_NUMBER() OVER (
    PARTITION BY current.product_id, current.field_family
    ORDER BY current.source_authority DESC, current.decided_at DESC, current.id DESC
  ) AS projection_rank
FROM current_terminal_evidence_decisions current
WHERE NOT EXISTS (
    SELECT 1
    FROM current_terminal_evidence_decisions disagreement
    WHERE disagreement.product_id = current.product_id
      AND disagreement.field_family = current.field_family
      AND disagreement.outcome <> current.outcome
  )
  AND NOT EXISTS (
    SELECT 1 FROM nutrition_facts fact
    WHERE current.field_family = 'nutrition'
      AND fact.product_id = current.product_id
      AND fact.status IN ('verified', 'conflict')
  )
  AND NOT EXISTS (
    SELECT 1 FROM ingredient_statements fact
    WHERE current.field_family = 'ingredients'
      AND fact.product_id = current.product_id
      AND fact.status IN ('verified', 'conflict')
  );

CREATE TRIGGER terminal_evidence_decisions_project_insert
AFTER INSERT ON terminal_evidence_decisions
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id
    AND field_family = NEW.field_family
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';

  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = NEW.product_id
    AND field_family = NEW.field_family
    AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome,
    source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at,
    decided_by = excluded.decided_by,
    notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_source_reconcile_update
AFTER UPDATE OF source_id, source_record_id, product_id, content_hash, source_url
ON source_records
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND field_family IN ('nutrition', 'ingredients')
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';

  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome,
    source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at,
    decided_by = excluded.decided_by,
    notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_label_reconcile_insert
AFTER INSERT ON label_evidence_assets
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id
    AND field_family = NEW.field_family
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';

  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = NEW.product_id
    AND field_family = NEW.field_family
    AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome,
    source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at,
    decided_by = excluded.decided_by,
    notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_nutrition_reconcile_insert
AFTER INSERT ON nutrition_facts
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id AND field_family = 'nutrition'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = NEW.product_id AND field_family = 'nutrition' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_nutrition_reconcile_update
AFTER UPDATE ON nutrition_facts
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id IN (OLD.product_id, NEW.product_id) AND field_family = 'nutrition'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND field_family = 'nutrition' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_nutrition_reconcile_delete
AFTER DELETE ON nutrition_facts
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = OLD.product_id AND field_family = 'nutrition'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = OLD.product_id AND field_family = 'nutrition' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_ingredients_reconcile_insert
AFTER INSERT ON ingredient_statements
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id AND field_family = 'ingredients'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = NEW.product_id AND field_family = 'ingredients' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_ingredients_reconcile_update
AFTER UPDATE ON ingredient_statements
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id IN (OLD.product_id, NEW.product_id) AND field_family = 'ingredients'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND field_family = 'ingredients' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;

CREATE TRIGGER terminal_evidence_ingredients_reconcile_delete
AFTER DELETE ON ingredient_statements
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = OLD.product_id AND field_family = 'ingredients'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
  INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url,
     observed_at, verified_at, decided_by, notes)
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = OLD.product_id AND field_family = 'ingredients' AND projection_rank = 1
  ON CONFLICT(product_id, field_family) DO UPDATE SET
    outcome = excluded.outcome, source_record_id = excluded.source_record_id,
    evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
    verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes
  WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');
END;
