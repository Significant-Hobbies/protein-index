CREATE TRIGGER terminal_evidence_decisions_authoritative_source_insert
BEFORE INSERT ON terminal_evidence_decisions
WHEN NEW.evidence_kind = 'source'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM source_records record
    JOIN sources source ON source.id = record.source_id
    WHERE record.id = NEW.source_record_id
      AND record.source_id = NEW.source_id
      AND record.source_record_id = NEW.source_record_key
      AND record.content_hash = NEW.source_content_hash
      AND record.product_id = NEW.product_id
      AND record.source_url LIKE 'https://%'
      AND source.kind IN ('official', 'brand')
      AND CASE NEW.field_family
        WHEN 'nutrition' THEN source.nutrition_authority
        ELSE source.ingredient_authority
      END = 100
  ) THEN RAISE(ABORT, 'terminal source evidence is not authoritative') END;
END;

DROP VIEW terminal_evidence_projection_candidates;
DROP VIEW current_terminal_evidence_decisions;

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
    (
      decision.evidence_kind = 'source'
      AND source_record.source_url LIKE 'https://%'
      AND source.kind IN ('official', 'brand')
      AND CASE decision.field_family
        WHEN 'nutrition' THEN source.nutrition_authority
        ELSE source.ingredient_authority
      END = 100
    ) OR
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

DELETE FROM evidence_outcomes
WHERE outcome IN ('not_declared', 'not_applicable')
  AND decided_by = 'terminal_evidence_projection';

INSERT INTO evidence_outcomes (
  product_id, field_family, outcome, source_record_id, evidence_url,
  observed_at, verified_at, decided_by, notes
)
SELECT product_id, field_family, outcome, source_record_id, evidence_url,
  source_observed_at, decided_at, 'terminal_evidence_projection',
  'terminal_evidence_decision:' || id
FROM terminal_evidence_projection_candidates
WHERE projection_rank = 1
ON CONFLICT(product_id, field_family) DO UPDATE SET
  outcome = excluded.outcome,
  source_record_id = excluded.source_record_id,
  evidence_url = excluded.evidence_url,
  observed_at = excluded.observed_at,
  verified_at = excluded.verified_at,
  decided_by = excluded.decided_by,
  notes = excluded.notes
WHERE evidence_outcomes.outcome IN ('not_declared', 'not_applicable');

CREATE VIEW current_exact_verified_evidence_decisions AS
SELECT decision.*
FROM evidence_decisions decision
JOIN extraction_attempts attempt
  ON attempt.id = decision.extraction_attempt_id
 AND attempt.is_current = 1
 AND attempt.product_id = decision.product_id
 AND attempt.field_family = decision.field_family
JOIN source_records subject
  ON subject.id = attempt.subject_source_record_id
 AND subject.product_id = attempt.product_id
 AND subject.content_hash = attempt.subject_source_content_hash
JOIN extraction_attempt_labels attempt_label
  ON attempt_label.attempt_id = attempt.id
 AND attempt_label.label_asset_id = decision.label_asset_id
 AND attempt_label.outcome = 'candidate'
JOIN current_label_evidence_assets label
  ON label.id = attempt_label.label_asset_id
 AND label.subject_source_record_id = attempt.subject_source_record_id
 AND label.subject_source_content_hash = attempt.subject_source_content_hash
 AND label.product_id = attempt.product_id
 AND label.field_family = attempt.field_family
JOIN source_records derived
  ON derived.id = decision.source_record_id
 AND derived.source_id = decision.source_id
 AND derived.source_record_id = decision.source_record_key
 AND derived.product_id = decision.product_id
 AND derived.content_hash = decision.source_content_hash
WHERE decision.active = 1
  AND decision.decision = 'verify'
  AND decision.extraction_attempt_id IS NOT NULL
  AND decision.label_asset_id IS NOT NULL
  AND json_extract(derived.raw_evidence_json, '$.extractionAttemptId') = attempt.id
  AND json_extract(derived.raw_evidence_json, '$.labelAssetId') = label.id
  AND json_extract(derived.raw_evidence_json, '$.labelContentSha256') = label.content_sha256
  AND json_extract(derived.raw_evidence_json, '$.candidateHash') = decision.candidate_hash
  AND decision.evidence_url IN (label.requested_url, label.effective_url)
  AND EXISTS (
    SELECT 1 FROM json_each(attempt_label.candidate_hashes_json)
    WHERE value = decision.candidate_hash
  );

