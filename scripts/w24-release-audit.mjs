import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

// Same assertions apply to ALL installed templates and ALL attempts, including
// blocked/adversarial runs. No template-specific fixture can exempt its facts.
export function auditCrossWorkflow(db, officialPackages) {
  assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n, 32);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check')[0].integrity_check, 'ok');
  const versions = new Map();
  const releases = officialPackages.map(({ version }) => {
    const row = db
      .prepare('SELECT * FROM workflow_versions WHERE definition_id=? AND version=?')
      .get(version.definition.id, version.version);
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.version_json), version);
    assert.equal(row.content_hash, hash(version));
    assert.equal(row.entry_step_id, version.entryStepId);
    const release = db
      .prepare(
        'SELECT manifest_hash FROM workflow_builtin_releases WHERE definition_id=? AND version=?',
      )
      .get(version.definition.id, version.version);
    assert.equal(release.manifest_hash, version.releaseMetadata.manifestHash);
    for (const contract of version.contractManifest) {
      const stored = db
        .prepare(
          'SELECT * FROM workflow_artifact_contract_registry WHERE contract_id=? AND contract_version=?',
        )
        .get(contract.contractId, contract.contractVersion);
      assert.deepEqual(JSON.parse(stored.contract_json), contract);
      assert.equal(stored.content_hash, hash(contract));
    }
    versions.set(version.definition.id, version);
    return {
      definitionId: version.definition.id,
      version: version.version,
      manifestHash: release.manifest_hash,
      contentHash: row.content_hash,
      contractCount: version.contractManifest.length,
      contractManifest: version.releaseMetadata.contractManifest,
      revisionManifest: version.releaseMetadata.revisionManifest,
      sideEffectManifest: version.releaseMetadata.effectManifest,
      revisionGroups: version.revisionGroups,
      sideEffects: version.releaseMetadata.effectManifest.filter(
        (effect) => effect.effectType !== 'NONE',
      ),
      validationPolicy: version.validationPolicy,
      referenceBasis: version.releaseMetadata.referenceBasis,
      designRationale: version.releaseMetadata.designRationale,
      breakingChanges: 'Initial v1 release; none',
    };
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_builtin_releases').get().n, 3);
  const runs = db.prepare('SELECT * FROM workflow_runs ORDER BY created_at,id').all();
  const counts = {};
  for (const run of runs) {
    const version = versions.get(run.definition_id);
    assert.ok(version, 'clean profile contains only the three OFFICIAL definitions');
    assert.equal(run.definition_version, version.version);
    JSON.parse(run.input_snapshot_json);
    counts[run.definition_id] = (counts[run.definition_id] ?? 0) + 1;
    const steps = db
      .prepare('SELECT * FROM workflow_step_runs WHERE workflow_run_id=?')
      .all(run.id);
    for (const step of steps) {
      const frozen = version.steps.find((definition) => definition.id === step.step_id);
      assert.ok(frozen);
      if (step.state !== 'COMPLETED') continue;
      assert.ok(
        db
          .prepare(
            'SELECT 1 FROM workflow_checkpoints WHERE workflow_run_id=? AND definition_version=? AND EXISTS(SELECT 1 FROM json_each(completed_step_run_ids_json) WHERE value=?)',
          )
          .get(run.id, run.definition_version, step.id),
        'completed step is checkpointed',
      );
      for (const output of frozen.outputs) {
        const binding = db
          .prepare(
            "SELECT * FROM workflow_artifact_bindings WHERE step_run_id=? AND key=? AND role='OUTPUT'",
          )
          .get(step.id, output.key);
        if (!binding && !output.required) continue;
        assert.ok(binding, 'required producer output has a binding');
        assert.equal(binding.contract_id, output.contractId);
        assert.equal(binding.contract_version, output.contractVersion);
        const artifact = db
          .prepare('SELECT * FROM workflow_artifacts WHERE id=?')
          .get(binding.artifact_id);
        assert.equal(artifact.workflow_run_id, run.id);
        assert.equal(artifact.producer_step_run_id, step.id);
        assert.equal(artifact.mission_id, step.mission_id);
        assert.equal(artifact.mission_run_id, step.mission_run_id);
        assert.ok(
          db
            .prepare(
              "SELECT 1 FROM mission_runs AS r JOIN missions AS m ON m.id=r.mission_id WHERE r.id=? AND m.id=? AND r.status='COMPLETED' AND m.state='COMPLETED'",
            )
            .get(artifact.mission_run_id, artifact.mission_id),
          'terminal Mission fact matches producer',
        );
        if (artifact.source === 'HUMAN_BRIDGE')
          assert.ok(
            db
              .prepare(
                "SELECT 1 FROM external_work_artifacts AS a JOIN external_work_requests AS r ON r.id=a.external_work_request_id WHERE a.id=? AND r.mission_id=? AND r.run_id=? AND r.assignee_teammate_id=? AND r.state='ACCEPTED'",
              )
              .get(
                artifact.source_id,
                artifact.mission_id,
                artifact.mission_run_id,
                artifact.actor_id,
              ),
            'Human Bridge output belongs to actually accepted same-Run work',
          );
        assert.equal(
          artifact.content_hash,
          hash({ content: artifact.content, metadata: JSON.parse(artifact.metadata_json) }),
        );
        const contract = version.contractManifest.find(
          (contract) =>
            contract.contractId === output.contractId &&
            contract.contractVersion === output.contractVersion,
        );
        assert.ok(
          db
            .prepare(
              'SELECT 1 FROM workflow_validation_receipts WHERE step_run_id=? AND artifact_id=? AND contract_id=? AND contract_version=? AND content_hash=? AND validator_version=? AND valid=1',
            )
            .get(
              step.id,
              artifact.id,
              output.contractId,
              output.contractVersion,
              artifact.content_hash,
              contract.validatorVersion,
            ),
          'same hash and frozen Contract have machine PASS',
        );
      }
      if (frozen.effectType !== 'NONE') {
        const operations = db
          .prepare('SELECT * FROM workflow_step_operation_receipts WHERE step_run_id=?')
          .all(step.id);
        assert.ok(operations.length, 'completed effect has an operation receipt');
        assert.ok(
          operations.every((operation) => operation.state === 'VERIFIED'),
          'every completed effect, including mixed external action, is VERIFIED',
        );
      }
    }
    const decisions = db
      .prepare('SELECT * FROM workflow_decisions WHERE workflow_run_id=?')
      .all(run.id);
    for (const decision of decisions) {
      const edge = version.edges.find((item) => item.id === decision.edge_id);
      assert.ok(edge, 'only declared graph edge');
      assert.equal(edge.branch, decision.branch);
      assert.equal(steps.find((step) => step.id === decision.step_run_id).step_id, edge.fromStepId);
    }
    const traversals = db
      .prepare(
        'SELECT * FROM workflow_revision_traversals WHERE workflow_run_id=? ORDER BY group_id,traversal_index',
      )
      .all(run.id);
    for (const group of version.revisionGroups) {
      const selected = traversals.filter((entry) => entry.group_id === group.id);
      const input = JSON.parse(run.input_snapshot_json);
      const limit =
        group.id === 'research.experiment_cycle'
          ? input.maxExperimentCycles
          : group.maxTotalTraversals;
      assert.ok(selected.length <= limit);
      assert.deepEqual(
        selected.map((entry) => entry.traversal_index),
        selected.map((_, index) => index + 1),
      );
    }
    for (const traversal of traversals) {
      const edge = version.edges.find((item) => item.id === traversal.edge_id);
      assert.equal(edge.revision.groupId, traversal.group_id);
      assert.ok(
        traversals.filter((entry) => entry.edge_id === edge.id).length <=
          edge.revision.maxTraversals,
      );
      assert.ok(
        decisions.some(
          (entry) =>
            entry.step_run_id === traversal.step_run_id && entry.edge_id === traversal.edge_id,
        ),
      );
    }
    if (run.state === 'COMPLETED') {
      const expectedOutputs = [];
      for (const spec of version.outputSchema?.outputs ?? []) {
        const producer = steps
          .filter((step) => step.step_id === spec.fromStepId)
          .sort((a, b) => b.attempt - a.attempt)[0];
        const binding =
          producer?.state === 'COMPLETED'
            ? db
                .prepare(
                  "SELECT * FROM workflow_artifact_bindings WHERE step_run_id=? AND key=? AND role='OUTPUT'",
                )
                .get(producer.id, spec.outputKey)
            : undefined;
        if (!binding && !spec.required) continue;
        assert.ok(binding, 'required final output is bound to latest completed producer');
        const artifact = db
          .prepare('SELECT * FROM workflow_artifacts WHERE id=?')
          .get(binding.artifact_id);
        expectedOutputs.push({
          key: spec.key,
          artifactId: artifact.id,
          contentHash: artifact.content_hash,
        });
      }
      const inputHash = hash(JSON.parse(run.input_snapshot_json));
      const currentStateHash = hash({
        version: run.definition_version,
        inputHash,
        outputBindings: expectedOutputs,
        errors: [],
        policy: 'w1-io-v1',
      });
      const final = db
        .prepare(
          'SELECT * FROM workflow_run_output_validations WHERE workflow_run_id=? AND state_hash=? AND valid=1',
        )
        .get(run.id, currentStateHash);
      assert.ok(final, 'completed run has final validation');
      assert.equal(final.input_hash, inputHash);
      assert.deepEqual(JSON.parse(final.output_bindings_json), expectedOutputs);
      for (const output of JSON.parse(final.output_bindings_json)) {
        const artifact = db
          .prepare('SELECT * FROM workflow_artifacts WHERE id=?')
          .get(output.artifactId);
        assert.equal(artifact.workflow_run_id, run.id);
        assert.equal(artifact.content_hash, output.contentHash);
        const producer = steps.find((step) => step.id === artifact.producer_step_run_id);
        assert.equal(
          producer.attempt,
          Math.max(
            ...steps
              .filter((step) => step.step_id === producer.step_id)
              .map((step) => step.attempt),
          ),
          'final output cannot fall back to older attempt',
        );
      }
      if (version.steps.some((step) => step.confirmationRequired))
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM workflow_events WHERE workflow_run_id=? AND type='workflow.user_confirmed'",
            )
            .get(run.id).n,
          1,
        );
    }
  }
  for (const id of versions.keys())
    assert.ok(counts[id] >= 3, 'all three acceptance families share this profile');
  assert.equal(
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM workflow_artifact_bindings AS b JOIN workflow_artifacts AS a ON a.id=b.artifact_id WHERE b.workflow_run_id!=a.workflow_run_id',
      )
      .get().n,
    0,
  );
  const assignments = db
    .prepare(
      'SELECT a.*, m.coordinator_teammate_id, m.mode, r.receipt_json FROM routing_mission_assignments AS a JOIN missions AS m ON m.id=a.mission_id JOIN routing_decision_receipts AS r ON r.id=a.receipt_id',
    )
    .all();
  for (const assignment of assignments) {
    const selected = JSON.parse(assignment.assignment_json);
    assert.equal(selected.coordinatorTeammateId, assignment.coordinator_teammate_id);
    assert.equal(selected.mode, assignment.mode);
    assert.deepEqual(JSON.parse(assignment.receipt_json).assignment, selected);
  }
  const dynamic = db
    .prepare(
      "SELECT * FROM workflow_step_operation_receipts WHERE effect_type='WORKSPACE_MUTATION' AND state='VERIFIED'",
    )
    .all();
  for (const operation of dynamic) {
    const journal = db
      .prepare(
        'SELECT * FROM workflow_workspace_mutation_journal WHERE operation_receipt_id=? ORDER BY created_at,id',
      )
      .all(operation.id);
    const paths = new Map();
    for (const entry of journal) {
      assert.equal(entry.state, 'APPLIED');
      const previous = paths.get(entry.relative_path);
      paths.set(entry.relative_path, {
        ...(previous ?? {
          relativePath: entry.relative_path,
          ...(entry.before_hash ? { beforeHash: entry.before_hash } : {}),
        }),
        afterHash: entry.observed_after_hash,
      });
    }
    assert.deepEqual(
      JSON.parse(operation.manifest_json).sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath),
      ),
      [...paths.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      'dynamic receipt manifest exactly covers its journal',
    );
  }
  assert.equal(
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM usage_records AS u JOIN mission_runs AS r ON r.id=u.run_id WHERE u.mission_id!=r.mission_id',
      )
      .get().n,
    0,
  );
  return {
    releases,
    runCounts: counts,
    runs: runs.map((run) => ({ id: run.id, definitionId: run.definition_id, state: run.state })),
    assertions: [
      'frozen release/version/contract hashes',
      'same-run artifact lineage/hash/receipt',
      'present optional outputs validated',
      'checkpointed completed steps',
      'declared decisions and edge/group budgets',
      'all completed side-effect receipts VERIFIED including mixed external actions',
      'final machine validation matches current latest-attempt output state hash',
      'bound routing receipt matches actual Mission coordinator and mode',
      'dynamic mutation manifest exactly matches journal path set and latest hashes',
      'foreign keys and SQLite integrity',
      'usage mission/run attribution',
    ],
  };
}
