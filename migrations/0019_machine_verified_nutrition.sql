CREATE TABLE machine_nutrition_verifications (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  subject_source_record_id TEXT NOT NULL REFERENCES source_records(id),
  subject_source_content_hash TEXT NOT NULL CHECK (length(subject_source_content_hash) = 64 AND subject_source_content_hash = lower(subject_source_content_hash) AND subject_source_content_hash NOT GLOB '*[^0-9a-f]*'),
  label_asset_id TEXT NOT NULL REFERENCES label_evidence_assets(id),
  label_content_sha256 TEXT NOT NULL CHECK (length(label_content_sha256) = 64 AND label_content_sha256 = lower(label_content_sha256) AND label_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_image_revision TEXT,
  basis TEXT NOT NULL CHECK (basis IN ('per_100g', 'per_100ml')),
  calories REAL NOT NULL CHECK (calories >= 0),
  protein_grams REAL NOT NULL CHECK (protein_grams >= 0),
  carbohydrate_grams REAL,
  sugar_grams REAL,
  fat_grams REAL,
  saturated_fat_grams REAL,
  fibre_grams REAL,
  sodium_mg REAL,
  ocr_engine TEXT NOT NULL CHECK (length(trim(ocr_engine)) > 0),
  ocr_version TEXT NOT NULL CHECK (length(trim(ocr_version)) > 0),
  ocr_output_sha256 TEXT NOT NULL CHECK (length(ocr_output_sha256) = 64 AND ocr_output_sha256 = lower(ocr_output_sha256) AND ocr_output_sha256 NOT GLOB '*[^0-9a-f]*'),
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  model_digest TEXT NOT NULL CHECK (length(model_digest) = 64 AND model_digest = lower(model_digest) AND model_digest NOT GLOB '*[^0-9a-f]*'),
  model_output_sha256 TEXT NOT NULL CHECK (length(model_output_sha256) = 64 AND model_output_sha256 = lower(model_output_sha256) AND model_output_sha256 NOT GLOB '*[^0-9a-f]*'),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 = lower(prompt_sha256) AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  normalizer_version TEXT NOT NULL CHECK (length(trim(normalizer_version)) > 0),
  normalized_result_sha256 TEXT NOT NULL CHECK (length(normalized_result_sha256) = 64 AND normalized_result_sha256 = lower(normalized_result_sha256) AND normalized_result_sha256 NOT GLOB '*[^0-9a-f]*'),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0),
  validation_report_sha256 TEXT NOT NULL CHECK (length(validation_report_sha256) = 64 AND validation_report_sha256 = lower(validation_report_sha256) AND validation_report_sha256 NOT GLOB '*[^0-9a-f]*'),
  release_manifest_sha256 TEXT NOT NULL CHECK (length(release_manifest_sha256) = 64 AND release_manifest_sha256 = lower(release_manifest_sha256) AND release_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  verified_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES machine_nutrition_verifications(id),
  UNIQUE(label_asset_id, normalized_result_sha256)
);

CREATE INDEX idx_machine_nutrition_product ON machine_nutrition_verifications(product_id, verified_at DESC);
CREATE INDEX idx_machine_nutrition_label ON machine_nutrition_verifications(label_asset_id);

CREATE TRIGGER machine_nutrition_verification_binding_insert
BEFORE INSERT ON machine_nutrition_verifications
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM label_evidence_assets asset
    WHERE asset.id = NEW.label_asset_id
      AND asset.product_id = NEW.product_id
      AND asset.field_family = 'nutrition'
      AND asset.subject_source_record_id = NEW.subject_source_record_id
      AND asset.subject_source_content_hash = NEW.subject_source_content_hash
      AND asset.content_sha256 = NEW.label_content_sha256
      AND asset.source_image_revision IS NEW.source_image_revision
  ) THEN RAISE(ABORT, 'machine nutrition label binding mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_records record
    WHERE record.id = NEW.subject_source_record_id
      AND record.product_id = NEW.product_id
      AND record.content_hash = NEW.subject_source_content_hash
  ) THEN RAISE(ABORT, 'machine nutrition source binding mismatch') END;
END;

CREATE TRIGGER machine_nutrition_verification_immutable_update
BEFORE UPDATE ON machine_nutrition_verifications
BEGIN SELECT RAISE(ABORT, 'machine nutrition verifications are immutable'); END;

CREATE TRIGGER machine_nutrition_verification_immutable_delete
BEFORE DELETE ON machine_nutrition_verifications
BEGIN SELECT RAISE(ABORT, 'machine nutrition verifications are immutable'); END;

CREATE VIEW current_machine_verified_nutrition_facts AS
SELECT verification.*,
  asset.effective_url AS evidence_url,
  'label' AS evidence_kind
FROM machine_nutrition_verifications verification
JOIN current_label_evidence_assets asset
  ON asset.id = verification.label_asset_id
 AND asset.product_id = verification.product_id
 AND asset.field_family = 'nutrition'
 AND asset.subject_source_record_id = verification.subject_source_record_id
 AND asset.subject_source_content_hash = verification.subject_source_content_hash
 AND asset.content_sha256 = verification.label_content_sha256
 AND asset.source_image_revision IS verification.source_image_revision
WHERE verification.superseded_by IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM machine_nutrition_verifications conflict
    JOIN current_label_evidence_assets conflict_asset ON conflict_asset.id = conflict.label_asset_id
      AND conflict_asset.content_sha256 = conflict.label_content_sha256
    WHERE conflict.product_id = verification.product_id
      AND conflict.superseded_by IS NULL
      AND conflict.id <> verification.id
      AND (conflict.calories IS NOT verification.calories
        OR conflict.protein_grams IS NOT verification.protein_grams
        OR conflict.basis IS NOT verification.basis)
  );
