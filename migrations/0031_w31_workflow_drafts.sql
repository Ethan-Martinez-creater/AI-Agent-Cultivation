-- W3.1 stores editable USER Workflow authoring state separately from immutable releases.
-- A draft is never an execution state, and its optional base version remains retained.

CREATE TABLE workflow_user_drafts (
  id TEXT PRIMARY KEY CHECK (
    id = trim(id)
    AND length(id) BETWEEN 1 AND 256
    AND lower(id) NOT GLOB 'official.*'
  ),
  definition_id TEXT NOT NULL UNIQUE CHECK (
    definition_id = trim(definition_id)
    AND length(definition_id) BETWEEN 1 AND 256
    AND lower(definition_id) NOT GLOB 'official.*'
  ),
  base_version INTEGER CHECK (base_version IS NULL OR base_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (
    COALESCE(json_valid(content_json)
      AND json_type(content_json) = 'object'
      AND length(CAST(content_json AS BLOB)) <= 120000, 0)
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) BETWEEN 1 AND 128),
  FOREIGN KEY (definition_id, base_version)
    REFERENCES workflow_versions(definition_id, version) ON DELETE RESTRICT
);

CREATE INDEX workflow_user_drafts_updated_idx
  ON workflow_user_drafts(updated_at DESC, definition_id);

CREATE TRIGGER workflow_user_drafts_source_guard_insert
BEFORE INSERT ON workflow_user_drafts
WHEN lower(new.id) GLOB 'official.*'
  OR lower(new.definition_id) GLOB 'official.*'
  OR EXISTS (
    SELECT 1 FROM workflow_definitions AS definition
    WHERE definition.id = new.definition_id AND definition.source != 'USER'
  )
BEGIN
  SELECT RAISE(ABORT, 'Only USER Workflow definitions can have drafts');
END;

CREATE TRIGGER workflow_user_drafts_source_guard_update
BEFORE UPDATE ON workflow_user_drafts
WHEN lower(new.id) GLOB 'official.*'
  OR lower(new.definition_id) GLOB 'official.*'
  OR EXISTS (
    SELECT 1 FROM workflow_definitions AS definition
    WHERE definition.id = new.definition_id AND definition.source != 'USER'
  )
BEGIN
  SELECT RAISE(ABORT, 'Only USER Workflow definitions can have drafts');
END;

CREATE TRIGGER workflow_user_drafts_identity_immutable
BEFORE UPDATE ON workflow_user_drafts
WHEN new.id IS NOT old.id
  OR new.definition_id IS NOT old.definition_id
  OR new.base_version IS NOT old.base_version
  OR new.created_at IS NOT old.created_at
  OR new.revision != old.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'Workflow Draft identity/base are immutable and revisions advance once');
END;
