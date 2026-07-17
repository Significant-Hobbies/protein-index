CREATE VIEW current_identity_evidence_decisions AS
SELECT decision.*
FROM identity_evidence_decisions decision
JOIN source_records record ON record.id = decision.source_record_id
  AND record.source_id = decision.source_id
  AND record.source_record_id = decision.source_record_key
  AND record.product_id = decision.product_id
  AND record.identity_hash = decision.identity_hash
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
AFTER UPDATE OF source_id, source_record_id, product_id, source_url, content_hash, identity_hash
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

CREATE TRIGGER identity_evidence_label_reconcile_insert
AFTER INSERT ON label_evidence_assets
BEGIN
  DELETE FROM evidence_outcomes
  WHERE field_family = 'identity' AND product_id IN (
    SELECT NEW.product_id
    UNION SELECT record.product_id
      FROM source_records record
      WHERE record.id = NEW.subject_source_record_id AND record.product_id IS NOT NULL
    UNION SELECT decision.product_id
      FROM identity_evidence_decisions decision
      WHERE decision.source_record_id = NEW.subject_source_record_id
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
      SELECT NEW.product_id
      UNION SELECT record.product_id
        FROM source_records record
        WHERE record.id = NEW.subject_source_record_id AND record.product_id IS NOT NULL
      UNION SELECT historical.product_id
        FROM identity_evidence_decisions historical
        WHERE historical.source_record_id = NEW.subject_source_record_id
    )
  )
  WHERE decision_rank = 1;
END;
