-- Collaboration Experience is a derived projection. Rebuild those rows from
-- durable participant lifecycle events after replacing the run-status rule.
-- Mission, Run, Event, Audit, and all non-collaboration Experience facts remain.
DROP TRIGGER experience_events_insert_validate;
DROP TRIGGER experience_events_no_delete;

DELETE FROM experience_events WHERE experience_type = 'COLLABORATION';

CREATE TRIGGER experience_events_insert_validate
BEFORE INSERT ON experience_events
WHEN NOT EXISTS (
    SELECT 1 FROM mission_runs AS r
    JOIN missions AS m ON m.id = r.mission_id
    WHERE r.id = new.run_id AND r.mission_id = new.mission_id
      AND r.status != 'RUNNING'
      AND new.mode = m.mode
      AND (
        (new.experience_type = 'COLLABORATION' AND (
          (new.outcome = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM mission_events AS s
            JOIN collaboration_requests AS c
              ON c.id = json_extract(s.payload_json, '$.requestId')
             AND c.mission_id = s.mission_id AND c.run_id = s.run_id
             AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
            JOIN mission_events AS t
              ON t.mission_id = s.mission_id AND t.run_id = s.run_id
             AND t.actor_type = 'TEAMMATE' AND t.actor_id = s.actor_id
             AND t.event_type = 'collaboration.completed'
             AND json_extract(t.payload_json, '$.requestId') = c.id
             AND json_extract(t.payload_json, '$.targetTeammateId') = s.actor_id
            WHERE s.id = new.source_id AND s.mission_id = new.mission_id
              AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
              AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
              AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
              AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
              AND NOT EXISTS (
                SELECT 1 FROM mission_events AS other
                WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                  AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                  AND other.event_type = 'collaboration.failed'
                  AND json_extract(other.payload_json, '$.requestId') = c.id
                  AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
              )
          ))
          OR (new.outcome = 'FAILED' AND EXISTS (
            SELECT 1 FROM mission_events AS s
            JOIN collaboration_requests AS c
              ON c.id = json_extract(s.payload_json, '$.requestId')
             AND c.mission_id = s.mission_id AND c.run_id = s.run_id
             AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
            JOIN mission_events AS t
              ON t.mission_id = s.mission_id AND t.run_id = s.run_id
             AND t.actor_type = 'TEAMMATE' AND t.actor_id = s.actor_id
             AND t.event_type = 'collaboration.failed'
             AND json_extract(t.payload_json, '$.requestId') = c.id
             AND json_extract(t.payload_json, '$.targetTeammateId') = s.actor_id
            WHERE s.id = new.source_id AND s.mission_id = new.mission_id
              AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
              AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
              AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
              AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
              AND NOT EXISTS (
                SELECT 1 FROM mission_events AS other
                WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                  AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                  AND other.event_type = 'collaboration.completed'
                  AND json_extract(other.payload_json, '$.requestId') = c.id
                  AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
              )
          ))
          OR (new.outcome IN ('CANCELLED', 'INTERRUPTED')
            AND r.status = new.outcome AND EXISTS (
              SELECT 1 FROM mission_events AS s
              JOIN collaboration_requests AS c
                ON c.id = json_extract(s.payload_json, '$.requestId')
               AND c.mission_id = s.mission_id AND c.run_id = s.run_id
               AND c.target_teammate_id = s.actor_id AND c.state = 'APPROVED'
              WHERE s.id = new.source_id AND s.mission_id = new.mission_id
                AND s.run_id = new.run_id AND s.event_type = 'collaboration.started'
                AND s.actor_type = 'TEAMMATE' AND s.actor_id = new.teammate_id
                AND json_extract(s.payload_json, '$.requestId') IS NOT NULL
                AND json_extract(s.payload_json, '$.targetTeammateId') = s.actor_id
                AND NOT EXISTS (
                  SELECT 1 FROM mission_events AS other
                  WHERE other.mission_id = s.mission_id AND other.run_id = s.run_id
                    AND other.actor_type = 'TEAMMATE' AND other.actor_id = s.actor_id
                    AND other.event_type IN ('collaboration.completed', 'collaboration.failed')
                    AND json_extract(other.payload_json, '$.requestId') = c.id
                    AND json_extract(other.payload_json, '$.targetTeammateId') = s.actor_id
                )
            )
          )
        ))
        OR (new.experience_type != 'COLLABORATION' AND new.outcome = r.status)
      )
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
  ))
  OR (new.experience_type = 'COLLABORATION' AND NOT EXISTS (
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
            SELECT 1 FROM collaboration_requests AS denied
            WHERE denied.mission_id = a.mission_id AND denied.run_id = a.run_id
              AND denied.target_teammate_id = a.teammate_id AND denied.state = 'DENIED'
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
  SELECT RAISE(ABORT, 'experience event must match durable Mission, Run, and actor evidence');
END;

CREATE TRIGGER experience_events_no_delete BEFORE DELETE ON experience_events BEGIN
  SELECT RAISE(ABORT, 'experience events are append-only');
END;
