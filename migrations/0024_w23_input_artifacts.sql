-- Trusted user-selected, permission-gated input imports. No change to frozen Workflow versions.
CREATE TABLE workflow_input_artifacts (
 id TEXT PRIMARY KEY,
 category TEXT NOT NULL CHECK(category IN ('DATA','CODE')),
 kind TEXT NOT NULL CHECK(kind='FILE'),
 workspace_root TEXT NOT NULL CHECK(length(workspace_root) BETWEEN 1 AND 4096),
 relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 1024 AND relative_path NOT LIKE '/%' AND instr(relative_path,':')=0 AND relative_path!='..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%'),
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 256),
 content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 65536),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
 tool_call_id TEXT NOT NULL UNIQUE,
 audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL
);
CREATE INDEX workflow_input_artifacts_category ON workflow_input_artifacts(category,created_at,id);
CREATE TRIGGER workflow_input_artifacts_no_update BEFORE UPDATE ON workflow_input_artifacts
BEGIN SELECT RAISE(ABORT,'Input Artifact facts are immutable'); END;
CREATE TRIGGER workflow_input_artifacts_no_delete BEFORE DELETE ON workflow_input_artifacts
BEGIN SELECT RAISE(ABORT,'Input Artifact facts are immutable'); END;
CREATE TRIGGER workflow_input_artifacts_provenance BEFORE INSERT ON workflow_input_artifacts
WHEN NOT EXISTS (SELECT 1 FROM audit_events event WHERE event.id=new.audit_event_id
 AND event.actor_type='USER' AND event.action='workflow.input_imported'
 AND event.target_type='INPUT_ARTIFACT' AND event.target_id=new.id
 AND json_extract(event.payload_json,'$.toolId')='file.readText'
 AND json_extract(event.payload_json,'$.capability')='FILE_READ'
 AND json_extract(event.payload_json,'$.success')=1
 AND json_extract(event.payload_json,'$.toolCallId')=new.tool_call_id
 AND json_extract(event.payload_json,'$.contentHash')=new.content_hash)
BEGIN SELECT RAISE(ABORT,'Input Artifact requires an actual user Tool import audit fact'); END;

CREATE TABLE workflow_research_input_bindings (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
 input_key TEXT NOT NULL CHECK(input_key IN ('existingSources','existingData','existingCode')),
 input_index INTEGER NOT NULL CHECK(input_index BETWEEN 0 AND 11),
 artifact_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('SOURCE','DATA','CODE')),
 kind TEXT NOT NULL CHECK(kind IN ('FILE','EXTERNAL_REFERENCE')),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 PRIMARY KEY(workflow_run_id,input_key,input_index)
);
CREATE TRIGGER workflow_research_input_bindings_validate BEFORE INSERT ON workflow_research_input_bindings
WHEN NOT EXISTS (SELECT 1 FROM workflow_runs run WHERE run.id=new.workflow_run_id AND run.definition_id='official.research' AND run.definition_version=1
 AND json_extract(run.input_snapshot_json,'$.'||new.input_key||'['||new.input_index||'].id')=new.artifact_id
 AND json_extract(run.input_snapshot_json,'$.'||new.input_key||'['||new.input_index||'].kind')=new.kind
 AND json_extract(run.input_snapshot_json,'$.'||new.input_key||'['||new.input_index||'].contentHash')=new.content_hash)
 OR NOT ((new.category='SOURCE' AND new.input_key='existingSources' AND new.kind='EXTERNAL_REFERENCE'
  AND EXISTS (SELECT 1 FROM research_source_artifacts source WHERE source.id=new.artifact_id AND source.content_hash=new.content_hash))
 OR (new.category IN ('DATA','CODE') AND new.input_key=CASE new.category WHEN 'DATA' THEN 'existingData' ELSE 'existingCode' END
  AND EXISTS (SELECT 1 FROM workflow_input_artifacts artifact WHERE artifact.id=new.artifact_id AND artifact.category=new.category AND artifact.kind=new.kind AND artifact.content_hash=new.content_hash)))
BEGIN SELECT RAISE(ABORT,'Research input binding must resolve the frozen snapshot and actual provenance'); END;
CREATE TRIGGER workflow_research_input_bindings_no_update BEFORE UPDATE ON workflow_research_input_bindings
BEGIN SELECT RAISE(ABORT,'Research input bindings are immutable'); END;
CREATE TRIGGER workflow_research_input_bindings_no_delete BEFORE DELETE ON workflow_research_input_bindings
BEGIN SELECT RAISE(ABORT,'Research input bindings are immutable'); END;
