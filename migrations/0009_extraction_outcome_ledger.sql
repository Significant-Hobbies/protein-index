CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  field_family TEXT NOT NULL CHECK (field_family IN ('nutrition', 'ingredients')),
  request_schema_hash TEXT NOT NULL CHECK (
    length(request_schema_hash) = 64 AND
    request_schema_hash = lower(request_schema_hash) AND
    request_schema_hash NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_digest TEXT NOT NULL CHECK (
    length(artifact_digest) = 64 AND
    artifact_digest = lower(artifact_digest) AND
    artifact_digest NOT GLOB '*[^0-9a-f]*'
  ),
  adapter_version TEXT NOT NULL CHECK (length(trim(adapter_version)) > 0),
  model_name TEXT NOT NULL CHECK (length(trim(model_name)) > 0),
  model_version TEXT NOT NULL CHECK (length(trim(model_version)) > 0),
  parent_source_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  parent_source_input_hash TEXT NOT NULL CHECK (
    length(parent_source_input_hash) = 64 AND
    parent_source_input_hash = lower(parent_source_input_hash) AND
    parent_source_input_hash NOT GLOB '*[^0-9a-f]*'
  ),
  repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
  workflow TEXT NOT NULL CHECK (length(trim(workflow)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  head_sha TEXT NOT NULL CHECK (
    length(head_sha) = 40 AND
    head_sha = lower(head_sha) AND
    head_sha NOT GLOB '*[^0-9a-f]*'
  ),
  source_complete INTEGER NOT NULL CHECK (source_complete IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('diagnostic', 'accepted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  accepted_at TEXT,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  CHECK (
    (status = 'accepted' AND source_complete = 1 AND completed_at IS NOT NULL AND accepted_at IS NOT NULL) OR
    (status = 'diagnostic' AND accepted_at IS NULL)
  ),
  UNIQUE (ingestion_run_id, field_family, artifact_digest)
);

CREATE TABLE label_evidence_assets (
  id TEXT PRIMARY KEY,
  subject_source_record_id TEXT NOT NULL REFERENCES source_records(id),
  subject_source_content_hash TEXT NOT NULL CHECK (
    length(subject_source_content_hash) = 64 AND
    subject_source_content_hash = lower(subject_source_content_hash) AND
    subject_source_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  product_id TEXT NOT NULL REFERENCES products(id),
  field_family TEXT NOT NULL CHECK (field_family IN ('nutrition', 'ingredients')),
  source_image_id TEXT NOT NULL CHECK (length(trim(source_image_id)) > 0),
  source_image_revision TEXT,
  requested_url TEXT NOT NULL CHECK (requested_url LIKE 'https://%'),
  effective_url TEXT NOT NULL CHECK (effective_url LIKE 'https://%'),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND
    content_sha256 = lower(content_sha256) AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  media_type TEXT NOT NULL CHECK (media_type GLOB 'image/[a-z0-9]*'),
  fetched_at TEXT NOT NULL
);

CREATE TABLE extraction_attempts (
  id TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  subject_source_record_id TEXT NOT NULL REFERENCES source_records(id),
  subject_source_record_key TEXT NOT NULL CHECK (length(trim(subject_source_record_key)) > 0),
  subject_source_content_hash TEXT NOT NULL CHECK (
    length(subject_source_content_hash) = 64 AND
    subject_source_content_hash = lower(subject_source_content_hash) AND
    subject_source_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  product_id TEXT NOT NULL REFERENCES products(id),
  field_family TEXT NOT NULL CHECK (field_family IN ('nutrition', 'ingredients')),
  response_evidence_hash TEXT NOT NULL CHECK (
    length(response_evidence_hash) = 64 AND
    response_evidence_hash = lower(response_evidence_hash) AND
    response_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'no_prediction', 'rejected', 'failed')),
  prediction_count INTEGER NOT NULL CHECK (prediction_count >= 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  rejection_count INTEGER NOT NULL CHECK (rejection_count >= 0),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0 AND conflict_count <= candidate_count),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
  attempted_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  CHECK (rejection_count <= prediction_count),
  CHECK (
    (status = 'candidate' AND candidate_count > 0) OR
    (status = 'no_prediction' AND prediction_count = 0 AND candidate_count = 0 AND rejection_count = 0 AND failure_count = 0) OR
    (status = 'rejected' AND candidate_count = 0 AND rejection_count > 0) OR
    (status = 'failed' AND candidate_count = 0 AND failure_count > 0)
  )
);

CREATE TABLE extraction_attempt_labels (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES extraction_attempts(id),
  label_asset_id TEXT NOT NULL REFERENCES label_evidence_assets(id),
  role TEXT NOT NULL CHECK (role IN ('requested', 'prediction')),
  outcome TEXT NOT NULL CHECK (outcome IN ('candidate', 'no_prediction', 'rejected', 'failed')),
  prediction_count INTEGER NOT NULL CHECK (prediction_count >= 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  rejection_count INTEGER NOT NULL CHECK (rejection_count >= 0),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0 AND conflict_count <= candidate_count),
  candidate_hashes_json TEXT NOT NULL CHECK (
    json_valid(candidate_hashes_json) AND
    json_type(candidate_hashes_json) = 'array' AND
    json_array_length(candidate_hashes_json) = candidate_count
  ),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
  CHECK (rejection_count <= prediction_count),
  CHECK (
    (outcome = 'candidate' AND candidate_count > 0) OR
    (outcome = 'no_prediction' AND role = 'requested' AND prediction_count = 0 AND candidate_count = 0 AND rejection_count = 0 AND failure_count = 0) OR
    (outcome = 'rejected' AND candidate_count = 0 AND rejection_count > 0) OR
    (outcome = 'failed' AND candidate_count = 0 AND failure_count > 0)
  ),
  UNIQUE (attempt_id, label_asset_id, role)
);

CREATE UNIQUE INDEX idx_label_evidence_assets_natural_key
  ON label_evidence_assets(
    subject_source_record_id,
    subject_source_content_hash,
    field_family,
    source_image_id,
    coalesce(source_image_revision, ''),
    content_sha256
  );

CREATE INDEX idx_label_evidence_assets_product_family
  ON label_evidence_assets(product_id, field_family, fetched_at DESC);

CREATE INDEX idx_extraction_runs_family_status
  ON extraction_runs(field_family, status, accepted_at DESC);

CREATE UNIQUE INDEX idx_extraction_attempts_current_subject
  ON extraction_attempts(subject_source_record_id, field_family)
  WHERE is_current = 1;

CREATE INDEX idx_extraction_attempts_run
  ON extraction_attempts(extraction_run_id, status);

CREATE INDEX idx_extraction_attempts_product_family
  ON extraction_attempts(product_id, field_family, is_current, attempted_at DESC);

CREATE INDEX idx_extraction_attempt_labels_attempt_outcome
  ON extraction_attempt_labels(attempt_id, outcome);

CREATE INDEX idx_extraction_attempt_labels_asset
  ON extraction_attempt_labels(label_asset_id, attempt_id);

CREATE TRIGGER extraction_runs_lineage_insert
BEFORE INSERT ON extraction_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingestion_runs parent
    WHERE parent.id = NEW.parent_source_run_id
      AND parent.input_hash = NEW.parent_source_input_hash
      AND parent.source_complete = 1
      AND parent.status = 'completed'
  ) THEN RAISE(ABORT, 'extraction run parent source lineage mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingestion_runs own
    WHERE own.id = NEW.ingestion_run_id
      AND own.adapter_version = NEW.adapter_version
      AND own.source_complete = NEW.source_complete
  ) THEN RAISE(ABORT, 'extraction run ingestion lineage mismatch') END;
END;

CREATE TRIGGER extraction_runs_replay_collision
BEFORE INSERT ON extraction_runs
WHEN EXISTS (
  SELECT 1 FROM extraction_runs existing
  WHERE existing.id = NEW.id AND (
    existing.ingestion_run_id IS NOT NEW.ingestion_run_id OR
    existing.field_family IS NOT NEW.field_family OR
    existing.request_schema_hash IS NOT NEW.request_schema_hash OR
    existing.artifact_digest IS NOT NEW.artifact_digest OR
    existing.adapter_version IS NOT NEW.adapter_version OR
    existing.model_name IS NOT NEW.model_name OR
    existing.model_version IS NOT NEW.model_version OR
    existing.parent_source_run_id IS NOT NEW.parent_source_run_id OR
    existing.parent_source_input_hash IS NOT NEW.parent_source_input_hash OR
    existing.repository IS NOT NEW.repository OR
    existing.workflow IS NOT NEW.workflow OR
    existing.branch IS NOT NEW.branch OR
    existing.head_sha IS NOT NEW.head_sha OR
    existing.source_complete IS NOT NEW.source_complete OR
    existing.status IS NOT NEW.status OR
    existing.started_at IS NOT NEW.started_at OR
    existing.completed_at IS NOT NEW.completed_at OR
    existing.accepted_at IS NOT NEW.accepted_at OR
    existing.manifest_json IS NOT NEW.manifest_json
  )
) OR EXISTS (
  SELECT 1 FROM extraction_runs existing
  WHERE existing.ingestion_run_id = NEW.ingestion_run_id
    AND existing.field_family = NEW.field_family
    AND existing.artifact_digest = NEW.artifact_digest
    AND existing.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'extraction run replay collision');
END;

CREATE TRIGGER label_evidence_assets_replay_collision
BEFORE INSERT ON label_evidence_assets
WHEN EXISTS (
  SELECT 1 FROM label_evidence_assets existing
  WHERE existing.id = NEW.id AND (
    existing.subject_source_record_id IS NOT NEW.subject_source_record_id OR
    existing.subject_source_content_hash IS NOT NEW.subject_source_content_hash OR
    existing.product_id IS NOT NEW.product_id OR
    existing.field_family IS NOT NEW.field_family OR
    existing.source_image_id IS NOT NEW.source_image_id OR
    existing.source_image_revision IS NOT NEW.source_image_revision OR
    existing.requested_url IS NOT NEW.requested_url OR
    existing.effective_url IS NOT NEW.effective_url OR
    existing.content_sha256 IS NOT NEW.content_sha256 OR
    existing.byte_length IS NOT NEW.byte_length OR
    existing.media_type IS NOT NEW.media_type OR
    existing.fetched_at IS NOT NEW.fetched_at
  )
) OR EXISTS (
  SELECT 1 FROM label_evidence_assets existing
  WHERE existing.subject_source_record_id = NEW.subject_source_record_id
    AND existing.subject_source_content_hash = NEW.subject_source_content_hash
    AND existing.field_family = NEW.field_family
    AND existing.source_image_id = NEW.source_image_id
    AND coalesce(existing.source_image_revision, '') = coalesce(NEW.source_image_revision, '')
    AND existing.content_sha256 = NEW.content_sha256
    AND existing.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'label evidence asset replay collision');
END;

CREATE TRIGGER extraction_attempts_replay_collision
BEFORE INSERT ON extraction_attempts
WHEN EXISTS (
  SELECT 1 FROM extraction_attempts existing
  WHERE existing.id = NEW.id AND (
    existing.extraction_run_id IS NOT NEW.extraction_run_id OR
    existing.subject_source_record_id IS NOT NEW.subject_source_record_id OR
    existing.subject_source_record_key IS NOT NEW.subject_source_record_key OR
    existing.subject_source_content_hash IS NOT NEW.subject_source_content_hash OR
    existing.product_id IS NOT NEW.product_id OR
    existing.field_family IS NOT NEW.field_family OR
    existing.response_evidence_hash IS NOT NEW.response_evidence_hash OR
    existing.status IS NOT NEW.status OR
    existing.prediction_count IS NOT NEW.prediction_count OR
    existing.candidate_count IS NOT NEW.candidate_count OR
    existing.rejection_count IS NOT NEW.rejection_count OR
    existing.failure_count IS NOT NEW.failure_count OR
    existing.conflict_count IS NOT NEW.conflict_count OR
    existing.reasons_json IS NOT NEW.reasons_json OR
    existing.attempted_at IS NOT NEW.attempted_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'extraction attempt replay collision');
END;

CREATE TRIGGER extraction_attempt_labels_replay_collision
BEFORE INSERT ON extraction_attempt_labels
WHEN EXISTS (
  SELECT 1 FROM extraction_attempt_labels existing
  WHERE existing.id = NEW.id AND (
    existing.attempt_id IS NOT NEW.attempt_id OR
    existing.label_asset_id IS NOT NEW.label_asset_id OR
    existing.role IS NOT NEW.role OR
    existing.outcome IS NOT NEW.outcome OR
    existing.prediction_count IS NOT NEW.prediction_count OR
    existing.candidate_count IS NOT NEW.candidate_count OR
    existing.rejection_count IS NOT NEW.rejection_count OR
    existing.failure_count IS NOT NEW.failure_count OR
    existing.conflict_count IS NOT NEW.conflict_count OR
    existing.candidate_hashes_json IS NOT NEW.candidate_hashes_json OR
    existing.reasons_json IS NOT NEW.reasons_json
  )
) OR EXISTS (
  SELECT 1 FROM extraction_attempt_labels existing
  WHERE existing.attempt_id = NEW.attempt_id
    AND existing.label_asset_id = NEW.label_asset_id
    AND existing.role = NEW.role
    AND existing.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'extraction attempt label replay collision');
END;

CREATE TRIGGER label_evidence_assets_subject_matches_insert
BEFORE INSERT ON label_evidence_assets
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_records
    WHERE id = NEW.subject_source_record_id
      AND product_id = NEW.product_id
      AND content_hash = NEW.subject_source_content_hash
  ) THEN RAISE(ABORT, 'label asset subject source binding mismatch') END;
END;

CREATE TRIGGER extraction_attempts_subject_matches_insert
BEFORE INSERT ON extraction_attempts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_records
    WHERE id = NEW.subject_source_record_id
      AND source_record_id = NEW.subject_source_record_key
      AND product_id = NEW.product_id
      AND content_hash = NEW.subject_source_content_hash
  ) THEN RAISE(ABORT, 'extraction attempt subject source binding mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM extraction_runs
    WHERE id = NEW.extraction_run_id
      AND field_family = NEW.field_family
  ) THEN RAISE(ABORT, 'extraction attempt run family mismatch') END;
  SELECT CASE WHEN NEW.is_current = 1 AND NOT EXISTS (
    SELECT 1 FROM extraction_runs
    WHERE id = NEW.extraction_run_id
      AND status = 'accepted'
      AND source_complete = 1
  ) THEN RAISE(ABORT, 'current extraction attempt requires an accepted source-complete run') END;
END;

CREATE TRIGGER extraction_attempts_current_matches_update
BEFORE UPDATE OF is_current ON extraction_attempts
WHEN NEW.is_current = 1
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM extraction_runs
    WHERE id = NEW.extraction_run_id
      AND status = 'accepted'
      AND source_complete = 1
  ) THEN RAISE(ABORT, 'current extraction attempt requires an accepted source-complete run') END;
END;

CREATE TRIGGER extraction_attempt_labels_binding_insert
BEFORE INSERT ON extraction_attempt_labels
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM extraction_attempts attempt
    JOIN label_evidence_assets asset ON asset.id = NEW.label_asset_id
    WHERE attempt.id = NEW.attempt_id
      AND attempt.subject_source_record_id = asset.subject_source_record_id
      AND attempt.subject_source_content_hash = asset.subject_source_content_hash
      AND attempt.product_id = asset.product_id
      AND attempt.field_family = asset.field_family
  ) THEN RAISE(ABORT, 'extraction attempt label binding mismatch') END;
