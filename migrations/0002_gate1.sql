-- Gate 1 single-teammate conversations are independent from Mission runtime.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, teammate_id)
);
CREATE INDEX conversations_teammate_updated_idx
  ON conversations(teammate_id, updated_at DESC);
CREATE INDEX provider_credentials_provider_idx
  ON provider_credentials(provider_id, created_at);
CREATE INDEX runtime_profiles_provider_idx ON runtime_profiles(provider_id, name);

-- Chat messages have mission_id NULL and must belong to the exact conversation
-- owner. Mission messages keep their existing mission path and are not rebound
-- to chat conversations by this migration.
ALTER TABLE messages RENAME TO messages_gate0;
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL,
  teammate_id TEXT REFERENCES teammates(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER','TEAMMATE','SYSTEM')),
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (mission_id IS NULL AND teammate_id IS NOT NULL)
    OR (mission_id IS NOT NULL AND teammate_id IS NULL)
  ),
  FOREIGN KEY (conversation_id, teammate_id)
    REFERENCES conversations(id, teammate_id) ON DELETE RESTRICT
);

-- Preserve legacy unscoped rows for inspection: Gate 0 did not record the
-- teammate owner needed to safely classify them as Gate 1 conversations.
CREATE TABLE legacy_unscoped_messages AS
  SELECT * FROM messages_gate0 WHERE mission_id IS NULL;
INSERT INTO messages (
  id, mission_id, conversation_id, teammate_id, actor_type, actor_id, role, content, created_at
)
SELECT id, mission_id, conversation_id, NULL, actor_type, actor_id, role, content, created_at
FROM messages_gate0
WHERE mission_id IS NOT NULL;
DROP TABLE messages_gate0;
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
CREATE INDEX messages_teammate_conversation_idx
  ON messages(teammate_id, conversation_id, created_at);

-- Providers may omit token counts. Preserve existing rows and store unknown
-- counts as NULL instead of inventing zero values.
ALTER TABLE usage_records RENAME TO usage_records_gate0;
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES mission_runs(id) ON DELETE RESTRICT,
  teammate_id TEXT NOT NULL REFERENCES teammates(id) ON DELETE RESTRICT,
  runtime_profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens INTEGER,
  reasoning_tokens INTEGER,
  provider_metadata_json TEXT,
  estimated_cost REAL,
  currency TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO usage_records (
  id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
  provider_metadata_json, estimated_cost, currency, created_at
)
SELECT
  id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
  input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
  provider_metadata_json, estimated_cost, currency, created_at
FROM usage_records_gate0;
DROP TABLE usage_records_gate0;
CREATE INDEX usage_records_teammate_idx ON usage_records(teammate_id, created_at);
