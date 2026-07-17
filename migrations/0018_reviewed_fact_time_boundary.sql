DROP VIEW current_verified_nutrition_facts;
DROP VIEW current_verified_ingredient_statements;
DROP VIEW current_verified_fact_evidence_candidates;

-- Reviewed label decisions bind to exact retained bytes and the current derived
-- source record. The fact timestamp describes the extracted candidate and does
-- not have to equal the parent source observation timestamp. Official and brand
-- facts remain bound to the exact current source observation.
CREATE VIEW current_verified_fact_evidence_candidates AS
SELECT fact.product_id, 'nutrition' AS field_family, decision.source_record_id,
  fact.observed_at, decision.evidence_url, 'label' AS evidence_kind,
  decision.decided_at AS evidence_at, decision.id AS evidence_id, 2 AS evidence_rank
FROM nutrition_facts fact
JOIN current_exact_verified_evidence_decisions decision
  ON decision.product_id = fact.product_id
 AND decision.field_family = 'nutrition'
 AND decision.source_record_id = fact.source_record_id
JOIN source_records record
  ON record.id = decision.source_record_id
 AND record.product_id = fact.product_id
WHERE fact.status = 'verified' AND fact.authority = 100
UNION ALL
SELECT fact.product_id, 'nutrition', record.id, record.observed_at, record.source_url,
  'source', record.observed_at, record.id, 1
FROM nutrition_facts fact
JOIN source_records record
  ON record.id = fact.source_record_id
 AND record.product_id = fact.product_id
 AND record.observed_at = fact.observed_at
JOIN sources source
  ON source.id = record.source_id
 AND source.kind IN ('official', 'brand')
 AND source.nutrition_authority = 100
WHERE fact.status = 'verified' AND fact.authority = 100
  AND record.source_url LIKE 'https://%'
UNION ALL
SELECT fact.product_id, 'ingredients', decision.source_record_id,
  fact.observed_at, decision.evidence_url, 'label',
  decision.decided_at, decision.id, 2
FROM ingredient_statements fact
JOIN current_exact_verified_evidence_decisions decision
  ON decision.product_id = fact.product_id
 AND decision.field_family = 'ingredients'
 AND decision.source_record_id = fact.source_record_id
JOIN source_records record
  ON record.id = decision.source_record_id
 AND record.product_id = fact.product_id
WHERE fact.status = 'verified' AND fact.authority = 100
UNION ALL
SELECT fact.product_id, 'ingredients', record.id, record.observed_at, record.source_url,
  'source', record.observed_at, record.id, 1
FROM ingredient_statements fact
JOIN source_records record
  ON record.id = fact.source_record_id
 AND record.product_id = fact.product_id
 AND record.observed_at = fact.observed_at
JOIN sources source
  ON source.id = record.source_id
 AND source.kind IN ('official', 'brand')
 AND source.ingredient_authority = 100
WHERE fact.status = 'verified' AND fact.authority = 100
  AND record.source_url LIKE 'https://%';

CREATE VIEW current_verified_nutrition_facts AS
SELECT fact.*, evidence.evidence_url, evidence.evidence_kind
FROM nutrition_facts fact
JOIN (
  SELECT product_id, source_record_id, observed_at, evidence_url, evidence_kind,
    ROW_NUMBER() OVER (
      PARTITION BY product_id
      ORDER BY evidence_rank DESC, evidence_at DESC, evidence_id DESC
    ) AS current_rank
  FROM current_verified_fact_evidence_candidates
  WHERE field_family = 'nutrition'
) evidence
  ON evidence.product_id = fact.product_id
 AND evidence.source_record_id = fact.source_record_id
 AND evidence.observed_at = fact.observed_at
 AND evidence.current_rank = 1;

CREATE VIEW current_verified_ingredient_statements AS
SELECT fact.*, evidence.evidence_url, evidence.evidence_kind
FROM ingredient_statements fact
JOIN (
  SELECT product_id, source_record_id, observed_at, evidence_url, evidence_kind,
    ROW_NUMBER() OVER (
      PARTITION BY product_id
      ORDER BY evidence_rank DESC, evidence_at DESC, evidence_id DESC
    ) AS current_rank
  FROM current_verified_fact_evidence_candidates
  WHERE field_family = 'ingredients'
) evidence
  ON evidence.product_id = fact.product_id
 AND evidence.source_record_id = fact.source_record_id
 AND evidence.observed_at = fact.observed_at
 AND evidence.current_rank = 1;
