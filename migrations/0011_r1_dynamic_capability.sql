-- R1 records benchmark ingestion time and identifies each derived capability
-- projection's scoring policy. Capability evidence remains append-only.

DROP TRIGGER model_capability_benchmarks_no_update;
DROP TRIGGER model_capability_benchmarks_no_delete;

ALTER TABLE model_capability_benchmarks
  ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

-- R0 benchmark rows predate ingestion timestamps. Preserve them and provide a
-- deterministic legacy timestamp from the already-persisted benchmark snapshot.
UPDATE model_capability_benchmarks
SET created_at = snapshot_date
WHERE created_at = '';

CREATE TRIGGER model_capability_benchmarks_validate_created_at_insert
BEFORE INSERT ON model_capability_benchmarks
WHEN length(trim(new.created_at)) = 0 BEGIN
  SELECT RAISE(ABORT, 'model capability benchmark created_at is required');
END;

CREATE TRIGGER model_capability_benchmarks_no_update BEFORE UPDATE ON model_capability_benchmarks BEGIN
  SELECT RAISE(ABORT, 'model capability benchmarks are append-only');
END;
CREATE TRIGGER model_capability_benchmarks_no_delete BEFORE DELETE ON model_capability_benchmarks BEGIN
  SELECT RAISE(ABORT, 'model capability benchmarks are append-only');
END;

ALTER TABLE teammate_capability_states
  ADD COLUMN scoring_policy_version TEXT NOT NULL DEFAULT 'r0-unversioned'
  CHECK (length(scoring_policy_version) BETWEEN 1 AND 128);

CREATE INDEX mission_events_model_call_actor_run_idx
  ON mission_events(run_id, actor_type, actor_id, event_type, created_at, id);
CREATE INDEX usage_records_mission_run_teammate_runtime_idx
  ON usage_records(mission_id, run_id, teammate_id, runtime_profile_id, created_at, id);