DROP TRIGGER identity_evidence_source_reconcile_update;
DROP VIEW current_identity_evidence_decisions;

CREATE VIEW current_identity_evidence_decisions AS
SELECT decision.*
FROM identity_evidence_decisions decision
JOIN source_records record ON record.id = decision.source_record_id
  AND record.source_id = decision.source_id
  AND record.source_record_id = decision.source_record_key
  AND record.product_id = decision.product_id
  AND record.identity_hash = decision.identity_hash
  AND record.observed_at = decision.source_observed_at
JOIN products product ON product.id = decision.product_id AND product.is_active = 1
WHERE record.source_url = decision.evidence_url OR EXISTS (
  SELECT 1
  FROM current_label_evidence_assets label
  WHERE label.subject_source_record_id = record.id
    AND label.subject_source_content_hash = record.content_hash
    AND decision.evidence_url IN (label.requested_url, label.effective_url)
);

DELETE FROM evidence_outcomes WHERE field_family = 'identity';

INSERT INTO evidence_outcomes (
  product_id, field_family, outcome, source_record_id, evidence_url,
  observed_at, verified_at, decided_by, notes
)
SELECT product_id, 'identity', 'verified', source_record_id, evidence_url,
  source_observed_at, decided_at, decided_by, rationale
FROM (
  SELECT decision.*,
    ROW_NUMBER() OVER (
      PARTITION BY decision.product_id
      ORDER BY decision.decided_at DESC, decision.id DESC
    ) AS decision_rank
  FROM current_identity_evidence_decisions decision
)
WHERE decision_rank = 1;

CREATE TRIGGER identity_evidence_source_reconcile_update
AFTER UPDATE OF source_id, source_record_id, product_id, source_url, content_hash,
  identity_hash, observed_at
ON source_records
BEGIN
  DELETE FROM evidence_outcomes
  WHERE field_family = 'identity'
    AND product_id IN (
      SELECT OLD.product_id
      UNION SELECT NEW.product_id
      UNION SELECT decision.product_id
        FROM identity_evidence_decisions decision
        WHERE decision.source_record_id IN (OLD.id, NEW.id)
    );

  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, 'identity', 'verified', source_record_id, evidence_url,
    source_observed_at, decided_at, decided_by, rationale
  FROM (
    SELECT decision.*,
      ROW_NUMBER() OVER (
        PARTITION BY decision.product_id
        ORDER BY decision.decided_at DESC, decision.id DESC
      ) AS decision_rank
    FROM current_identity_evidence_decisions decision
    WHERE decision.product_id IN (
      SELECT OLD.product_id
      UNION SELECT NEW.product_id
      UNION SELECT historical.product_id
        FROM identity_evidence_decisions historical
        WHERE historical.source_record_id IN (OLD.id, NEW.id)
    )
  )
  WHERE decision_rank = 1;
END;

CREATE TRIGGER terminal_evidence_source_authority_reconcile_update
AFTER UPDATE OF kind, nutrition_authority, ingredient_authority ON sources
BEGIN
  DELETE FROM evidence_outcomes
  WHERE outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection'
    AND product_id IN (
      SELECT decision.product_id
      FROM terminal_evidence_decisions decision
      WHERE decision.source_id = NEW.id
    );

  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id IN (
      SELECT decision.product_id
      FROM terminal_evidence_decisions decision
      WHERE decision.source_id = NEW.id
    )
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

CREATE INDEX idx_nutrition_facts_status_authority_product
  ON nutrition_facts(status, authority, product_id);

CREATE INDEX idx_ingredient_statements_status_authority_product
  ON ingredient_statements(status, authority, product_id);

