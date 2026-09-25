CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  label TEXT NOT NULL, ciphertext BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE runtime_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE RESTRICT, model_id TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}', capability_overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE teammates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, title TEXT, description TEXT NOT NULL DEFAULT '',
  identity_prompt TEXT NOT NULL DEFAULT '', behavior_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  realm TEXT NOT NULL DEFAULT 'QI_REFINING' CHECK (realm IN ('QI_REFINING','FOUNDATION','CORE','NASCENT_SOUL')),
  current_runtime_profile_id TEXT REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK (owner_type IN ('USER','TEAMMATE','MISSION')),
  owner_id TEXT NOT NULL, memory_type TEXT NOT NULL CHECK (memory_type IN ('IDENTITY','PREFERENCE','FACT','EPISODE','PROCEDURE','OBSERVATION')),
  content TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL, source_id TEXT,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE','REJECTED','ARCHIVED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX memories_owner_scope_idx ON memories(owner_type, owner_id, status);
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, content, summary);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(memory_id, content, summary) VALUES (new.id, new.content, new.summary);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF content, summary ON memories BEGIN
  DELETE FROM memory_fts WHERE memory_id = old.id;
  INSERT INTO memory_fts(memory_id, content, summary) VALUES (new.id, new.content, new.summary);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memory_fts WHERE memory_id = old.id;
END;

CREATE TABLE skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL, version TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE teammate_skills (
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  PRIMARY KEY (teammate_id, skill_id)
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('BUILTIN','MCP')),
  name TEXT NOT NULL, description TEXT NOT NULL, input_schema_json TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('READ_ONLY','LOW','MEDIUM','HIGH')),
  side_effect TEXT NOT NULL CHECK (side_effect IN ('NONE','LOCAL_WRITE','EXTERNAL_WRITE','PROCESS_EXECUTION'))
);
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]',
  env_whitelist_json TEXT NOT NULL DEFAULT '[]', working_directory TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
CREATE TABLE teammate_tool_grants (
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  PRIMARY KEY (teammate_id, tool_id)
);

CREATE TABLE parties (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  coordinator_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('FIXED','AD_HOC')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TEXT NOT NULL
);
CREATE TABLE party_members (
  party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('COORDINATOR','MEMBER')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (party_id, teammate_id)
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
  initiator_type TEXT NOT NULL CHECK (initiator_type IN ('USER','TEAMMATE')), initiator_id TEXT NOT NULL,
  coordinator_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  party_id TEXT REFERENCES parties(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('SOLO','CONSULTATION','REVIEW','DELEGATION')),
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','READY','RUNNING','WAITING_APPROVAL','WAITING_COLLABORATION','PAUSED','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX missions_coordinator_idx ON missions(coordinator_teammate_id, created_at);
CREATE TABLE mission_runs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT, error_message TEXT,
  UNIQUE (mission_id, attempt)
);
CREATE TABLE mission_participants (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  role TEXT NOT NULL, PRIMARY KEY (mission_id, teammate_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
CREATE TABLE mission_events (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX mission_events_timeline_idx ON mission_events(mission_id, created_at);
CREATE TRIGGER mission_events_no_update BEFORE UPDATE ON mission_events BEGIN
  SELECT RAISE(ABORT, 'mission_events are append-only');
END;
CREATE TRIGGER mission_events_no_delete BEFORE DELETE ON mission_events BEGIN
  SELECT RAISE(ABORT, 'mission_events are append-only');
END;

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
  requester_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL, action_type TEXT NOT NULL, action_payload_json TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('READ_ONLY','LOW','MEDIUM','HIGH')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','DENIED','CANCELLED','EXPIRED')),
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  capability TEXT NOT NULL, resource_pattern TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY','ASK')),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL','TEAMMATE','MISSION'))
);
CREATE TABLE collaboration_requests (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  requester_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  target_teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL, proposed_task TEXT NOT NULL, estimated_usage INTEGER,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','DENIED','CANCELLED'))
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX audit_events_time_idx ON audit_events(created_at);
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY, mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER, reasoning_tokens INTEGER, provider_metadata_json TEXT,
  estimated_cost REAL, currency TEXT, created_at TEXT NOT NULL
);
CREATE INDEX usage_records_teammate_idx ON usage_records(teammate_id, created_at);
CREATE TABLE experience_events (
  id TEXT PRIMARY KEY, teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE capability_profiles (
  teammate_id TEXT PRIMARY KEY REFERENCES teammates(id) ON DELETE RESTRICT,
  tags_json TEXT NOT NULL DEFAULT '[]', stats_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