END;

CREATE TRIGGER extraction_runs_no_update
BEFORE UPDATE ON extraction_runs BEGIN
  SELECT RAISE(ABORT, 'extraction runs are immutable');
END;

CREATE TRIGGER extraction_runs_no_delete
BEFORE DELETE ON extraction_runs BEGIN
  SELECT RAISE(ABORT, 'extraction runs are immutable');
END;

CREATE TRIGGER label_evidence_assets_no_update
BEFORE UPDATE ON label_evidence_assets BEGIN
  SELECT RAISE(ABORT, 'label evidence assets are immutable');
END;

CREATE TRIGGER label_evidence_assets_no_delete
BEFORE DELETE ON label_evidence_assets BEGIN
  SELECT RAISE(ABORT, 'label evidence assets are immutable');
END;

CREATE TRIGGER extraction_attempts_immutable_update
BEFORE UPDATE ON extraction_attempts
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.extraction_run_id IS NOT OLD.extraction_run_id OR
  NEW.subject_source_record_id IS NOT OLD.subject_source_record_id OR
  NEW.subject_source_record_key IS NOT OLD.subject_source_record_key OR
  NEW.subject_source_content_hash IS NOT OLD.subject_source_content_hash OR
  NEW.product_id IS NOT OLD.product_id OR
  NEW.field_family IS NOT OLD.field_family OR
  NEW.response_evidence_hash IS NOT OLD.response_evidence_hash OR
  NEW.status IS NOT OLD.status OR
  NEW.prediction_count IS NOT OLD.prediction_count OR
  NEW.candidate_count IS NOT OLD.candidate_count OR
  NEW.rejection_count IS NOT OLD.rejection_count OR
  NEW.failure_count IS NOT OLD.failure_count OR
  NEW.conflict_count IS NOT OLD.conflict_count OR
  NEW.reasons_json IS NOT OLD.reasons_json OR
  NEW.attempted_at IS NOT OLD.attempted_at