CREATE VIEW strict_trusted_products AS
SELECT product.id
FROM products product
JOIN nutrition_facts nutrition ON nutrition.product_id = product.id
LEFT JOIN ingredient_statements ingredients ON ingredients.product_id = product.id
WHERE product.is_active = 1
  AND nutrition.status = 'verified'
  AND nutrition.authority = 100
  AND EXISTS (
    SELECT 1
    FROM current_identity_evidence_decisions identity_decision
    JOIN evidence_outcomes identity_outcome
      ON identity_outcome.product_id = identity_decision.product_id
     AND identity_outcome.field_family = 'identity'
     AND identity_outcome.outcome = 'verified'
     AND identity_outcome.source_record_id = identity_decision.source_record_id
     AND identity_outcome.evidence_url = identity_decision.evidence_url
     AND identity_outcome.observed_at = identity_decision.source_observed_at
     AND identity_outcome.verified_at = identity_decision.decided_at
     AND identity_outcome.decided_by = identity_decision.decided_by
     AND identity_outcome.notes = identity_decision.rationale
    WHERE identity_decision.product_id = product.id
  )
  AND (
    EXISTS (
      SELECT 1 FROM current_exact_verified_evidence_decisions decision
      WHERE decision.product_id = product.id
        AND decision.field_family = 'nutrition'
        AND decision.source_record_id = nutrition.source_record_id
    ) OR EXISTS (
      SELECT 1
      FROM source_records record
      JOIN sources source ON source.id = record.source_id
      WHERE record.id = nutrition.source_record_id
        AND record.product_id = product.id
        AND record.observed_at = nutrition.observed_at
        AND source.kind IN ('official', 'brand')
        AND source.nutrition_authority = 100
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM terminal_evidence_decisions decision
    WHERE decision.product_id = product.id AND decision.field_family = 'nutrition'
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence_outcomes outcome
    WHERE outcome.product_id = product.id
      AND outcome.field_family = 'nutrition'
      AND outcome.outcome IN ('not_declared', 'not_applicable')
  )
  AND NOT EXISTS (
    SELECT 1 FROM extraction_attempts attempt
    WHERE attempt.product_id = product.id
      AND attempt.field_family = 'nutrition'
      AND attempt.is_current = 1
      AND attempt.conflict_count > 0
  )
  AND (
    (
      ingredients.status = 'verified'
      AND ingredients.authority = 100
      AND (
        EXISTS (
          SELECT 1 FROM current_exact_verified_evidence_decisions decision
          WHERE decision.product_id = product.id
            AND decision.field_family = 'ingredients'
            AND decision.source_record_id = ingredients.source_record_id
        ) OR EXISTS (
          SELECT 1
          FROM source_records record
          JOIN sources source ON source.id = record.source_id
          WHERE record.id = ingredients.source_record_id
            AND record.product_id = product.id
            AND record.observed_at = ingredients.observed_at
            AND source.kind IN ('official', 'brand')
            AND source.ingredient_authority = 100
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM terminal_evidence_decisions decision
        WHERE decision.product_id = product.id AND decision.field_family = 'ingredients'
      )
      AND NOT EXISTS (
        SELECT 1 FROM evidence_outcomes outcome
        WHERE outcome.product_id = product.id
          AND outcome.field_family = 'ingredients'
          AND outcome.outcome IN ('not_declared', 'not_applicable')
      )
    ) OR (
      COALESCE(ingredients.status, '') <> 'conflict'
      AND NOT EXISTS (
        SELECT 1 FROM ingredient_statements fact
        WHERE fact.product_id = product.id AND fact.status = 'verified'
      )
      AND EXISTS (
        SELECT 1
        FROM current_terminal_evidence_decisions decision
        WHERE decision.product_id = product.id
          AND decision.field_family = 'ingredients'
        GROUP BY decision.product_id
        HAVING COUNT(DISTINCT decision.outcome) = 1
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM extraction_attempts attempt
    WHERE attempt.product_id = product.id
      AND attempt.field_family = 'ingredients'
      AND attempt.is_current = 1
      AND attempt.conflict_count > 0
  );
