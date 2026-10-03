import { createHash, randomUUID } from 'node:crypto';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelRequest, ModelToolResponse } from '@cultivation/application';
import type {
  ToolDescriptor,
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from '@cultivation/domain';
import { isSafeWorkflowRelativePath } from '@cultivation/domain';

export const SOFTWARE_FEATURE_WORKFLOW_ID = 'official.software-feature';

type SoftwareFixtureContext = { detail: WorkflowDetail; step: WorkflowStepRun };
type Resolver = () => SoftwareFixtureContext | null;
type ToolResult = {
  toolCallId: string;
  toolId: string;
  input: Record<string, unknown>;
  ok: boolean;
  content: unknown;
  rawContent: string;
};

const TOOL_ID = {
  read: 'file.readText',
  write: 'file.writeText',
  verify: /(?:^|[/:])verify_repository$/,
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(content: unknown): unknown {
  if (typeof content !== 'string') return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function response(
  request: ModelRequest,
  text: string,
  toolCalls: ModelToolResponse['toolCalls'] = [],
) {
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: request.messages.reduce(
        (total, message) =>
          total + (typeof message.content === 'string' ? message.content.length : 0),
        0,
      ),
      outputTokens: text.length + toolCalls.length,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  };
}

function toolResults(request: ModelRequest): ToolResult[] {
  const calls = new Map<
    string,
    { toolCallId: string; toolId: string; input: Record<string, unknown> }
  >();
  for (const message of request.messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call' && record(part.input))
        calls.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolId: part.toolName,
          input: part.input,
        });
    }
  }
  const results: ToolResult[] = [];
  for (const message of request.messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      const call = calls.get(part.toolCallId);
      if (!call || call.toolId !== part.toolName || part.output.value.toolId !== part.toolName)
        continue;
      results.push({
        ...call,
        ok: part.output.value.ok,
        content: parseJson(part.output.value.content),
        rawContent: part.output.value.content,
      });
    }
  }
  return results;
}

function workflowInput(detail: WorkflowDetail, key: string): unknown {
  return detail.run.inputSnapshot?.[key];
}

function caseKind(detail: WorkflowDetail): 'BUGFIX' | 'MIGRATION' | 'CROSS_LAYER' {
  const objective = String(workflowInput(detail, 'objective') ?? '').toLowerCase();
  if (/case[-_ ]?b|migration|迁移/.test(objective)) return 'MIGRATION';
  if (/case[-_ ]?c|cross[-_ ]?layer|renderer.{0,20}ipc/.test(objective)) return 'CROSS_LAYER';
  return 'BUGFIX';
}

function fallbackPlanFiles(detail: WorkflowDetail): Array<{
  relativePath: string;
  action: 'CREATE' | 'MODIFY';
  acceptanceCriteriaIds: string[];
}> {
  const kind = caseKind(detail);
  if (kind === 'MIGRATION')
    return [
      {
        relativePath: 'migrations/0001_feature.sql',
        action: 'CREATE',
        acceptanceCriteriaIds: ['AC-MIGRATION'],
      },
    ];
  if (kind === 'CROSS_LAYER')
    return [
      { relativePath: 'renderer.ts', action: 'MODIFY', acceptanceCriteriaIds: ['AC-UI'] },
      { relativePath: 'ipc.ts', action: 'MODIFY', acceptanceCriteriaIds: ['AC-IPC'] },
      {
        relativePath: 'store.ts',
        action: 'MODIFY',
        acceptanceCriteriaIds: ['AC-PERSISTENCE'],
      },
    ];
  return [{ relativePath: 'main.js', action: 'MODIFY', acceptanceCriteriaIds: ['AC-BUGFIX'] }];
}

function declaredFiles(detail: WorkflowDetail, step: WorkflowStepRun) {
  const planBinding = detail.bindings.find(
    (binding) =>
      binding.stepRunId === step.id &&
      binding.role === 'INPUT' &&
      ['plan_scope', 'software.plan_scope'].includes(binding.key),
  );
  const planArtifact = detail.artifacts.find((artifact) => artifact.id === planBinding?.artifactId);
  const plan = parseJson(planArtifact?.content);
  const files = record(plan) && Array.isArray(plan.files) ? plan.files : fallbackPlanFiles(detail);
  const normalized = files.flatMap((file) => {
    if (
      !record(file) ||
      typeof file.relativePath !== 'string' ||
      !isSafeWorkflowRelativePath(file.relativePath) ||
      !['CREATE', 'MODIFY'].includes(String(file.action)) ||
      !Array.isArray(file.acceptanceCriteriaIds)
    )
      return [];
    return [
      {
        relativePath: file.relativePath,
        action: file.action as 'CREATE' | 'MODIFY',
        acceptanceCriteriaIds: file.acceptanceCriteriaIds.filter(
          (id): id is string => typeof id === 'string',
        ),
      },
    ];
  });
  if (!normalized.length) throw new Error('W22 fixture requires a bounded accepted plan file list');
  return normalized;
}

