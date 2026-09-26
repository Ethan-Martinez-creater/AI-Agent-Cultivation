-- Gate 4 persists only the selected workspace, configured stdio MCP metadata,
-- and the bounded tool call needed to resume a Mission after approval.

ALTER TABLE mcp_servers ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE mcp_servers
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE created_at = '' OR updated_at = '';

CREATE INDEX mcp_servers_enabled_name_idx ON mcp_servers(enabled, name COLLATE NOCASE);

CREATE TABLE pending_tool_calls (
  approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  tool_id TEXT NOT NULL CHECK (length(tool_id) > 0 AND length(tool_id) <= 512),
  source TEXT NOT NULL CHECK (source IN ('BUILTIN','MCP')),
  capability TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (length(input_json) <= 4194304),
  step_count INTEGER NOT NULL CHECK (step_count >= 0),
  tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RESOLVED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (state = 'PENDING' AND resolved_at IS NULL)
    OR (state = 'RESOLVED' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX pending_tool_calls_mission_state_idx
  ON pending_tool_calls(mission_id, state, created_at);
CREATE INDEX pending_tool_calls_run_state_idx
  ON pending_tool_calls(run_id, state, created_at);

CREATE TRIGGER pending_tool_calls_insert_pending
BEFORE INSERT ON pending_tool_calls
WHEN new.state != 'PENDING' OR new.resolved_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'pending tool calls must start pending');
END;

CREATE TRIGGER pending_tool_calls_approval_ownership_insert
BEFORE INSERT ON pending_tool_calls
WHEN NOT EXISTS (
  SELECT 1 FROM approval_requests AS a
  JOIN mission_runs AS r ON r.id = new.run_id AND r.mission_id = new.mission_id
  WHERE a.id = new.approval_id AND a.mission_id = new.mission_id
    AND a.run_id = new.run_id AND a.capability = new.capability
    AND a.state = 'PENDING' AND a.resolved_at IS NULL
) BEGIN
  SELECT RAISE(ABORT, 'pending tool call must match its approval, Mission, Run, and capability');
END;

CREATE TRIGGER pending_tool_calls_resolve_once
BEFORE UPDATE ON pending_tool_calls
WHEN old.state != 'PENDING'
  OR new.state != 'RESOLVED'
  OR new.resolved_at IS NULL
  OR new.approval_id IS NOT old.approval_id
  OR new.mission_id IS NOT old.mission_id
  OR new.run_id IS NOT old.run_id
  OR new.tool_id IS NOT old.tool_id
  OR new.source IS NOT old.source
  OR new.capability IS NOT old.capability
  OR new.input_json IS NOT old.input_json
  OR new.step_count IS NOT old.step_count
  OR new.tool_call_count IS NOT old.tool_call_count
  OR new.created_at IS NOT old.created_at BEGIN
  SELECT RAISE(ABORT, 'pending tool calls may be resolved once without changing request details');
END;

CREATE TRIGGER pending_tool_calls_no_delete BEFORE DELETE ON pending_tool_calls BEGIN
  SELECT RAISE(ABORT, 'pending tool calls are retained for Mission history');
END;
