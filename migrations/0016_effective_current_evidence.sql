CREATE VIEW current_verified_nutrition_facts AS
SELECT fact.*,
  COALESCE(
    (
      SELECT decision.evidence_url
      FROM current_exact_verified_evidence_decisions decision
      JOIN source_records record ON record.id = decision.source_record_id
      WHERE decision.product_id = fact.product_id
        AND decision.field_family = 'nutrition'
        AND decision.source_record_id = fact.source_record_id
        AND record.product_id = fact.product_id
      ORDER BY decision.decided_at DESC, decision.id DESC
      LIMIT 1
    ),
    (
      SELECT record.source_url
      FROM source_records record
      JOIN sources source ON source.id = record.source_id
      WHERE record.id = fact.source_record_id
        AND record.product_id = fact.product_id
        AND record.observed_at = fact.observed_at
        AND record.source_url LIKE 'https://%'
        AND source.kind IN ('official', 'brand')
        AND source.nutrition_authority = 100
      LIMIT 1
    )
  ) AS evidence_url,
  CASE WHEN EXISTS (
    SELECT 1
    FROM current_exact_verified_evidence_decisions decision
    JOIN source_records record ON record.id = decision.source_record_id
    WHERE decision.product_id = fact.product_id
      AND decision.field_family = 'nutrition'
      AND decision.source_record_id = fact.source_record_id
      AND record.product_id = fact.product_id
  ) THEN 'label' ELSE 'source' END AS evidence_kind
FROM nutrition_facts fact
WHERE fact.status = 'verified'
  AND fact.authority = 100
  AND (
    EXISTS (
      SELECT 1
      FROM current_exact_verified_evidence_decisions decision
      JOIN source_records record ON record.id = decision.source_record_id
      WHERE decision.product_id = fact.product_id
        AND decision.field_family = 'nutrition'
        AND decision.source_record_id = fact.source_record_id
        AND record.product_id = fact.product_id
    ) OR EXISTS (
      SELECT 1
      FROM source_records record
      JOIN sources source ON source.id = record.source_id
      WHERE record.id = fact.source_record_id
        AND record.product_id = fact.product_id
        AND record.observed_at = fact.observed_at
        AND record.source_url LIKE 'https://%'
        AND source.kind IN ('official', 'brand')
        AND source.nutrition_authority = 100
    )
  );

CREATE VIEW current_verified_ingredient_statements AS
SELECT fact.*,
  COALESCE(
    (
      SELECT decision.evidence_url
      FROM current_exact_verified_evidence_decisions decision
      JOIN source_records record ON record.id = decision.source_record_id
      WHERE decision.product_id = fact.product_id
        AND decision.field_family = 'ingredients'
        AND decision.source_record_id = fact.source_record_id
        AND record.product_id = fact.product_id
      ORDER BY decision.decided_at DESC, decision.id DESC
      LIMIT 1
    ),
    (
      SELECT record.source_url
      FROM source_records record
      JOIN sources source ON source.id = record.source_id
      WHERE record.id = fact.source_record_id
        AND record.product_id = fact.product_id
        AND record.observed_at = fact.observed_at
        AND record.source_url LIKE 'https://%'
        AND source.kind IN ('official', 'brand')
        AND source.ingredient_authority = 100
      LIMIT 1
    )
  ) AS evidence_url,
  CASE WHEN EXISTS (
    SELECT 1
    FROM current_exact_verified_evidence_decisions decision
    JOIN source_records record ON record.id = decision.source_record_id
    WHERE decision.product_id = fact.product_id
      AND decision.field_family = 'ingredients'
      AND decision.source_record_id = fact.source_record_id
      AND record.product_id = fact.product_id
  ) THEN 'label' ELSE 'source' END AS evidence_kind
