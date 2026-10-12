import React, { useState } from 'react';
import type { ArtifactRef } from '@cultivation/domain/g3-execution';
import { Drawer } from './Drawer.js';
import { errorText } from '../ui-shared.js';

/** Selecting a Main-owned result grants only this Run a public Artifact reference. */
export function MissionArtifactSharing({
  missionId,
  runId,
  onShared,
}: {
  missionId: string;
  runId: string;
  onShared: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ArtifactRef[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = async () => {
    setOpen(true);
    setError('');
    setBusy(true);
    try {
      const rows = await window.cultivation.missions.shareableArtifacts();
      setChoices(rows);
      setSelected(rows[0]?.id ?? '');
    } catch (failure) {
      setError(errorText(failure, '读取素材失败'));
    } finally {
      setBusy(false);
    }
  };
  const share = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await window.cultivation.missions.shareArtifact({ missionId, runId, artifactId: selected });
      setOpen(false);
      onShared();
    } catch (failure) {
      setError(errorText(failure, '提供素材失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="secondary" onClick={() => void begin()}>
        提供已有素材
      </button>
      <Drawer open={open} title="提供已有素材" onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={(event) => void share(event)}>
          <label>
            生成结果
            <select
              aria-label="生成结果"
              value={selected}
              disabled={busy}
              onChange={(event) => setSelected(event.target.value)}
            >
              {choices.map((artifact, index) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.kind === 'IMAGE' ? '图片' : artifact.kind === 'AUDIO' ? '音频' : '视频'}
                  结果 {index + 1} · {Math.ceil(artifact.sizeBytes / 1024)} KB
                </option>
              ))}
            </select>
          </label>
          {!busy && choices.length === 0 && <p>暂无已完成的生成结果。</p>}
          <p>仅向本次历练提供所选素材，不授予文件或工具权限。</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || !selected}>
            授权使用素材
          </button>
        </form>
      </Drawer>
    </>
  );
}
