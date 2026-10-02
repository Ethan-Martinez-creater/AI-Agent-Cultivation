import { describe, expect, it } from 'vitest';
import type {
  ArtifactContract,
  WorkflowArtifactSpec,
  WorkflowStepDefinition,
  WorkflowVersion,
} from '@cultivation/domain';
import {
  validateArtifactContract,
  validateArtifactContractDefinition,
  validateWorkflowVersion,
  W2_ARTIFACT_VALIDATOR_VERSION,
} from '@cultivation/domain';
import {
  ArtifactContractRegistry,
  BuiltinWorkflowRegistry,
  builtinWorkflowManifestHash,
  validateBuiltinWorkflowRelease,
  validateWorkflowReviewResult,
} from './w2-contracts.js';

const at = '2026-10-01T00:00:00.000Z';

const jsonContract: ArtifactContract = {
  contractId: 'result-json',
  contractVersion: '1',
  kind: 'JSON',
  validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
  maxSizeBytes: 4096,
  validator: {
    type: 'JSON_SCHEMA',
    schema: {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string', minLength: 1, maxLength: 40 } },
    },
  },
};

function artifactSpec(
  key: string,
  overrides: Partial<WorkflowArtifactSpec> = {},
): WorkflowArtifactSpec {
  return {
    key,
    kind: 'JSON',
    required: true,
    contractId: jsonContract.contractId,
    contractVersion: jsonContract.contractVersion,
    maxSizeBytes: jsonContract.maxSizeBytes,
    description: `Contract for ${key}`,
    validator: {
      type: 'REGISTRY',
      contractId: jsonContract.contractId,
      contractVersion: jsonContract.contractVersion,
    },
    ...overrides,
  };
}

function step(
  id: string,
  type: 'TASK' | 'REVIEW' | 'DECISION' = 'TASK',
  overrides: Partial<WorkflowStepDefinition> = {},
): WorkflowStepDefinition {
  return {
    id,
    type,
    title: id,
    objective: `Handle ${id}`,
    routing: {},
    inputs: [],
    outputs: [],
    maxAttempts: 2,
    exitCondition: type === 'REVIEW' ? 'REVIEW_PASS' : 'VALID_OUTPUTS',
    effectType: 'NONE',
    ...overrides,
  };
}

function builtinVersion(): WorkflowVersion {
  const contractRef = {
    contractId: jsonContract.contractId,
    contractVersion: jsonContract.contractVersion,
  };
  return {
    definition: {
      id: 'builtin-test-workflow',
      name: 'Test Builtin',
      description: '',
      category: 'test',
      source: 'BUILTIN',
    },
    version: 1,
    entryStepId: 'write',
    steps: [step('write', 'TASK', { outputs: [artifactSpec('result')] })],
    edges: [],
    referenceBasis: [],
    createdAt: at,
    contractManifest: [jsonContract],
    revisionGroups: [],
    releaseMetadata: {
      referenceBasis: [
        {
          title: 'Test process guide',
          adoptedPrinciples: ['Keep the output schema explicit'],
          intentionallyExcludedMechanisms: ['Vendor-bound execution hooks'],
          rationale: 'The fixture exercises release provenance and exact manifest checks.',
        },
      ],
      contractManifest: [contractRef],
      revisionManifest: { groups: [], edges: [] },
      effectManifest: [{ stepId: 'write', effectType: 'NONE', paths: [] }],
      designRationale: 'A deterministic test-only release fixture.',
    },
  };
}

