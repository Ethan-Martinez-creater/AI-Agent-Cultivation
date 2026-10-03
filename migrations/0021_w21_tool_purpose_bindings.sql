-- Local user-owned eligibility metadata. This grants no tool permissions.
CREATE TABLE tool_purpose_bindings (
  tool_id TEXT NOT NULL CHECK(length(tool_id) BETWEEN 1 AND 128),
  purpose TEXT NOT NULL CHECK(purpose IN ('RESEARCH','ASSET_COLLECTION','VOICEOVER','VIDEO_ASSEMBLY')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tool_id, purpose)
);
