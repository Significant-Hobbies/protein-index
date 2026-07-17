DROP TRIGGER identity_evidence_decisions_current_binding_insert;

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
      AND (
        record.source_url = NEW.evidence_url OR
        EXISTS (
          SELECT 1
          FROM current_label_evidence_assets label
          WHERE label.subject_source_record_id = record.id
            AND label.subject_source_content_hash = record.content_hash
            AND NEW.evidence_url IN (label.requested_url, label.effective_url)
        )
      )
  ) THEN RAISE(ABORT, 'identity evidence current source binding mismatch') END;
END;

DELETE FROM evidence_outcomes
WHERE field_family = 'identity'
  AND EXISTS (
    SELECT 1
    FROM identity_evidence_decisions decision
    JOIN source_records record ON record.id = decision.source_record_id
    WHERE decision.product_id = evidence_outcomes.product_id
      AND decision.source_record_id = evidence_outcomes.source_record_id
      AND decision.evidence_url = evidence_outcomes.evidence_url
      AND NOT (
        record.source_url = decision.evidence_url OR
        EXISTS (
          SELECT 1
          FROM current_label_evidence_assets label
          WHERE label.subject_source_record_id = record.id
            AND label.subject_source_content_hash = record.content_hash
            AND decision.evidence_url IN (label.requested_url, label.effective_url)
        )
      )
  );