FROM ingredient_statements fact
WHERE fact.status = 'verified'
  AND fact.authority = 100
  AND (
    EXISTS (
      SELECT 1
      FROM current_exact_verified_evidence_decisions decision
      JOIN source_records record ON record.id = decision.source_record_id
      WHERE decision.product_id = fact.product_id
        AND decision.field_family = 'ingredients'
        AND decision.source_record_id = fact.source_record_id
        AND record.product_id = fact.product_id
    ) OR EXISTS (
      SELECT 1
      FROM source_records record
      JOIN sources source ON source.id = record.source_id
      WHERE record.id = fact.source_record_id
        AND record.product_id = fact.product_id
        AND record.observed_at = fact.observed_at
        AND record.source_url LIKE 'https://%'
        AND source.kind IN ('official', 'brand')
        AND source.ingredient_authority = 100
    )
  );

DROP VIEW terminal_evidence_projection_candidates;

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
    WHERE current.field_family = 'nutrition' AND fact.product_id = current.product_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM ingredient_statements fact
    WHERE current.field_family = 'ingredients' AND fact.product_id = current.product_id
  );

CREATE TRIGGER terminal_evidence_nutrition_fact_insert
AFTER INSERT ON nutrition_facts
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id
    AND field_family = 'nutrition'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
END;

CREATE TRIGGER terminal_evidence_nutrition_fact_update
AFTER UPDATE ON nutrition_facts
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND field_family = 'nutrition'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
END;

CREATE TRIGGER terminal_evidence_nutrition_fact_delete
AFTER DELETE ON nutrition_facts
BEGIN
  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = OLD.product_id
    AND field_family = 'nutrition'
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

CREATE TRIGGER terminal_evidence_ingredient_fact_insert
AFTER INSERT ON ingredient_statements
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id = NEW.product_id
    AND field_family = 'ingredients'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
END;

CREATE TRIGGER terminal_evidence_ingredient_fact_update
AFTER UPDATE ON ingredient_statements
BEGIN
  DELETE FROM evidence_outcomes
  WHERE product_id IN (OLD.product_id, NEW.product_id)
    AND field_family = 'ingredients'
    AND outcome IN ('not_declared', 'not_applicable')
    AND decided_by = 'terminal_evidence_projection';
END;

CREATE TRIGGER terminal_evidence_ingredient_fact_delete
AFTER DELETE ON ingredient_statements
BEGIN
  INSERT INTO evidence_outcomes (
    product_id, field_family, outcome, source_record_id, evidence_url,
    observed_at, verified_at, decided_by, notes
  )
  SELECT product_id, field_family, outcome, source_record_id, evidence_url,
    source_observed_at, decided_at, 'terminal_evidence_projection',
    'terminal_evidence_decision:' || id
  FROM terminal_evidence_projection_candidates
  WHERE product_id = OLD.product_id
    AND field_family = 'ingredients'
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

DROP VIEW strict_trusted_products;

CREATE VIEW strict_trusted_products AS
SELECT product.id
FROM products product
JOIN current_verified_nutrition_facts nutrition ON nutrition.product_id = product.id
LEFT JOIN ingredient_statements raw_ingredients ON raw_ingredients.product_id = product.id
LEFT JOIN current_verified_ingredient_statements verified_ingredients
  ON verified_ingredients.product_id = product.id
WHERE product.is_active = 1
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
  AND NOT EXISTS (
    SELECT 1 FROM current_terminal_evidence_decisions decision
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
      verified_ingredients.product_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM current_terminal_evidence_decisions decision
        WHERE decision.product_id = product.id AND decision.field_family = 'ingredients'
      )
      AND NOT EXISTS (
        SELECT 1 FROM evidence_outcomes outcome
        WHERE outcome.product_id = product.id
          AND outcome.field_family = 'ingredients'
          AND outcome.outcome IN ('not_declared', 'not_applicable')
      )
    ) OR (
      raw_ingredients.product_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM current_terminal_evidence_decisions decision
        JOIN evidence_outcomes outcome
          ON outcome.product_id = decision.product_id
         AND outcome.field_family = decision.field_family
         AND outcome.outcome = decision.outcome
         AND outcome.source_record_id = decision.source_record_id
         AND outcome.evidence_url = decision.evidence_url
         AND outcome.observed_at = decision.source_observed_at
         AND outcome.verified_at = decision.decided_at
         AND outcome.decided_by = 'terminal_evidence_projection'
         AND outcome.notes = 'terminal_evidence_decision:' || decision.id
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