function acceptanceCriteria(detail: WorkflowDetail) {
  const artifact = detail.artifacts.find(
    (item) =>
      item.metadata.outputKey === 'software.acceptance' ||
      item.metadata.logicalKey === 'software.acceptance',
  );
  const value = parseJson(artifact?.content);
  if (!record(value) || !Array.isArray(value.criteria))
    return fallbackPlanFiles(detail).flatMap((file) => file.acceptanceCriteriaIds);
  return value.criteria.flatMap((item) =>
    record(item) && typeof item.id === 'string' ? [item.id] : [],
  );
}

function verificationCommandIds(detail: WorkflowDetail, step: WorkflowStepRun): string[] {
  const planArtifact = findInputArtifact(detail, step, ['plan_scope', 'software.plan_scope']);
  const plan = parseJson(planArtifact?.content);
  if (!record(plan) || !Array.isArray(plan.commands)) return ['verify-feature'];
  const ids = plan.commands.flatMap((command) =>
    record(command) && command.required === true && typeof command.id === 'string'
      ? [command.id]
      : [],
  );
  return ids.length > 0 ? ids : ['verify-feature'];
}

function inputsForStep(detail: WorkflowDetail, step: WorkflowStepRun): string[] {
  return detail.bindings
    .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
    .map((binding) => binding.artifactId);
}

function findInputArtifact(detail: WorkflowDetail, step: WorkflowStepRun, keys: readonly string[]) {
  const binding = detail.bindings.find(
    (item) => item.stepRunId === step.id && item.role === 'INPUT' && keys.includes(item.key),
  );
  return detail.artifacts.find((item) => item.id === binding?.artifactId);
}

function reviewValue(detail: WorkflowDetail, step: WorkflowStepRun, verdict: 'PASS' | 'REVISE') {
  const reviewedArtifactIds = inputsForStep(detail, step);
  return {
    verdict,
    findings: verdict === 'PASS' ? [] : ['Implementation plan needs one bounded clarification.'],
    evidence: verdict === 'PASS' ? ['Reviewed frozen inputs and acceptance mapping.'] : [],
    summary: verdict === 'PASS' ? 'Review passed.' : 'A bounded correction is required.',
    reviewedArtifactIds,
  };
}

function outputText(
  definition: WorkflowStepDefinition,
  values: Readonly<Record<string, unknown>>,
): string {
  const textual = definition.outputs.filter(
    (output) => output.kind === 'TEXT' || output.kind === 'JSON',
  );
  if (!textual.length) return JSON.stringify({ ok: true });
  const outputs = Object.fromEntries(
    textual
      .filter((output) => Object.hasOwn(values, output.key))
      .map((output) => [output.key, values[output.key]]),
  );
  if (definition.outputs.length > 1) return JSON.stringify({ outputs });
  const only = textual[0]!;
  if (!Object.hasOwn(outputs, only.key))
    throw new Error(`W2.2 fixture did not produce declared output ${only.key}`);
  return JSON.stringify(outputs[only.key]);
}

function definition(detail: WorkflowDetail, step: WorkflowStepRun): WorkflowStepDefinition {
  const found = detail.version.steps.find((candidate) => candidate.id === step.stepId);
  if (!found) throw new Error(`W2.2 fixture step ${step.stepId} is absent from frozen version`);
  return found;
}

function isCaseA(detail: WorkflowDetail): boolean {
  return caseKind(detail) === 'BUGFIX';
}

function verifierFrom(results: readonly ToolResult[]): ToolResult | undefined {
  return results.find((result) => result.ok && TOOL_ID.verify.test(result.toolId));
}

function verificationPayload(result: ToolResult): Record<string, unknown> | null {
  if (!record(result.content)) return null;
  const structuredContent = record(result.content.structuredContent)
    ? result.content.structuredContent
    : result.content;
  const workflowEvidence = structuredContent.workflowEvidence;
  if (!record(workflowEvidence) || !record(workflowEvidence.verification)) return null;
  return workflowEvidence.verification;
}

