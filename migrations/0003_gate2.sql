ALTER TABLE memories ADD COLUMN source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN confirmed_at TEXT;

CREATE INDEX memories_source_conversation_idx ON memories(source_conversation_id);
CREATE INDEX memories_source_message_idx ON memories(source_message_id);

ALTER TABLE teammate_skills
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));

CREATE TABLE skill_revisions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, revision),
  UNIQUE (skill_id, version)
);
CREATE INDEX skill_revisions_history_idx ON skill_revisions(skill_id, revision DESC);
CREATE TRIGGER skill_revisions_no_update BEFORE UPDATE ON skill_revisions BEGIN
  SELECT RAISE(ABORT, 'skill_revisions are immutable');
END;
CREATE TRIGGER skill_revisions_no_delete BEFORE DELETE ON skill_revisions BEGIN
  SELECT RAISE(ABORT, 'skill_revisions are immutable');
END;

INSERT INTO skill_revisions
  (id, skill_id, revision, version, name, description, instructions, tags_json, created_at)
SELECT id || ':r1', id, 1, version, name, description, instructions, tags_json, updated_at
FROM skills;
