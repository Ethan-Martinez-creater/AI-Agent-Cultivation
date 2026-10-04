import React, { useEffect, useState } from 'react';
import type { WorkflowInputs, WorkflowObjectSchema } from '@cultivation/domain';
import { WorkflowInputForm, type WorkflowInputPresentation } from './WorkflowInputForm.js';
import type { CultivationBridge } from '../../../preload/preload.js';
const api = () => (window.cultivation as unknown as CultivationBridge).workflows;
type Candidate = {
  id: string;
  kind: 'FILE' | 'EXTERNAL_REFERENCE';
  contentHash: string;
  name: string;
};
type Category = 'SOURCE' | 'DATA' | 'CODE';
const sections = [
  { key: 'existingSources', category: 'SOURCE', label: '已有文献来源' },
  { key: 'existingData', category: 'DATA', label: '已有数据' },
  { key: 'existingCode', category: 'CODE', label: '已有代码' },
] as const;

export function ResearchArtifactPicker({
  label,
  candidates,
  selected,
  busy,
  onChange,
  onImport,
}: {
  label: string;
  candidates: Candidate[];
  selected: Candidate[];
  busy: boolean;
  onChange: (values: Candidate[]) => void;
  onImport?: () => void;
}) {
  return (
    <section className="research-input-artifacts" aria-label={label}>
      <div className="section-heading">
        <h3>{label}</h3>
        {onImport && (
          <button
            className="button secondary small"
            type="button"
            disabled={busy}
            onClick={onImport}
          >
            导入{label === '已有数据' ? '数据' : '代码'}
          </button>
        )}
      </div>
      {candidates.length ? (
        <div className="research-artifact-options">
          {candidates.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="checkbox"
                checked={selected.some((item) => item.id === candidate.id)}
                disabled={
                  busy ||
                  (selected.length >= 12 && !selected.some((item) => item.id === candidate.id))
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, candidate]
                      : selected.filter((item) => item.id !== candidate.id),
                  )
                }
              />
              <span>{candidate.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="workflow-empty-copy">
          {onImport
            ? '尚无已登记资料，可从当前 Workspace 导入。'
            : '尚无可信来源，运行时可通过 Research Tool 或本尊交付获取。'}
        </p>
      )}
    </section>
  );
}
export function ResearchWorkflowInputForm({
  schema,
  presentation,
  busy,
  onSubmit,
  submitError,
}: {
  schema: WorkflowObjectSchema;
  presentation?: WorkflowInputPresentation;
  busy: boolean;
  onSubmit: (inputs: WorkflowInputs) => void | Promise<void>;
  submitError?: string;
}) {
  const [candidates, setCandidates] = useState<Record<Category, Candidate[]>>({
    SOURCE: [],
    DATA: [],
    CODE: [],
  });
  const [selected, setSelected] = useState<Record<string, Candidate[]>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all(
      sections.map(
        async (section) =>
          [section.category, await api().inputCandidates(section.category)] as const,
      ),
    )
      .then((rows) => {
        if (active) setCandidates(Object.fromEntries(rows) as Record<Category, Candidate[]>);
      })
      .catch(() => {
        if (active) setError('读取资料列表失败，请重新打开创建窗口。');
      });
    return () => {
      active = false;
    };
  }, []);
  const importFile = async (category: 'DATA' | 'CODE', key: string) => {
    setPending(true);
    setError('');
    try {
      const value = await api().importInput(category);
      if (value) {
        setCandidates((current) => ({ ...current, [category]: [value, ...current[category]] }));
        setSelected((current) => ({
          ...current,
          [key]: [...(current[key] ?? []), value].slice(0, 12),
        }));
      }
    } catch {
      setError('导入失败，请检查 Workspace、文件大小和读取权限。');
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="research-workflow-input-form">
      {submitError && (
        <p className="workflow-input-error" role="alert">
          {submitError}
        </p>
      )}
      <WorkflowInputForm
        schema={schema}
        presentation={presentation}
        busy={busy || pending}
        excludedFields={sections.map((s) => s.key)}
        onSubmit={async (inputs) => {
          const refs: WorkflowInputs = {};
          for (const section of sections)
            if (selected[section.key]?.length)
              refs[section.key] = selected[section.key]!.map(({ id, kind, name, contentHash }) => ({
                id,
                kind,
                name,
                contentHash,
              }));
          await onSubmit({ ...inputs, ...refs });
        }}
        additionalInputs={
          <>
            <div className="research-input-selectors">
              {sections.map((section) => (
                <ResearchArtifactPicker
                  key={section.key}
                  label={section.label}
                  candidates={candidates[section.category]}
                  selected={selected[section.key] ?? []}
                  busy={busy || pending}
                  onChange={(values) =>
                    setSelected((current) => ({ ...current, [section.key]: values }))
                  }
                  onImport={
                    section.category === 'SOURCE'
                      ? undefined
                      : () => void importFile(section.category, section.key)
                  }
                />
              ))}
            </div>
            {error && <p role="alert">{error}</p>}
          </>
        }
      />
    </div>
  );
}