/** Deterministic offline AP-007 fixture. Main supplies the persisted active Step only. */
export class SoftwareWorkflowFixtureGateway extends FakeModelGateway {
  constructor(private readonly resolveContext: Resolver) {
    super();
  }

  override async generate(request: ModelRequest) {
    const context = this.resolveContext();
    if (!context || context.detail.version.definition.id !== SOFTWARE_FEATURE_WORKFLOW_ID)
      return super.generate(request);
    if (request.externalWorkContext)
      return {
        ...(await super.generate(request)),
        text: '验收夹具已收到本尊交付，待确定性产物校验。',
      };
    return { ...(await super.generate(request)), text: this.stepOutput(request, context) };
  }

  override async generateWithTools(
    request: Parameters<NonNullable<FakeModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const context = this.resolveContext();
    if (!context || context.detail.version.definition.id !== SOFTWARE_FEATURE_WORKFLOW_ID)
      return super.generateWithTools(request);
    if (request.externalWorkContext)
      return {
        ...(await super.generateWithTools(request)),
        text: '人工交付已接收。',
        toolCalls: [],
      };

    const { detail, step } = context;
    const results = toolResults(request);
    const usage = (text: string, toolCalls: ModelToolResponse['toolCalls'] = []) =>
      response(request, text, toolCalls);
    if (step.stepId === 'S01') {
      const read = results.find((result) => result.ok && result.toolId === TOOL_ID.read);
      if (!read) return this.propose(request, TOOL_ID.read, { path: 'package.json' });
      const packageJson = read.content;
      const scripts =
        record(packageJson) && record(packageJson.scripts) ? packageJson.scripts : null;
      if (!scripts || scripts.test !== 'node verify.mjs')
        throw new Error('W2.2 fixture requires repository-discovered test command node verify.mjs');
      return usage(this.stepOutput(request, context));
    }
    if (step.stepId === 'S05' || step.stepId === 'S10') {
      const plannedFiles = declaredFiles(detail, step);
      const completedWrites = results
        .filter((result) => result.ok && result.toolId === TOOL_ID.write)
        .map((result) => result.input.path)
        .filter((path): path is string => typeof path === 'string');
      const nextFile = plannedFiles.find((file) => !completedWrites.includes(file.relativePath));
      if (nextFile) {
        const content = this.fileContent(detail, step, nextFile.relativePath);
        return this.propose(request, TOOL_ID.write, {
          path: nextFile.relativePath,
          content,
        });
      }
      return usage(this.stepOutput(request, context));
    }
    if (step.stepId === 'S06') {
      const verification = verifierFrom(results);
      if (!verification) {
        const planArtifact = findInputArtifact(detail, step, ['plan_scope', 'software.plan_scope']);
        const plan = parseJson(planArtifact?.content);
        const commands = record(plan) && Array.isArray(plan.commands) ? plan.commands : [];
        const command = commands.find(
          (item) => record(item) && item.required === true && item.command === 'node verify.mjs',
        );
        if (!record(command) || typeof command.id !== 'string')
          throw new Error('W2.2 fixture requires an accepted node verify.mjs plan command');
        const contextArtifact = findInputArtifact(detail, step, [
          'repository_context',
          'software.repo_context',
        ]);
        const repositoryContext = parseJson(contextArtifact?.content);
        const discoveredCommands =
          record(repositoryContext) && Array.isArray(repositoryContext.commands)
            ? repositoryContext.commands
            : [];
        if (
          !discoveredCommands.some(
            (candidate) =>
              record(candidate) &&
              candidate.id === command.id &&
              candidate.command === command.command,
          )
        )
          throw new Error('W2.2 fixture verification command is not present in repository context');
        const tool = request.tools.find((candidate) => TOOL_ID.verify.test(candidate.id));
        if (!tool)
          throw new Error(
            'W2.2 fixture is missing the permission-gated verify_repository MCP tool',
          );
        return this.propose(request, tool.id, {
          commandId: command.id,
          command: 'node verify.mjs',
          acceptanceCriterionIds: Array.isArray(command.acceptanceCriteriaIds)
            ? command.acceptanceCriteriaIds
            : acceptanceCriteria(detail),
        });
      }
      return usage(this.stepOutput(request, context));
    }
    return usage(this.stepOutput(request, context));
  }

