-- R3 keeps the Jev decision provider outside the generative Provider/Runtime tables.
-- Credentials are encrypted by Main with safeStorage before these bytes reach SQLite.

ALTER TABLE decision_receipts ADD COLUMN actual_action TEXT
  CHECK (actual_action IS NULL OR length(actual_action) <= 256);
ALTER TABLE decision_receipts ADD COLUMN latency_ms INTEGER
  CHECK (latency_ms IS NULL OR latency_ms >= 0);
ALTER TABLE decision_receipts ADD COLUMN input_tokens INTEGER
  CHECK (input_tokens IS NULL OR input_tokens >= 0);

CREATE INDEX decision_receipts_type_timeline_idx
  ON decision_receipts(decision_type, created_at DESC, id);

CREATE TRIGGER decision_receipts_r3_shadow_only
BEFORE INSERT ON decision_receipts
WHEN new.mode != 'SHADOW'
BEGIN
  SELECT RAISE(ABORT, 'R3 decision receipts are SHADOW-only');
END;

CREATE TABLE decision_provider_configs (
  id TEXT PRIMARY KEY CHECK (id = 'TYPESAFE'),
  provider TEXT NOT NULL CHECK (provider = 'TYPESAFE'),
  model TEXT NOT NULL CHECK (model = 'jev-1.13.0'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  api_key_ciphertext BLOB CHECK (
    api_key_ciphertext IS NULL
    OR (typeof(api_key_ciphertext) = 'blob' AND length(api_key_ciphertext) > 0)
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO decision_provider_configs
  (id, provider, model, enabled, mode, api_key_ciphertext, created_at, updated_at)
VALUES ('TYPESAFE', 'TYPESAFE', 'jev-1.13.0', 0, 'SHADOW', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER decision_provider_configs_identity_immutable
BEFORE UPDATE ON decision_provider_configs
WHEN new.id IS NOT old.id OR new.provider IS NOT old.provider
  OR new.model IS NOT old.model OR new.mode IS NOT old.mode
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'decision provider identity/model/mode is fixed for R3');
END;

CREATE TRIGGER decision_provider_configs_no_delete
BEFORE DELETE ON decision_provider_configs
BEGIN
  SELECT RAISE(ABORT, 'decision provider config is a retained singleton');
END;

CREATE TABLE decision_shadow_policy_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  question_version TEXT NOT NULL CHECK (length(question_version) BETWEEN 1 AND 128),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  max_state_bytes INTEGER NOT NULL DEFAULT 24000 CHECK (max_state_bytes BETWEEN 1 AND 24000),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 250 AND 120000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO decision_shadow_policy_config
  (id, enabled, mode, question_version, policy_version,
   max_state_bytes, timeout_ms, created_at, updated_at)
VALUES ('default', 0, 'SHADOW', 'r3-questions-v1', 'r3-shadow-policy-v1',
  24000, 15000,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER decision_shadow_policy_identity_immutable
BEFORE UPDATE ON decision_shadow_policy_config
WHEN new.id IS NOT old.id OR new.mode IS NOT old.mode
  OR new.created_at IS NOT old.created_at
BEGIN
  SELECT RAISE(ABORT, 'decision shadow policy singleton/mode is fixed for R3');
END;

CREATE TRIGGER decision_shadow_policy_no_delete
BEFORE DELETE ON decision_shadow_policy_config
BEGIN
  SELECT RAISE(ABORT, 'decision shadow policy config is a retained singleton');
END;

CREATE TABLE decision_shadow_attempts (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT,
  decision_type TEXT NOT NULL CHECK (length(decision_type) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider = 'TYPESAFE'),
  model TEXT NOT NULL CHECK (model = 'jev-1.13.0'),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'SKIPPED')),
  receipt_id TEXT REFERENCES decision_receipts(id) ON DELETE RESTRICT,
  actual_action TEXT CHECK (actual_action IS NULL OR length(actual_action) <= 256),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'DISABLED', 'UNSUPPORTED', 'TIMEOUT', 'NETWORK', 'HTTP_ERROR',
      'SCHEMA_MISMATCH', 'INVALID_RESPONSE', 'INVALID_REQUEST',
      'PROVIDER_UNAVAILABLE', 'RECEIPT_WRITE_FAILED', 'UNKNOWN'
    )
  ),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  created_at TEXT NOT NULL,
  CHECK (run_id IS NULL OR mission_id IS NOT NULL),
  CHECK (
    (status = 'SUCCESS' AND receipt_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'ERROR' AND receipt_id IS NULL AND error_code IS NOT NULL)
    OR (status = 'SKIPPED' AND receipt_id IS NULL)
  )
);

CREATE INDEX decision_shadow_attempts_timeline_idx
  ON decision_shadow_attempts(created_at DESC, id);
CREATE INDEX decision_shadow_attempts_mission_idx
  ON decision_shadow_attempts(mission_id, created_at DESC, id);
CREATE INDEX decision_shadow_attempts_run_idx
  ON decision_shadow_attempts(run_id, created_at DESC, id);

CREATE TRIGGER decision_shadow_attempts_validate_insert
BEFORE INSERT ON decision_shadow_attempts
WHEN (new.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
  ))
  OR (new.receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM decision_receipts AS d
    WHERE d.id = new.receipt_id
      AND d.mission_id IS new.mission_id
      AND d.run_id IS new.run_id
      AND d.decision_type = new.decision_type
      AND d.mode = 'SHADOW'
  ))
BEGIN
  SELECT RAISE(ABORT, 'shadow attempt must match its Mission/Run and SHADOW receipt');
END;

CREATE TRIGGER decision_shadow_attempts_no_update
BEFORE UPDATE ON decision_shadow_attempts
BEGIN
  SELECT RAISE(ABORT, 'decision shadow attempts are append-only');
END;

CREATE TRIGGER decision_shadow_attempts_no_delete
BEFORE DELETE ON decision_shadow_attempts
BEGIN
  SELECT RAISE(ABORT, 'decision shadow attempts are append-only');
END;