function reviewVersion(multiTarget = false): WorkflowVersion {
  const reviewOutput: WorkflowArtifactSpec = {
    key: 'review',
    kind: 'JSON',
    required: true,
    contractId: 'review-inline',
    contractVersion: '1',
    maxSizeBytes: 4096,
    description: 'Review result',
    validator: { type: 'JSON', requiredKeys: ['verdict'] },
  };
  const reviseEdges = multiTarget
    ? [
        {
          id: 'revise-spec',
          fromStepId: 'review',
          toStepId: 'fix-spec',
          branch: 'revise-spec',
          condition: { type: 'REVIEW_VERDICT' as const, verdict: 'REVISE' as const },
          revision: { groupId: 'review-cycle', maxTraversals: 2 },
          revisionCode: 'fix_spec',
        },
        {
          id: 'revise-evidence',
          fromStepId: 'review',
          toStepId: 'fix-evidence',
          branch: 'revise-evidence',
          condition: { type: 'REVIEW_VERDICT' as const, verdict: 'REVISE' as const },
          revision: { groupId: 'review-cycle', maxTraversals: 2 },
          revisionCode: 'fix_evidence',
        },
      ]
    : [
        {
          id: 'revise',
          fromStepId: 'review',
          toStepId: 'fix',
          branch: 'revise',
          condition: { type: 'REVIEW_VERDICT' as const, verdict: 'REVISE' as const },
          revision: { groupId: 'review-cycle', maxTraversals: 2 },
        },
      ];
  const fixes = multiTarget ? ['fix-spec', 'fix-evidence'] : ['fix'];
  return {
    definition: {
      id: 'review-test-workflow',
      name: 'Review Test',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    entryStepId: 'review',
    steps: [
      step('review', 'REVIEW', { outputs: [reviewOutput] }),
      ...fixes.map((id) => step(id)),
      step('complete'),
    ],
    edges: [
      ...reviseEdges,
      {
        id: 'pass',
        fromStepId: 'review',
        toStepId: 'complete',
        branch: 'pass',
        condition: { type: 'REVIEW_VERDICT' as const, verdict: 'PASS' as const },
      },
      {
        id: 'fail',
        fromStepId: 'review',
        toStepId: null,
        branch: 'fail',
        condition: { type: 'REVIEW_VERDICT' as const, verdict: 'FAIL' as const },
      },
      ...fixes.map((id) => ({
        id: `${id}-review`,
        fromStepId: id,
        toStepId: 'review',
        branch: 'review-again',
        condition: { type: 'ALWAYS' as const },
      })),
    ],
    referenceBasis: [],
    createdAt: at,
    contractManifest: [],
    revisionGroups: [{ id: 'review-cycle', maxTotalTraversals: 3, onExhausted: 'WAITING_USER' }],
  };
}

function decisionRevisionVersion(requiredInput = true): WorkflowVersion {
  const reviewOutput: WorkflowArtifactSpec = {
    key: 'review',
    kind: 'JSON',
    required: true,
    contractId: 'review-inline',
    contractVersion: '1',
    maxSizeBytes: 4096,
    description: 'Review result',
    validator: { type: 'JSON', requiredKeys: ['verdict'] },
  };
  return {
    definition: {
      id: 'decision-revision-workflow',
      name: 'Decision Revision',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    entryStepId: 'review',
    steps: [
      step('review', 'REVIEW', { outputs: [reviewOutput] }),
      step('decision', 'DECISION', {
        inputs: [
          {
            key: 'reviewResult',
            fromStepId: 'review',
            outputKey: 'review',
            required: requiredInput,
          },
        ],
      }),
      step('fix'),
      step('complete'),
    ],
    edges: [
      {
        id: 'to-decision',
        fromStepId: 'review',
        toStepId: 'decision',
        branch: 'next',
        condition: { type: 'ALWAYS' },
      },
      {
        id: 'decision-revise',
        fromStepId: 'decision',
        toStepId: 'fix',
        branch: 'revise',
        condition: {
          type: 'JSON_FIELD_EQUALS',
          inputKey: 'reviewResult',
          field: 'verdict',
          equals: 'REVISE',
        },
        revision: { groupId: 'decision-cycle', maxTraversals: 2 },
      },
      {
        id: 'decision-pass',
        fromStepId: 'decision',
        toStepId: 'complete',
        branch: 'pass',
        condition: {
          type: 'JSON_FIELD_EQUALS',
          inputKey: 'reviewResult',
          field: 'verdict',
          equals: 'PASS',
        },
      },
      {
        id: 'retry',
        fromStepId: 'fix',
        toStepId: 'decision',
        branch: 'retry',
        condition: { type: 'ALWAYS' },
      },
    ],
    referenceBasis: [],
    createdAt: at,
    contractManifest: [],
    revisionGroups: [{ id: 'decision-cycle', maxTotalTraversals: 3, onExhausted: 'FAILED' }],
  };
}

describe('W2 Artifact Contracts', () => {
  it('validates closed JSON schemas against real content without coercion', () => {
    expect(
      validateArtifactContract(jsonContract, {
        kind: 'JSON',
        content: '{"answer":"ready"}',
      }),
    ).toEqual([]);
    expect(
      validateArtifactContract(jsonContract, {
        kind: 'JSON',
        content: '{"answer":42}',
      }),
    ).toContain('JSON_SCHEMA_MISMATCH');
    expect(
      validateArtifactContract(jsonContract, {
        kind: 'JSON',
        content: '{"answer":"ready","unexpected":true}',
      }),
    ).toContain('JSON_SCHEMA_MISMATCH');
  });

  it('validates bounded text rules and actual file metadata', () => {
    const text: ArtifactContract = {
      contractId: 'summary',
      contractVersion: '1',
      kind: 'TEXT',
      validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
      maxSizeBytes: 1024,
      validator: { type: 'TEXT_RULES', minLength: 8, requiredSections: ['## Result'] },
    };
    expect(validateArtifactContract(text, { kind: 'TEXT', content: '## Result\nDone.' })).toEqual(
      [],
    );
    expect(validateArtifactContract(text, { kind: 'TEXT', content: 'Short.' })).toEqual([
      'TEXT_TOO_SHORT',
      'MISSING_REQUIRED_SECTION',
    ]);

    const file: ArtifactContract = {
      contractId: 'rendered-pdf',
      contractVersion: '1',
      kind: 'FILE',
      validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
      maxSizeBytes: 4096,
      validator: {
        type: 'FILE_METADATA',
        allowedExtensions: ['.pdf'],
        allowedMediaTypes: ['application/pdf'],
        requireContentHash: true,
      },
    };
    expect(
      validateArtifactContract(file, {
        kind: 'FILE',
        content: '',
        metadata: {
          sizeBytes: 200,
          extension: '.pdf',
          mediaType: 'application/pdf',
          relativePath: 'exports/final.pdf',
          contentHash: 'a'.repeat(64),
        },
      }),
    ).toEqual([]);
    expect(
      validateArtifactContract(file, {
        kind: 'FILE',
        content: '',
        contentHash: 'b'.repeat(64),
        metadata: {
          sizeBytes: 200,
          extension: '.pdf',
          mediaType: 'application/pdf',
          relativePath: '../outside.pdf',
        },
      }),
    ).toEqual(['INVALID_CONTENT_HASH', 'INVALID_RELATIVE_PATH']);
  });

  it('validates workspace manifests with bounded declared paths and before/after hashes', () => {
    const workspace: ArtifactContract = {
      contractId: 'workspace-changes',
      contractVersion: '2',
      kind: 'WORKSPACE',
      validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
      maxSizeBytes: 4096,
      validator: {
        type: 'WORKSPACE_MANIFEST',
        maxEntries: 4,
        allowedPaths: ['src/app.ts'],
        requireBeforeHash: true,
      },
    };
    expect(
      validateArtifactContract(workspace, {
        kind: 'DIRECTORY',
        content: JSON.stringify({
          entries: [
            {
              relativePath: 'src/app.ts',
              beforeHash: 'a'.repeat(64),
              afterHash: 'b'.repeat(64),
            },
          ],
        }),
      }),
    ).toEqual([]);
    expect(
      validateArtifactContract(workspace, {
        kind: 'DIRECTORY',
        content: JSON.stringify({
          entries: [{ relativePath: '../app.ts', afterHash: 'b'.repeat(64) }],
        }),
      }),
    ).toEqual(['INVALID_MANIFEST_PATH', 'MISSING_BEFORE_HASH']);
  });

  it('bounds directory manifest text and the declared total file size separately', () => {
    const directory: ArtifactContract = {
      contractId: 'source-bundle',
      contractVersion: '1',
      kind: 'DIRECTORY',
      validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
      maxSizeBytes: 50,
      validator: {
        type: 'DIRECTORY_MANIFEST',
        maxEntries: 4,
        requireHashes: true,
      },
    };
    const validManifest = JSON.stringify({
      entries: [{ relativePath: 'src/main.ts', contentHash: 'a'.repeat(64), sizeBytes: 50 }],
    });
    expect(
      validateArtifactContract(directory, { kind: 'DIRECTORY', content: validManifest }),
    ).toEqual([]);
    expect(
      validateArtifactContract(directory, {
        kind: 'DIRECTORY',
        content: JSON.stringify({
          entries: [{ relativePath: 'src/main.ts', contentHash: 'a'.repeat(64), sizeBytes: 51 }],
        }),
      }),
    ).toContain('MANIFEST_TOTAL_SIZE_LIMIT');
  });

  it('rejects unknown validator versions and freezes registered contract versions', () => {
    expect(() =>
      validateArtifactContractDefinition({
        ...jsonContract,
        validatorVersion: 'future-unknown-interpreter',
      }),
    ).toThrow();
    const registry = new ArtifactContractRegistry();
    const saved = registry.register(jsonContract);
    expect(registry.get(jsonContract.contractId, jsonContract.contractVersion)).toBe(saved);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.validator)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(false);
    expect(() =>
      registry.register({ ...jsonContract, maxSizeBytes: jsonContract.maxSizeBytes - 1 }),
    ).toThrow();
  });
});

describe('W2 bounded revision and release contracts', () => {
  it('allows explicit bounded REVIEW loops and rejects unmarked cycles', () => {
    const version = reviewVersion();
    expect(() => validateWorkflowVersion(version)).not.toThrow();
    const unmarked = structuredClone(version);
    delete unmarked.edges[0]!.revision;
    expect(() => validateWorkflowVersion(unmarked)).toThrow();
  });

  it('allows required-input DECISION revisions and requires each declared edge to close a loop', () => {
    expect(() => validateWorkflowVersion(decisionRevisionVersion())).not.toThrow();
    expect(() => validateWorkflowVersion(decisionRevisionVersion(false))).toThrow();
    const noLoop = decisionRevisionVersion();
    noLoop.edges[noLoop.edges.length - 1]!.toStepId = 'complete';
    expect(() => validateWorkflowVersion(noLoop)).toThrow();
  });

  it('rejects an ordinary cycle hidden behind a declared revision edge', () => {
    const version = decisionRevisionVersion();
    const reviewOutput = version.steps.find((item) => item.id === 'review')!.outputs[0]!;
    const fix = version.steps.find((item) => item.id === 'fix')!;
    fix.type = 'DECISION';
    fix.inputs = [
      { key: 'reviewResult', fromStepId: 'review', outputKey: reviewOutput.key, required: true },
    ];
    version.edges[version.edges.length - 1]!.condition = {
      type: 'JSON_FIELD_EQUALS',
      inputKey: 'reviewResult',
      field: 'verdict',
      equals: 'REVISE',
    };
    version.steps.push(step('ordinary-loop'));
    version.edges.push(
      {
        id: 'enter-ordinary-loop',
        fromStepId: 'fix',
        toStepId: 'ordinary-loop',
        branch: 'ordinary-loop',
        condition: {
          type: 'JSON_FIELD_EQUALS',
          inputKey: 'reviewResult',
          field: 'verdict',
          equals: 'LOOP',
        },
      },
      {
        id: 'ordinary-self-loop',
        fromStepId: 'ordinary-loop',
        toStepId: 'ordinary-loop',
        branch: 'loop',
        condition: { type: 'ALWAYS' },
      },
    );
    expect(() => validateWorkflowVersion(version)).toThrow();
  });

  it('keeps legacy W1 file effects valid while treating W2 fields as requiring a contract manifest', () => {
    const legacy: WorkflowVersion = {
      definition: {
        id: 'legacy-file-effect',
        name: 'Legacy file effect',
        description: '',
        category: 'test',
        source: 'USER',
      },
      version: 1,
      entryStepId: 'write',
      steps: [step('write', 'TASK', { effectType: 'FILE_OUTPUT' })],
      edges: [],
      referenceBasis: [],
      createdAt: at,
    };
    expect(() => validateWorkflowVersion(legacy)).not.toThrow();
    expect(() => validateWorkflowVersion({ ...legacy, revisionGroups: [] })).toThrow();
    expect(() => validateWorkflowVersion({ ...legacy, contractManifest: [] })).toThrow();
  });

  it('allows multiple Artifacts to reference one frozen Contract version', () => {
    const version: WorkflowVersion = {
      definition: {
        id: 'shared-contract-workflow',
        name: 'Shared contract',
        description: '',
        category: 'test',
        source: 'USER',
      },
      version: 1,
      entryStepId: 'write',
      steps: [
        step('write', 'TASK', {
          outputs: [artifactSpec('first'), artifactSpec('second')],
        }),
      ],
      edges: [],
      referenceBasis: [],
      createdAt: at,
      contractManifest: [jsonContract],
    };
    expect(() => validateWorkflowVersion(version)).not.toThrow();
  });

  it('requires unique static codes for multi-target REVIEW revisions', () => {
    const version = reviewVersion(true);
    expect(() => validateWorkflowVersion(version)).not.toThrow();
    const duplicate = structuredClone(version);
    duplicate.edges[1]!.revisionCode = duplicate.edges[0]!.revisionCode;
    expect(() => validateWorkflowVersion(duplicate)).toThrow();
    const undeclared = structuredClone(version);
    delete undeclared.edges[0]!.revisionCode;
    expect(() => validateWorkflowVersion(undeclared)).toThrow();
  });

  it('binds a multi-target REVIEW result to its declared static revision code', () => {
    const version = reviewVersion(true);
    const base = {
      verdict: 'REVISE',
      findings: ['Add an evidence source'],
      evidence: ['source-1'],
      summary: 'The current draft needs another pass.',
      reviewedArtifactIds: ['artifact-1'],
    };
    expect(
      validateWorkflowReviewResult({ ...base, revisionCode: 'fix_evidence' }, version, 'review')
        .revisionCode,
    ).toBe('fix_evidence');
    expect(() => validateWorkflowReviewResult(base, version, 'review')).toThrow();
    expect(() =>
      validateWorkflowReviewResult({ ...base, revisionCode: 'some-other-step' }, version, 'review'),
    ).toThrow();
    expect(() =>
      validateWorkflowReviewResult(
        { ...base, verdict: 'PASS', revisionCode: 'fix_evidence' },
        version,
        'review',
      ),
    ).toThrow();
  });

  it('requires safe declared effect paths only on W2 versions', () => {
    const version: WorkflowVersion = {
      definition: {
        id: 'effect-test',
        name: 'Effects',
        description: '',
        category: 'test',
        source: 'USER',
      },
      version: 1,
      entryStepId: 'write',
      steps: [
        step('write', 'TASK', {
          effectType: 'FILE_OUTPUT',
          effectPaths: ['dist/result.txt'],
        }),
      ],
      edges: [],
      referenceBasis: [],
      createdAt: at,
      contractManifest: [],
    };
    expect(() => validateWorkflowVersion(version)).not.toThrow();
    const unsafe = structuredClone(version);
    unsafe.steps[0]!.effectPaths = ['../outside.txt'];
    expect(() => validateWorkflowVersion(unsafe)).toThrow();
  });

  it('isolates explicit test-only builtins and verifies exact frozen manifests', () => {
    expect(new BuiltinWorkflowRegistry().list()).toEqual([]);
    const version = builtinVersion();
    expect(() => new BuiltinWorkflowRegistry().register({ kind: 'TEST_ONLY', version })).toThrow();
    const registry = new BuiltinWorkflowRegistry({ testOnly: true });
    const released = registry.register({ kind: 'TEST_ONLY', version });
    expect(released.releaseMetadata?.manifestHash).toBe(builtinWorkflowManifestHash(released));
    expect(validateBuiltinWorkflowRelease(released)).toBe(released.releaseMetadata?.manifestHash);
    expect(Object.isFrozen(released.contractManifest)).toBe(true);
    expect(Object.isFrozen(released.contractManifest?.[0]?.validator)).toBe(true);
    const badEffectManifest = structuredClone(version);
    badEffectManifest.releaseMetadata!.effectManifest[0]!.paths = ['unlisted.txt'];
    expect(() =>
      validateBuiltinWorkflowRelease(badEffectManifest, { requireManifestHash: false }),
    ).toThrow();
    const tampered = structuredClone(released);
    const actualHash = tampered.releaseMetadata!.manifestHash!;
    tampered.releaseMetadata!.manifestHash = actualHash.startsWith('a')
      ? 'b'.repeat(64)
      : 'a'.repeat(64);
    expect(() => validateBuiltinWorkflowRelease(tampered)).toThrow();
  });

  it('registers static OFFICIAL packages in production and deeply freezes the verified copy', () => {
    const input = builtinVersion();
    const registry = new BuiltinWorkflowRegistry({
      packages: [{ kind: 'OFFICIAL', version: input }],
    });
    const released = registry.get(input.definition.id, 1)!;
    expect(validateBuiltinWorkflowRelease(released)).toBe(builtinWorkflowManifestHash(released));
    expect(registry.getPackage(input.definition.id, 1)?.kind).toBe('OFFICIAL');
    expect(Object.isFrozen(registry.getPackage(input.definition.id, 1))).toBe(true);
    expect(Object.isFrozen(released.releaseMetadata?.referenceBasis[0]?.adoptedPrinciples)).toBe(
      true,
    );
    input.steps[0]!.objective = 'Changed after registration';
    expect(released.steps[0]!.objective).not.toBe(input.steps[0]!.objective);
    expect(() => registry.register({ kind: 'OFFICIAL', version: builtinVersion() })).toThrow();
  });

  it.each(['USER', 'IMPORTED'] as const)(
    'rejects %s packages before official registration',
    (source) => {
      const version = builtinVersion();
      version.definition.source = source;
      expect(
        () => new BuiltinWorkflowRegistry({ packages: [{ kind: 'OFFICIAL', version }] }),
      ).toThrow();
    },
  );

  it('rejects tampered or incomplete OFFICIAL manifests in production', () => {
    const version = builtinVersion();
    version.releaseMetadata!.manifestHash = 'a'.repeat(64);
    expect(
      () => new BuiltinWorkflowRegistry({ packages: [{ kind: 'OFFICIAL', version }] }),
    ).toThrow();
    delete version.releaseMetadata;
    expect(
      () => new BuiltinWorkflowRegistry({ packages: [{ kind: 'OFFICIAL', version }] }),
    ).toThrow();
    expect(
      () =>
        new BuiltinWorkflowRegistry({
          packages: [{ kind: 'TEST_ONLY', version: builtinVersion() }],
        }),
    ).toThrow();
  });
});