  private propose(
    request: ModelRequest & { tools: ToolDescriptor[] },
    toolId: string,
    input: Record<string, unknown>,
  ): ModelToolResponse {
    const tool = request.tools.find((candidate) => candidate.id === toolId);
    if (!tool) throw new Error(`W2.2 fixture cannot find allowed Tool ${toolId}`);
    return response(request, '', [{ id: `w22-${randomUUID()}`, toolId: tool.id, input }]);
  }

  private stepOutput(request: ModelRequest, context: SoftwareFixtureContext): string {
    const { detail, step } = context;
    const stepDefinition = definition(detail, step);
    const kind = caseKind(detail);
    switch (step.stepId) {
      case 'S01': {
        const read = toolResults(request).find(
          (result) => result.ok && result.toolId === TOOL_ID.read,
        );
        const packageJson = read?.content;
        const scripts =
          record(packageJson) && record(packageJson.scripts) ? packageJson.scripts : {};
        return outputText(stepDefinition, {
          'software.repo_context': {
            summary: 'Local repository context collected through ToolRuntime file reads.',
            modules: [{ path: '.', role: 'repository root', relatedPaths: ['package.json'] }],
            changeSurface: fallbackPlanFiles(detail).map((file) => file.relativePath),
            tests: [{ name: 'Bounded offline verifier', path: 'verify.mjs', status: 'PRESENT' }],
            commands:
              scripts.test === 'node verify.mjs'
                ? [
                    {
                      id: 'verify-feature',
                      command: 'node verify.mjs',
                      sourcePath: 'package.json',
                    },
                  ]
                : [],
            risks: [],
            unknowns: [],
          },
        });
      }
      case 'S02': {
        const criteria: Record<string, unknown>[] = fallbackPlanFiles(detail).flatMap((file) =>
          file.acceptanceCriteriaIds.map((id) => ({
            id,
            statement: `The ${id} acceptance behavior is observable in the local repository.`,
            verificationMethod: 'COMMAND',
            commandId: 'verify-feature',
            severity: 'BLOCKING',
          })),
        );
        if (/mixed|混合验收/i.test(String(workflowInput(detail, 'objective'))))
          criteria.push({
            id: 'AC-MANUAL',
            statement: '人工检查新增功能的交付说明。',
            verificationMethod: 'MANUAL',
            severity: 'BLOCKING',
          });
        return outputText(stepDefinition, {
          'software.spec': `# Requirements\n\n目标：${String(workflowInput(detail, 'objective') ?? '')}\n\n# Acceptance Criteria\n\n${criteria.map((item) => `- ${item.id}: ${item.statement}`).join('\n')}\n\n# Constraints\n\n仅修改已批准的 Workspace 范围；不得自动 push、merge、deploy 或 release。\n\n# Out of Scope\n\n不执行计划外文件变更或外部发布操作。`,
          'software.acceptance': { criteria },
        });
      }
      case 'S03': {
        const files = fallbackPlanFiles(detail);
        const criteria = files.flatMap((file) => file.acceptanceCriteriaIds);
        return outputText(stepDefinition, {
          'software.plan': `# Files and Modules\n\n${files.map((file) => `- ${file.relativePath} (${file.action})`).join('\n')}\n\n# Ordered Steps\n\n1. 检查已批准的文件范围。\n2. 通过受权限控制的 Tool 完成实现。\n3. 运行 \`node verify.mjs\` 验证 ${criteria.join('、')}。\n4. 由不同执行者独立审查。\n\n# Test Strategy\n\n执行 plan scope 中的 verify-feature 命令，并逐项关联验收证据。\n\n# Migration Impact\n\n${kind === 'MIGRATION' ? '新增一个限定范围的本地迁移文件。' : '无数据库迁移。'}\n\n# Security and Permission Impact\n\n文件操作继续通过 Workspace boundary、ToolRuntime 与 PermissionEngine。\n\n# Rollback Considerations\n\n依据每次变更记录的 before hash 恢复受影响文件。`,
          'software.plan_scope': {
            files,
            commands: [
              {
                id: 'verify-feature',
                command: 'node verify.mjs',
                acceptanceCriteriaIds: criteria,
                required: true,
              },
            ],
            migrationImpact: kind === 'MIGRATION' ? 'One additive local migration file.' : 'None.',
            securityImpact:
              'Only planned Workspace paths; ToolRuntime and PermissionEngine remain required.',
            rollback: 'Restore the recorded before-hash content for each changed path.',
          },
        });
      }
      case 'S04':
        return outputText(stepDefinition, {
          'software.plan_review': reviewValue(
            detail,
            step,
            isCaseA(detail) && step.attempt === 1 ? 'REVISE' : 'PASS',
          ),
        });
      case 'S05':
        return outputText(stepDefinition, {});
      case 'S06': {
        const result = verifierFrom(toolResults(request));
        const verification = result ? verificationPayload(result) : null;
        if (!result || !verification || !Number.isInteger(verification.exitStatus))
          throw new Error(
            'W2.2 fixture cannot report verification without the MCP execution result',
          );
        const criteria = Array.isArray(verification.acceptanceCriterionIds)
          ? verification.acceptanceCriterionIds.filter(
              (item): item is string => typeof item === 'string',
            )
          : [];
        const executionId = result.toolCallId;
        const execution = {
          commandId: verification.commandId,
          command: verification.command,
          toolId: result.toolId,
          toolExecutionId: executionId,
          exitStatus: verification.exitStatus,
          acceptanceCriteriaIds: criteria,
          outputArtifactId: executionId,
          outputHash: createHash('sha256').update(result.rawContent).digest('hex'),
        };
        return outputText(stepDefinition, {
          'software.tests': {
            executions: [execution],
            criteria: criteria.map((criterionId) => ({
              criterionId,
              status: verification.exitStatus === 0 ? 'PASS' : 'FAIL',
              evidenceArtifactIds: [execution.outputArtifactId],
              executionIds: [executionId],
            })),
            failures:
              verification.exitStatus === 0
                ? []
                : [
                    {
                      executionId,
                      criterionIds: criteria,
                      summary: String(verification.failure ?? 'Verification command failed').slice(
                        0,
                        500,
                      ),
                    },
                  ],
          },
        });
      }
      case 'S08':
        return outputText(stepDefinition, {
          'software.code_review': reviewValue(
            detail,
            step,
            isCaseA(detail) && step.attempt === 1 ? 'REVISE' : 'PASS',
          ),
        });
      case 'S10': {
        const criteria = acceptanceCriteria(detail);
        const commandIds = verificationCommandIds(detail, step);
        return outputText(stepDefinition, {
          'software.fix_summary': {
            summary:
              'Addressed the bounded verifier finding and preserved the accepted plan scope.',
            changedPaths: declaredFiles(detail, step).map((file) => file.relativePath),
            fixes: criteria.map((criterionId) => ({
              criterionId,
              summary: `Applied the bounded correction for ${criterionId}.`,
              verificationCommandIds: commandIds,
            })),
          },
        });
      }
      case 'S11':
        return outputText(stepDefinition, {
          'software.delivery': `# What Changed\n\n已完成：${String(workflowInput(detail, 'objective') ?? '')}\n\n# Files and Modules\n\n${fallbackPlanFiles(
            detail,
          )
            .map((file) => `- ${file.relativePath}`)
            .join(
              '\n',
            )}\n\n# Verification\n\n本地确定性验收命令已执行；结果与验收条件关联。\n\n# Known Limitations\n\n本验收仅覆盖离线 fixture 声明的本地范围。\n\n# Remaining Risks\n\n用户应在目标环境复核业务行为和文件变更。\n\n# Manual Verification\n\n如需人工 UI 或真实设备检查，应由用户另行完成。本流程不会自动执行 Git push、merge、deploy 或 release。`,
        });
      default:
        return response(request, '').text;
    }
  }

  private fileContent(detail: WorkflowDetail, step: WorkflowStepRun, relativePath: string): string {
    const kind = caseKind(detail);
    if (kind === 'BUGFIX') {
      if (step.stepId === 'S05') return 'export const answer = 41;\n';
      return step.attempt === 1
        ? 'export const answer = 42;\n'
        : 'export const answer = 42; // reviewed\n';
    }
    if (kind === 'MIGRATION')
      return '-- Bounded feature migration\nCREATE TABLE IF NOT EXISTS feature_records (id TEXT PRIMARY KEY);\n';
    if (relativePath === 'renderer.ts') return 'export const featureRenderer = true;\n';
    if (relativePath === 'ipc.ts') return "export const featureIpc = 'feature:run';\n";
    if (relativePath === 'store.ts') return 'export const featureStored = true;\n';
    return `export const featureValue = '${relativePath}';\n`;
  }
}