BEGIN
  SELECT RAISE(ABORT, 'extraction attempts are immutable except for current state');
END;

CREATE TRIGGER extraction_attempts_no_delete
BEFORE DELETE ON extraction_attempts BEGIN
  SELECT RAISE(ABORT, 'extraction attempts are immutable');
END;

CREATE TRIGGER extraction_attempt_labels_no_update
BEFORE UPDATE ON extraction_attempt_labels BEGIN
  SELECT RAISE(ABORT, 'extraction attempt labels are immutable');
END;

CREATE TRIGGER extraction_attempt_labels_no_delete
BEFORE DELETE ON extraction_attempt_labels BEGIN
  SELECT RAISE(ABORT, 'extraction attempt labels are immutable');
END;

ALTER TABLE evidence_decisions
  ADD COLUMN extraction_attempt_id TEXT REFERENCES extraction_attempts(id);

ALTER TABLE evidence_decisions
  ADD COLUMN label_asset_id TEXT REFERENCES label_evidence_assets(id);

CREATE INDEX idx_evidence_decisions_extraction_link
  ON evidence_decisions(extraction_attempt_id, label_asset_id, active);

CREATE TRIGGER evidence_decisions_extraction_link_insert
BEFORE INSERT ON evidence_decisions
BEGIN
  SELECT CASE WHEN (NEW.extraction_attempt_id IS NULL) <> (NEW.label_asset_id IS NULL)
    THEN RAISE(ABORT, 'evidence decision extraction linkage must be complete') END;
  SELECT CASE WHEN NEW.extraction_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM extraction_attempts attempt
    JOIN extraction_attempt_labels attempt_label
      ON attempt_label.attempt_id = attempt.id
     AND attempt_label.label_asset_id = NEW.label_asset_id
    JOIN label_evidence_assets asset ON asset.id = attempt_label.label_asset_id
    JOIN source_records candidate_source ON candidate_source.id = NEW.source_record_id
    WHERE attempt.id = NEW.extraction_attempt_id
      AND attempt.is_current = 1
      AND attempt.product_id = NEW.product_id
      AND attempt.field_family = NEW.field_family
      AND candidate_source.source_id = NEW.source_id
      AND candidate_source.source_record_id = NEW.source_record_key
      AND candidate_source.product_id = NEW.product_id
      AND candidate_source.content_hash = NEW.source_content_hash
      AND json_extract(candidate_source.raw_evidence_json, '$.extractionAttemptId') = NEW.extraction_attempt_id
      AND json_extract(candidate_source.raw_evidence_json, '$.labelAssetId') = NEW.label_asset_id
      AND json_extract(candidate_source.raw_evidence_json, '$.labelContentSha256') = asset.content_sha256
      AND json_extract(candidate_source.raw_evidence_json, '$.candidateHash') = NEW.candidate_hash
      AND EXISTS (
        SELECT 1 FROM json_each(attempt_label.candidate_hashes_json)
        WHERE value = NEW.candidate_hash
      )
  ) THEN RAISE(ABORT, 'evidence decision extraction linkage mismatch') END;
