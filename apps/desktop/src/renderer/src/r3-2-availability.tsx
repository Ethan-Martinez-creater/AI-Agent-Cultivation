import React, { useEffect, useState } from 'react';
import type { ModelAvailabilityProjection } from '@cultivation/domain';

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
}: {
  teammateId?: string;
  runtimeProfileId?: string;
}) {
  const [state, setState] = useState<ModelAvailabilityProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setState(null);
    setError('');
    const off = window.cultivation.availability.onChanged((value) => {
      if (
        !disposed &&
        (teammateId ? value.teammateId === teammateId : value.runtimeProfileId === runtimeProfileId)
      )
        setState(value);
    });
    void window.cultivation.availability.list().then(
      (rows) => {
        if (!disposed)
          setState(
            rows.find((row) =>
              teammateId
                ? row.teammateId === teammateId
                : row.runtimeProfileId === runtimeProfileId,
            ) ?? null,
          );
      },
      () => {
        if (!disposed) setError('读取状态失败');
      },
    );
    return () => {
      disposed = true;
      off();
    };
  }, [teammateId, runtimeProfileId]);
  const recheck = async () => {
    const id = teammateId ?? state?.teammateId;
    if (!id) return;
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
  if (!teammateId && !state) return null;
  const status = state?.status ?? 'UNKNOWN';
  return (
    <span className="availability-control" data-availability={status}>
      <span className={`availability-dot ${status.toLowerCase()}`} aria-hidden="true" />
      <span>{labels[status]}</span>
      <button className="text-button" type="button" disabled={busy} onClick={() => void recheck()}>
        {busy ? '检测中…' : '重新检测'}
      </button>
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
