import React, { useEffect, useState } from 'react';
import type { ModelAvailabilityProjection } from '@cultivation/domain';
import { Icon } from './components/Icon.js';

const labels = {
  UNKNOWN: '尚未检测',
  AVAILABLE: '可用',
  UNSTABLE: '连接不稳定',
  UNAVAILABLE: '不可用',
};

/** Reads current state only. Mounting a view never probes a Provider. */
export function AvailabilityBadge({
  teammateId,
  runtimeProfileId,
  recheck: showRecheck = true,
  compact = false,
  teammateStatus,
  executorKind,
}: {
  teammateId?: string;
  runtimeProfileId?: string;
  recheck?: boolean;
  compact?: boolean;
  teammateStatus?: string;
  executorKind?: string;
}) {
  const [state, setState] = useState<ModelAvailabilityProjection | null>(null);
  const [identity, setIdentity] = useState<{
    id: string;
    status: string;
    executorKind: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setState(null);
    setIdentity(null);
    setError('');
    if (executorKind === 'USER_BRIDGE') return;
    const off = window.cultivation.availability.onChanged((value) => {
      if (
        !disposed &&
        (teammateId ? value.teammateId === teammateId : value.runtimeProfileId === runtimeProfileId)
      )
        setState(value);
    });
    void Promise.all([
      window.cultivation.availability.list(),
      window.cultivation.teammates.list(),
    ]).then(
      ([rows, teammates]) => {
        const owner = teammates.find((row) =>
          teammateId ? row.id === teammateId : row.currentRuntimeProfileId === runtimeProfileId,
        );
        if (!disposed) {
          setIdentity(
            owner
              ? { id: owner.id, status: owner.status, executorKind: owner.executorKind ?? '' }
              : null,
          );
          setState(
            rows.find((row) =>
              teammateId
                ? row.teammateId === teammateId
                : row.runtimeProfileId === runtimeProfileId,
            ) ?? null,
          );
        }
      },
      () => {
        if (!disposed) setError('读取状态失败');
      },
    );
    return () => {
      disposed = true;
      off();
    };
  }, [teammateId, runtimeProfileId, teammateStatus, executorKind]);
  const recheck = async () => {
    const id = teammateId ?? state?.teammateId;
    if (!id || identity?.status !== 'ACTIVE' || identity.executorKind !== 'MODEL_RUNTIME') return;
    setBusy(true);
    setError('');
    try {
      setState(await window.cultivation.availability.recheck(id));
    } catch {
      setError('检测失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  // Unbound Runtime templates have no teammate availability identity.
  if (executorKind === 'USER_BRIDGE' || identity?.executorKind === 'USER_BRIDGE') return null;
  if (teammateStatus === 'ARCHIVED' || identity?.status === 'ARCHIVED')
    return <span className="product-status neutral">已归档</span>;
  if (!identity) return error ? <small role="alert">{error}</small> : null;
  if (identity.executorKind !== 'MODEL_RUNTIME') return null;
  const status = state?.status ?? 'UNKNOWN';
  return (
    <span className="availability-control" data-availability={status} title={labels[status]}>
      <span className={`availability-dot ${status.toLowerCase()}`} aria-hidden="true" />
      {!compact && <span>{labels[status]}</span>}
      {showRecheck && identity.status === 'ACTIVE' && (
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => void recheck()}
        >
          <Icon name="Refresh" size={14} />
          {busy ? '检测中…' : '重新检测'}
        </button>
      )}
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