END;

CREATE TRIGGER evidence_decisions_extraction_link_update
BEFORE UPDATE ON evidence_decisions
BEGIN
  SELECT CASE WHEN (NEW.extraction_attempt_id IS NULL) <> (NEW.label_asset_id IS NULL)
    THEN RAISE(ABORT, 'evidence decision extraction linkage must be complete') END;
  SELECT CASE WHEN NEW.extraction_attempt_id IS NOT NULL AND NEW.active = 1 AND NOT EXISTS (
    SELECT 1
    FROM extraction_attempts attempt
    JOIN extraction_attempt_labels attempt_label
      ON attempt_label.attempt_id = attempt.id
     AND attempt_label.label_asset_id = NEW.label_asset_id
    JOIN label_evidence_assets asset ON asset.id = attempt_label.label_asset_id
    JOIN source_records candidate_source ON candidate_source.id = NEW.source_record_id
    WHERE attempt.id = NEW.extraction_attempt_id
      AND attempt.is_current = 1
      AND attempt.product_id = NEW.product_id
      AND attempt.field_family = NEW.field_family
      AND candidate_source.source_id = NEW.source_id
      AND candidate_source.source_record_id = NEW.source_record_key
      AND candidate_source.product_id = NEW.product_id
      AND candidate_source.content_hash = NEW.source_content_hash
      AND json_extract(candidate_source.raw_evidence_json, '$.extractionAttemptId') = NEW.extraction_attempt_id
      AND json_extract(candidate_source.raw_evidence_json, '$.labelAssetId') = NEW.label_asset_id
      AND json_extract(candidate_source.raw_evidence_json, '$.labelContentSha256') = asset.content_sha256
      AND json_extract(candidate_source.raw_evidence_json, '$.candidateHash') = NEW.candidate_hash
      AND EXISTS (
        SELECT 1 FROM json_each(attempt_label.candidate_hashes_json)
        WHERE value = NEW.candidate_hash
      )
  ) THEN RAISE(ABORT, 'evidence decision extraction linkage mismatch') END;
END;

CREATE TRIGGER evidence_decisions_extraction_link_immutable
BEFORE UPDATE ON evidence_decisions
WHEN OLD.extraction_attempt_id IS NOT NEW.extraction_attempt_id
  OR OLD.label_asset_id IS NOT NEW.label_asset_id
BEGIN
  SELECT RAISE(ABORT, 'evidence decision extraction linkage is immutable');
END;
