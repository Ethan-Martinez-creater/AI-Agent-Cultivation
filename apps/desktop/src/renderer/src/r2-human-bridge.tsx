import React, { useEffect, useState } from 'react';
import type {
  CapabilityDimension,
  ExternalAppProfile,
  ExternalWorkArtifact,
  ExternalWorkRequest,
  Teammate,
} from '@cultivation/domain';

export interface HumanBridgeCapabilityView {
  dimension: CapabilityDimension;
  enabled: boolean;
  priorScore: number | null;
  currentScore: number | null;
  source: string | null;
}

export interface HumanBridgeProfileView {
  teammate: Teammate;
  dimensions: HumanBridgeCapabilityView[];
}

export interface ExternalWorkDetailView {
  request: ExternalWorkRequest;
  artifacts: ExternalWorkArtifact[];
}

export interface R2UiApi {
  bridgeProfile(): Promise<HumanBridgeProfileView>;
  updateDisplay(input: {
    name: string;
    avatar: string | null;
    title: string | null;
    description: string;
  }): Promise<Teammate>;
  setCapability(input: {
    dimension: CapabilityDimension;
    enabled: boolean;
  }): Promise<HumanBridgeProfileView>;
  listApps(): Promise<ExternalAppProfile[]>;
  saveApp(input: {
    id?: string;
    name: string;
    vendor: string | null;
    capabilities: CapabilityDimension[];
    notes: string | null;
    enabled: boolean;
  }): Promise<ExternalAppProfile>;
  listRequests(): Promise<ExternalWorkRequest[]>;
  getRequest(id: string): Promise<ExternalWorkDetailView | null>;
  markInProgress(id: string): Promise<ExternalWorkRequest>;
  submitArtifacts(input: {
    requestId: string;
    artifacts: Array<{ targetArtifactId: string; relativePath: string }>;
  }): Promise<ExternalWorkRequest>;
  accept(input: { requestId: string; publicResult?: string }): Promise<unknown>;
  reject(input: { requestId: string; reason?: string }): Promise<unknown>;
  cancel(input: { requestId: string }): Promise<unknown>;
  copyPrompt(id: string): Promise<void>;
  openTargetFolder(id: string): Promise<void>;
  onNavigate(callback: (path: string) => void): () => void;
}

export interface HumanBridgeApprovalInput {
  capability: CapabilityDimension;
  title: string;
  prompt: string;
  requirements: string[];
  targetArtifacts: ArtifactTarget[];
  targetWorkspacePaths: string[];
  acceptanceCriteria: string[];
  externalAppProfileId: string | null;
}

