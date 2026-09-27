-- Gate 6 stores only append-only facts derived from durable Mission activity.
-- Preserve the unused pre-Gate-6 free-form table separately; it is not a source of truth.
ALTER TABLE experience_events RENAME TO legacy_experience_events;

CREATE TABLE experience_events (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  experience_type TEXT NOT NULL CHECK (
    experience_type IN ('MISSION_RESULT', 'COLLABORATION', 'TOOL_USE', 'SKILL_USE')
  ),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
  ),
  mode TEXT NOT NULL CHECK (mode IN ('SOLO', 'CONSULTATION', 'REVIEW', 'DELEGATION')),
  created_at TEXT NOT NULL,
  UNIQUE (source, source_id, teammate_id, experience_type)
);

CREATE INDEX experience_events_teammate_timeline_idx
  ON experience_events(teammate_id, created_at, id);
CREATE INDEX experience_events_run_idx
  ON experience_events(run_id, experience_type, teammate_id);

CREATE TRIGGER experience_events_insert_validate
BEFORE INSERT ON experience_events
WHEN NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND r.status != 'RUNNING'
      AND new.mode = m.mode
      AND new.outcome = r.status
      AND (
        (m.mode = 'SOLO' AND new.teammate_id = m.coordinator_teammate_id
          AND new.role = 'COORDINATOR')
        OR (m.mode != 'SOLO' AND m.party_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM mission_participants AS p
          WHERE p.mission_id = m.id AND p.teammate_id = new.teammate_id
            AND p.role = new.role
        ))
      )
  )
  OR (new.experience_type = 'MISSION_RESULT' AND NOT (
    new.source = 'MISSION_RUN' AND new.source_id = new.run_id
      AND EXISTS (
        SELECT 1 FROM missions AS m
        WHERE m.id = new.mission_id AND (
          EXISTS (
            SELECT 1 FROM usage_records AS u
            WHERE u.mission_id = m.id AND u.run_id = new.run_id
              AND u.teammate_id = new.teammate_id
          )
          OR EXISTS (
            SELECT 1 FROM mission_events AS e
            WHERE e.mission_id = m.id AND e.run_id = new.run_id
              AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
              AND (e.event_type = 'model.call_started'
                OR (e.event_type = 'tool.result'
                  AND json_extract(e.payload_json, '$.success') = 1))
          )
          OR EXISTS (
            SELECT 1 FROM collaboration_artifacts AS a
            WHERE a.mission_id = m.id AND a.run_id = new.run_id
              AND a.teammate_id = new.teammate_id
              AND NOT EXISTS (
                SELECT 1 FROM collaboration_requests AS c
                WHERE c.mission_id = a.mission_id AND c.run_id = a.run_id
                  AND c.target_teammate_id = a.teammate_id AND c.state = 'DENIED'
              )
          )
        )
      )
  ))
  OR (new.experience_type = 'COLLABORATION' AND NOT (
    new.source = 'COLLABORATION_EVENT'
      AND EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.id = new.source_id AND e.mission_id = new.mission_id
          AND e.run_id = new.run_id AND e.event_type = 'collaboration.started'
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
      )
      AND EXISTS (
        SELECT 1 FROM missions AS m
        WHERE m.id = new.mission_id AND (
          EXISTS (
            SELECT 1 FROM usage_records AS u
            WHERE u.mission_id = m.id AND u.run_id = new.run_id
              AND u.teammate_id = new.teammate_id
          )
          OR EXISTS (
            SELECT 1 FROM mission_events AS e
            WHERE e.mission_id = m.id AND e.run_id = new.run_id
              AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
              AND (e.event_type = 'model.call_started'
                OR (e.event_type = 'tool.result'
                  AND json_extract(e.payload_json, '$.success') = 1))
          )
          OR EXISTS (
            SELECT 1 FROM collaboration_artifacts AS a
            WHERE a.mission_id = m.id AND a.run_id = new.run_id
              AND a.teammate_id = new.teammate_id
              AND NOT EXISTS (
                SELECT 1 FROM collaboration_requests AS c
                WHERE c.mission_id = a.mission_id AND c.run_id = a.run_id
                  AND c.target_teammate_id = a.teammate_id AND c.state = 'DENIED'
              )
          )
        )
      )
  ))
  OR (new.experience_type = 'TOOL_USE' AND NOT (
    new.source = 'MISSION_EVENT'
      AND EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.id = new.source_id AND e.mission_id = new.mission_id
          AND e.run_id = new.run_id AND e.event_type = 'tool.result'
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
          AND json_extract(e.payload_json, '$.success') = 1
      )
  ))
  OR (new.experience_type = 'SKILL_USE' AND NOT (
    new.source = 'MISSION_EVENT'
      AND EXISTS (
        SELECT 1 FROM mission_events AS e
        WHERE e.id = new.source_id AND e.mission_id = new.mission_id
          AND e.run_id = new.run_id AND e.event_type = 'skill.used'
          AND e.actor_type = 'TEAMMATE' AND e.actor_id = new.teammate_id
          AND length(json_extract(e.payload_json, '$.skillId')) > 0
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'experience event must match a terminal Mission Run and durable actor evidence');
END;

CREATE TRIGGER experience_events_no_update BEFORE UPDATE ON experience_events BEGIN
  SELECT RAISE(ABORT, 'experience events are append-only');
END;
CREATE TRIGGER experience_events_no_delete BEFORE DELETE ON experience_events BEGIN
  SELECT RAISE(ABORT, 'experience events are append-only');
END;
