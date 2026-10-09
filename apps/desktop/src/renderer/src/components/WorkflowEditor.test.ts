import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDraft } from '@cultivation/domain';
import {
  addWorkflowDraftStep,
  createDefaultWorkflowDraftContent,
  FinalOutputsEditor,
  removeWorkflowDraftStep,
  updateWorkflowDraftInputSchema,
  WorkflowEditor,
  WorkflowStepEditor,
  type WorkflowEditorApi,
} from './WorkflowEditor.js';

function draftFixture(): WorkflowDraft {
  const content = createDefaultWorkflowDraftContent();
  return {
    id: 'draft-1',
    definitionId: 'user.workflow-1',
    baseVersion: null,
    revision: 1,
    content,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  };
}

const api: WorkflowEditorApi = {
  saveDraft: async (input) => ({
    ...draftFixture(),
    revision: input.expectedRevision + 1,
    content: input.content,
  }),
  reorderDraft: async (input) => ({ ...draftFixture(), revision: input.expectedRevision + 1 }),
  publishDraft: async () => {
    throw new Error('not called during render');
  },
};

describe('WorkflowEditor', () => {
  it('starts with a task, a text result, and user-facing execution settings', () => {
    const content = createDefaultWorkflowDraftContent();
    expect(content.steps).toHaveLength(1);
    expect(content.steps[0]?.type).toBe('TASK');
    expect(content.steps[0]?.routing.requiredCapabilities).toEqual(['GENERAL_REASONING']);
    expect(content.steps[0]?.routing.executionConstraint).toBe('SOLO');
    expect(content.steps[0]?.outputs[0]?.kind).toBe('TEXT');
    expect(content.finalOutputs[0]?.outputKey).toBe('result');
    expect(content.steps[0]?.outputs[0]?.maxSizeBytes).toBeLessThanOrEqual(1_000_000);
  });

  it('adds a bound review step with required review fields and a forward revision path', () => {
    const initial = createDefaultWorkflowDraftContent();
    const withTask = addWorkflowDraftStep(initial, 'TASK');
    const withReview = addWorkflowDraftStep(withTask, 'REVIEW');
    const review = withReview.steps.find((step) => step.type === 'REVIEW')!;
    const revision = withReview.steps.find((step) => step.title === '按审核意见修改')!;
    const reviewOutput = review.outputs.find((output) => output.key === review.reviewOutputKey)!;
    const reviseEdge = withReview.edges.find(
      (item) =>
        item.fromStepId === review.id &&
        item.condition.type === 'REVIEW_VERDICT' &&
        item.condition.verdict === 'REVISE',
    );

    expect(review.exitCondition).toBe('VALID_OUTPUTS');
    expect(review.inputs[0]?.fromStepId).toBe(withTask.steps[1]?.id);
    expect(reviewOutput.validator).toEqual({
      type: 'JSON',
      requiredKeys: ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'],
    });
    expect(reviseEdge?.toStepId).toBe(revision.id);
    expect(withReview.steps.indexOf(revision)).toBeGreaterThan(withReview.steps.indexOf(review));
  });

  it('keeps selected step inputs bound when a top-level input key is renamed', () => {
    const content = addWorkflowDraftStep(createDefaultWorkflowDraftContent(), 'TASK');
    const inputSchema: WorkflowDraft['content']['inputSchema'] = {
      type: 'object',
      properties: {
        taskNote: { type: 'string', minLength: 0, maxLength: 2_000 },
        context: { type: 'string', minLength: 0, maxLength: 2_000 },
      },
      required: ['taskNote'],
    };
    const boundContent = {
      ...content,
      inputSchema,
      steps: content.steps.map((step, index) => ({
        ...step,
        workflowInputKeys: index === 0 ? ['taskNote', 'context'] : ['taskNote'],
      })),
    };
    const renamedSchema = {
      ...inputSchema,
      properties: {
        taskText: inputSchema.properties.taskNote!,
        context: inputSchema.properties.context!,
      },
      required: ['taskText'],
    };

    const updated = updateWorkflowDraftInputSchema(boundContent, renamedSchema);

    expect(Object.keys(updated.inputSchema.properties)).toEqual(['taskText', 'context']);
    expect(updated.steps.map((step) => step.workflowInputKeys)).toEqual([
      ['taskText', 'context'],
      ['taskText'],
    ]);
  });

  it('keeps the final output row identity stable when its name changes', () => {
    const rowKeyFor = (name: string) => {
      const content = createDefaultWorkflowDraftContent();
      content.finalOutputs = [{ ...content.finalOutputs[0]!, key: name }];
      const element = FinalOutputsEditor({ content, onChange: () => undefined });
      const children = (element.props as { children?: React.ReactNode }).children;
      const row = React.Children.toArray(children).find(
        (child) =>
          React.isValidElement(child) &&
          (child.props as { 'data-testid'?: string })['data-testid'] === 'workflow-final-output',
      );

      return React.isValidElement(row) ? row.key : null;
    };

    expect(rowKeyFor('result')).toBe(rowKeyFor('renamed-result'));
  });

  it('keeps removal of a conditional step visible instead of flattening its branches', () => {
    const withReview = addWorkflowDraftStep(createDefaultWorkflowDraftContent(), 'REVIEW');
    const review = withReview.steps.find((step) => step.type === 'REVIEW')!;
    const result = removeWorkflowDraftStep(withReview, review.id);
    expect(result.error).toContain('条件分支');
    expect(result.content).toBe(withReview);
  });

  it('forwards a dragged step index and destination to the reorder action', () => {
    const content = addWorkflowDraftStep(createDefaultWorkflowDraftContent(), 'TASK');
    const onReorder = vi.fn();
    const createCard = (index: number, expanded: boolean) =>
      WorkflowStepEditor({
        content,
        step: content.steps[index]!,
        index,
        saving: false,
        expanded,
        onExpand: () => undefined,
        onChange: () => undefined,
        onReorder,
        onError: () => undefined,
      });
    const sourceCard = createCard(1, false);
    const targetCard = createCard(0, false);
    const detailElement = sourceCard.props.children as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const summary = React.Children.toArray(detailElement.props.children)[0] as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const dragHandle = React.Children.toArray(summary.props.children).find(
      (child) =>
        React.isValidElement(child) &&
        (child.props as { 'data-testid'?: string })['data-testid'] === 'workflow-step-drag-handle',
    ) as React.ReactElement<{ onDragStart: (event: unknown) => void }> | undefined;
    const storedData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      setData: (key: string, value: string) => storedData.set(key, value),
      getData: (key: string) => storedData.get(key) ?? '',
    };
    const startEvent = { dataTransfer };
    dragHandle?.props.onDragStart(startEvent);
    const drop = targetCard.props.onDrop as ((event: unknown) => void) | undefined;
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer,
    };

    drop?.(dropEvent);

    expect(renderToStaticMarkup(sourceCard)).toContain('data-testid="workflow-step-drag-handle"');
    expect(renderToStaticMarkup(sourceCard)).not.toContain('<details open="">');
    expect(storedData.get('text/workflow-step-index')).toBe('1');
    expect(dropEvent.preventDefault).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith(1, 0);
  });

  it('renders accessible structured controls without a raw JSON editor', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkflowEditor, {
        draft: draftFixture(),
        api,
        onCancel: () => undefined,
        onSaved: () => undefined,
        onPublished: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="workflow-editor"');
    expect(html).toContain('data-testid="workflow-name"');
    expect(html).toContain('data-testid="workflow-input-schema-add"');
    expect(html).toContain('data-testid="workflow-step-type"');
    expect(html).toContain('data-testid="workflow-step-title"');
    expect(html).toContain('data-testid="workflow-step-objective"');
    expect(html).toContain('data-testid="workflow-draft-save"');
    expect(html).toContain('data-testid="workflow-draft-publish"');
    expect(html).toContain('自动分配');
    expect(html).toContain('本尊执行');
    expect(html).not.toContain('provider');
    expect(html).not.toContain('textarea aria-label="工作流 JSON"');
  });
});