export function HumanBridgeApproval({
  api,
  busy,
  onApprove,
}: {
  api: R2UiApi;
  busy: boolean;
  onApprove: (input: HumanBridgeApprovalInput) => Promise<void>;
}) {
  const [profile, setProfile] = useState<HumanBridgeProfileView | null>(null);
  const [apps, setApps] = useState<ExternalAppProfile[]>([]);
  const [capability, setCapability] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [requirements, setRequirements] = useState('');
  const [artifactName, setArtifactName] = useState('');
  const [extensions, setExtensions] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [criteria, setCriteria] = useState('');
  const [appId, setAppId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api.bridgeProfile(), api.listApps()])
      .then(([nextProfile, nextApps]) => {
        if (!active) return;
        setProfile(nextProfile);
        setApps(nextApps);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const enabled = profile?.dimensions.filter((item) => item.enabled) ?? [];
  return (
    <div className="r2-approval-form">
      <p>
        目标是本尊。请明确选择本次能力并审核完整
        Prompt；不会从任务文本推断能力，也不会调用本尊模型。
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>明确能力</span>
        <select required value={capability} onChange={(event) => setCapability(event.target.value)}>
          <option value="">选择已启用能力</option>
          {enabled.map((entry) => (
            <option key={entry.dimension} value={entry.dimension}>
              {dimensionNames[entry.dimension]}
            </option>
          ))}
        </select>
      </label>
      {enabled.length === 0 && <p className="form-hint">请先在“本尊待办”页面启用至少一项能力。</p>}
      <label className="field">
        <span>任务标题</span>
        <input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span>完整可复制 Prompt</span>
        <textarea
          rows={5}
          maxLength={16000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <label className="field">
        <span>任务要求（每行一条）</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={requirements}
          onChange={(event) => setRequirements(event.target.value)}
        />
      </label>
      <label className="field">
        <span>目标 Artifact 名称</span>
        <input
          maxLength={160}
          value={artifactName}
          onChange={(event) => setArtifactName(event.target.value)}
          placeholder="例如成品图片"
        />
      </label>
      <label className="field">
        <span>允许的扩展名（逗号分隔）</span>
        <input
          maxLength={160}
          value={extensions}
          onChange={(event) => setExtensions(event.target.value)}
          placeholder=".png,.jpg"
        />
      </label>
      <label className="field">
        <span>目标 Workspace 相对目录</span>
        <input
          maxLength={512}
          value={workspacePath}
          onChange={(event) => setWorkspacePath(event.target.value)}
          placeholder="例如 outputs"
        />
      </label>
      <label className="field">
        <span>验收标准（每行一条）</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
        />
      </label>
      <label className="field">
        <span>推荐外部应用（可选）</span>
        <select value={appId} onChange={(event) => setAppId(event.target.value)}>
          <option value="">不指定</option>
          {apps
            .filter(
              (item) =>
                item.enabled && item.capabilities.includes(capability as CapabilityDimension),
            )
            .map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <button
        className="button primary small"
        disabled={
          busy ||
          !capability ||
          !title.trim() ||
          !prompt.trim() ||
          !artifactName.trim() ||
          !extensions.trim() ||
          !criteria.trim()
        }
        onClick={() => {
          const allowedExtensions = extensions
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
          if (
            allowedExtensions.length === 0 ||
            allowedExtensions.some((value) => !/^\.[a-z0-9]{1,12}$/.test(value))
          ) {
            setError('扩展名需为 .png 这样的格式。');
            return;
          }
          setError('');
          void onApprove({
            capability: capability as CapabilityDimension,
            title: title.trim(),
            prompt: prompt.trim(),
            requirements: requirements
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
            targetArtifacts: [
              {
                id: 'artifact-1',
                name: artifactName.trim(),
                required: true,
                allowedExtensions,
                maxSizeBytes: 20 * 1024 * 1024,
              },
            ],
            targetWorkspacePaths: workspacePath.trim() ? [workspacePath.trim()] : [],
            acceptanceCriteria: criteria
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
            externalAppProfileId: appId || null,
          });
        }}
      >
        批准并创建外部工作
      </button>
    </div>
  );
}

const dimensionNames: Record<CapabilityDimension, string> = {
  GENERAL_REASONING: '通用推理',
  LONG_CONTEXT_REASONING: '长文本推理',
  AGENTIC_EXECUTION: '任务执行',
  CODING: '编程',
  TOOL_USE: '工具使用',
  VISUAL_UNDERSTANDING: '视觉理解',
  IMAGE_GENERATION: '图像生成',
  IMAGE_EDITING: '图像编辑',
  VIDEO_GENERATION: '视频生成',
  VIDEO_EDITING: '视频编辑',
  SPEECH_UNDERSTANDING: '语音理解',
  SPEECH_GENERATION: '语音生成',
  SPEECH_TO_SPEECH: '语音转换',
  MUSIC_GENERATION: '音乐生成',
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object' && 'items' in value)
    return stringArray((value as { items: unknown }).items);
  return [];
}

interface ArtifactTarget {
  id: string;
  name: string;
  required: boolean;
  allowedExtensions: string[];
  maxSizeBytes: number;
}

function artifactTargets(request: ExternalWorkRequest): ArtifactTarget[] {
  const source = request.targetArtifactsJson;
  const items =
    source && typeof source === 'object' && 'items' in source
      ? (source as { items: unknown }).items
      : [];
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is ArtifactTarget =>
      !!item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string',
  );
}

const activeStates = new Set(['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED']);

export function HumanBridgePage({ api }: { api: R2UiApi }) {
  const [profile, setProfile] = useState<HumanBridgeProfileView | null>(null);
  const [apps, setApps] = useState<ExternalAppProfile[]>([]);
  const [requests, setRequests] = useState<ExternalWorkRequest[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ExternalWorkDetailView | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [publicResult, setPublicResult] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [appName, setAppName] = useState('');
  const [appVendor, setAppVendor] = useState('');
  const [appDimension, setAppDimension] = useState<CapabilityDimension>('IMAGE_GENERATION');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async (preferredId?: string) => {
    const [nextProfile, nextApps, nextRequests] = await Promise.all([
      api.bridgeProfile(),
      api.listApps(),
      api.listRequests(),
    ]);
    setProfile(nextProfile);
    setApps(nextApps);
    setRequests(nextRequests);
    setDisplayName(nextProfile.teammate.name);
    const id =
      preferredId ||
      selectedId ||
      nextRequests.find((request) => activeStates.has(request.state))?.id ||
      nextRequests[0]?.id ||
      '';
    setSelectedId(id);
    setDetail(id ? await api.getRequest(id) : null);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([api.bridgeProfile(), api.listApps(), api.listRequests()])
      .then(async ([nextProfile, nextApps, nextRequests]) => {
        if (!active) return;
        setProfile(nextProfile);
        setDisplayName(nextProfile.teammate.name);
        setApps(nextApps);
        setRequests(nextRequests);
        const id =
          nextRequests.find((request) => activeStates.has(request.state))?.id ||
          nextRequests[0]?.id ||
          '';
        setSelectedId(id);
        if (id) setDetail(await api.getRequest(id));
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const run = async (action: () => Promise<unknown>, success: string, preferredId?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh(preferredId);
      setNotice(success);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const request = detail?.request;
  const targets = request ? artifactTargets(request) : [];
  const recommendation = apps.find((item) => item.id === request?.externalAppProfileId);
  return (
    <section className="page wide-page">
      <div className="page-heading">
        <p className="eyebrow">本尊 · Human Bridge</p>
        <h1>本尊待办</h1>
        <p>
          外部工作属于独立 Mission Run。你提交的文件被视为不可信数据，后续读取仍需经过工具权限。
        </p>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <div className="form-card">
        <h2>{profile?.teammate.name ?? '本尊 / Human Bridge'}</h2>
        <p>
          系统道友 · USER_BRIDGE · FALLBACK_ONLY · 不绑定模型 Runtime。能力分不能改变 fallback-only
          规则。
        </p>
        <label className="field">
          <span>显示名称</span>
          <input
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || !profile || !displayName.trim()}
          onClick={() =>
            profile &&
            void run(
              () =>
                api.updateDisplay({
                  name: displayName.trim(),
                  avatar: profile.teammate.avatar,
                  title: profile.teammate.title,
                  description: profile.teammate.description,
                }),
              '本尊显示名称已更新。',
            )
          }
        >
          保存显示名称
        </button>
        <h3>可接手能力</h3>
        <p className="muted-copy">
          启用能力的冷启动 prior 为 1。只有真实 ACCEPTED 工作和你的评分才会逐渐调整能力状态。
        </p>
        <div className="r2-capability-grid">
          {profile?.dimensions.map((entry) => (
            <label key={entry.dimension} className="r2-capability-row">
              <input
                type="checkbox"
                disabled={busy}
                checked={entry.enabled}
                onChange={(event) =>
                  void run(
                    () =>
                      api.setCapability({
                        dimension: entry.dimension,
                        enabled: event.target.checked,
                      }),
                    '能力配置已保存。',
                  )
                }
              />
              <span>{dimensionNames[entry.dimension]}</span>
              <small>{entry.enabled ? '已启用 · 固定能力值 1' : '未启用'}</small>
            </label>
          ))}
        </div>
      </div>
      <div className="form-card">
        <h2>外部应用建议</h2>
        <p>只记录应用名称和适用能力，不连接 Provider，也不保存 API Key。</p>
        <div className="r2-inline-form">
          <input
            aria-label="应用名称"
            placeholder="例如 Photoshop"
            maxLength={256}
            value={appName}
            onChange={(event) => setAppName(event.target.value)}
          />
          <input
            aria-label="厂商"
            placeholder="厂商（可选）"
            maxLength={256}
            value={appVendor}
            onChange={(event) => setAppVendor(event.target.value)}
          />
          <select
            aria-label="适用能力"
            value={appDimension}
            onChange={(event) => setAppDimension(event.target.value as CapabilityDimension)}
          >
            {Object.entries(dimensionNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="button secondary"
            disabled={busy || !appName.trim()}
            onClick={() =>
              void run(async () => {
                await api.saveApp({
                  name: appName.trim(),
                  vendor: appVendor.trim() || null,
                  capabilities: [appDimension],
                  notes: null,
                  enabled: true,
                });
                setAppName('');
                setAppVendor('');
              }, '应用建议已保存。')
            }
          >
            添加
          </button>
        </div>
        {apps.length > 0 && (
          <p className="muted-copy">{apps.map((item) => item.name).join(' · ')}</p>
        )}
      </div>
      <div className="r2-work-layout">
        <aside className="list-card">
          <h2>外部工作</h2>
          <p>应用内待办为准；通知失败不影响任务。</p>
          {requests.length === 0 ? (
            <p className="list-empty">
              目前没有待处理的外部工作。可在 Party Mission 中明确委托本尊。
            </p>
          ) : (
            requests.map((item) => (
              <button
                className={`teammate-list-item ${selectedId === item.id ? 'selected' : ''}`}
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  setError('');
                  void api
                    .getRequest(item.id)
                    .then(setDetail)
                    .catch((cause: unknown) => setError(message(cause)));
                }}
              >
                <span className="data-row-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {dimensionNames[item.capability]} · {item.state}
                  </small>
                </span>
              </button>
            ))
          )}
        </aside>
        <div className="form-card">
          {request ? (
            <>
              <p className="eyebrow">
                {request.state} · Mission {request.missionId.slice(0, 8)} · Run{' '}
                {request.runId.slice(0, 8)}
              </p>
              <h2>{request.title}</h2>
              <p>
                请求道友：{request.requesterTeammateId} · 能力：{dimensionNames[request.capability]}
              </p>
              {recommendation && (
                <p>
                  建议应用：{recommendation.name}
                  {recommendation.vendor ? ` · ${recommendation.vendor}` : ''}
                </p>
              )}
              <h3>要求</h3>
              <ul>
                {stringArray(request.requirementsJson).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              <h3>完整 Prompt</h3>
              <pre className="r2-prompt">{request.prompt}</pre>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => api.copyPrompt(request.id), 'Prompt 已复制。', request.id)
                }
              >
                复制 Prompt
              </button>
              <h3>验收标准</h3>
              <ul>
                {stringArray(request.acceptanceCriteriaJson).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              <p>
                目标 Workspace 路径：
                {stringArray(request.targetWorkspacePathsJson).join('、') || '当前 Workspace Root'}
              </p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.openTargetFolder(request.id),
                    '已请求打开目标目录。',
                    request.id,
                  )
                }
              >
                打开目标目录
              </button>
              {(request.state === 'PENDING' || request.state === 'REJECTED') && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api.markInProgress(request.id),
                      request.state === 'REJECTED' ? '已重新开始，可修订提交。' : '已标记开始。',
                      request.id,
                    )
                  }
                >
                  {request.state === 'REJECTED' ? '重新开始' : '标记开始'}
                </button>
              )}
              {request.state === 'IN_PROGRESS' && (
                <div className="r2-artifact-form">
                  <h3>提交 Artifact</h3>
                  {targets.map((target) => (
                    <label className="field" key={target.id}>
                      <span>
                        {target.name}
                        {target.required ? ' · 必填' : ''} · {target.allowedExtensions.join(', ')} ·
                        ≤ {target.maxSizeBytes} bytes
                      </span>
                      <input
                        value={paths[target.id] ?? ''}
                        placeholder="相对于 Workspace Root 的路径"
                        onChange={(event) =>
                          setPaths((old) => ({ ...old, [target.id]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      targets
                        .filter((item) => item.required)
                        .some((item) => !paths[item.id]?.trim())
                    }
                    onClick={() =>
                      void run(
                        () =>
                          api.submitArtifacts({
                            requestId: request.id,
                            artifacts: targets
                              .filter((item) => paths[item.id]?.trim())
                              .map((item) => ({
                                targetArtifactId: item.id,
                                relativePath: paths[item.id]!.trim(),
                              })),
                          }),
                        '提交成功，等待验收。',
                        request.id,
                      )
                    }
                  >
                    提交文件
                  </button>
                </div>
              )}
              {detail.artifacts.length > 0 && (
                <div>
                  <h3>已提交文件</h3>
                  <ul>
                    {detail.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        {artifact.fileName} · {artifact.sizeBytes} bytes
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {request.state === 'SUBMITTED' && (
                <>
                  <label className="field">
                    <span>公开结果摘要（可选，仅发送给协调道友）</span>
                    <textarea
                      maxLength={2000}
                      value={publicResult}
                      onChange={(event) => setPublicResult(event.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.accept({ requestId: request.id, publicResult }),
                        '工作已验收，原 Mission Run 将继续。',
                        request.id,
                      )
                    }
                  >
                    验收并继续
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.reject({ requestId: request.id, reason: '需要重新提交' }),
                        '已退回，可重新提交。',
                        request.id,
                      )
                    }
                  >
                    退回修改
                  </button>
                </>
              )}
              {activeStates.has(request.state) && request.state !== 'SUBMITTED' && (
                <button
                  className="button danger-ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api.cancel({ requestId: request.id }),
                      '外部工作已取消，Mission 将按失败处理。',
                      request.id,
                    )
                  }
                >
                  取消工作
                </button>
              )}
            </>
          ) : (
            <p className="list-empty">选择一项外部工作查看要求和提交进度。</p>
          )}
        </div>
      </div>
    </section>
  );
}
