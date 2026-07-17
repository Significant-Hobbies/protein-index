DROP VIEW current_label_evidence_assets;

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
        asset.source_image_id
      ORDER BY asset.fetched_at DESC, asset.id DESC
    ) AS current_rank
  FROM label_evidence_assets asset
)
WHERE current_rank = 1;

DELETE FROM evidence_outcomes
WHERE field_family IN ('nutrition', 'ingredients')
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
