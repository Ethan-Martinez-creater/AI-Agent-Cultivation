-- R0 correction: user ratings require execution by this Teammate in this
-- exact MissionRun. Keep the 0009 table and append-only update/delete guards.
DROP TRIGGER capability_evidence_validate_insert;
CREATE TRIGGER capability_evidence_validate_insert
BEFORE INSERT ON capability_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM mission_runs AS r
  JOIN missions AS m ON m.id = r.mission_id
  JOIN teammates AS t ON t.id = new.teammate_id
  WHERE r.id = new.run_id
    AND r.mission_id = new.mission_id
    AND r.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
    AND (
      (
        t.executor_kind = 'MODEL_RUNTIME'
        AND new.runtime_profile_id IS NOT NULL
        AND (
          m.coordinator_teammate_id = new.teammate_id
          OR EXISTS (
            SELECT 1 FROM mission_participants AS p
            WHERE p.mission_id = new.mission_id AND p.teammate_id = new.teammate_id
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM mission_events AS e
            WHERE e.mission_id = new.mission_id
              AND e.run_id = new.run_id
              AND e.actor_type = 'TEAMMATE'
              AND e.actor_id = new.teammate_id
              AND e.event_type = 'model.call_started'
              AND CASE WHEN json_valid(e.payload_json)
                THEN json_extract(e.payload_json, '$.runtimeProfileId')
                ELSE NULL END = new.runtime_profile_id
          )
          OR EXISTS (
            SELECT 1 FROM usage_records AS u
            WHERE u.mission_id = new.mission_id
              AND u.run_id = new.run_id
              AND u.teammate_id = new.teammate_id
              AND u.runtime_profile_id = new.runtime_profile_id
          )
        )
      )
      OR (
        t.executor_kind = 'USER_BRIDGE'
        AND new.runtime_profile_id IS NULL
        AND EXISTS (
          SELECT 1 FROM external_work_requests AS w
          WHERE w.mission_id = new.mission_id
            AND w.run_id = new.run_id
            AND w.assignee_teammate_id = new.teammate_id
            AND w.state = 'ACCEPTED'
            AND w.submitted_at IS NOT NULL
            AND w.resolved_at IS NOT NULL
        )
      )
    )
) BEGIN
  SELECT RAISE(ABORT, 'capability evidence requires terminal Run and matching teammate execution provenance');
END;
