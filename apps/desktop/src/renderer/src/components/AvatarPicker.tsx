import React, { useState } from 'react';
import { Avatar, presetAvatars } from './Avatar.js';
import { Icon } from './Icon.js';

export function AvatarPicker({
  value,
  onChange,
  kind = 'TEAMMATE',
}: {
  value: string | null;
  onChange: (ref: string) => void;
  kind?: 'TEAMMATE' | 'HUMAN_BRIDGE';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await window.cultivation.avatars.import();
      if (result) onChange(result);
    } catch {
      setError('无法导入。请选择有效 PNG、JPEG 或 WebP 图片（最大 2 MB）。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="avatar-picker">
      <legend>头像</legend>
      <div className="avatar-picker-preview">
        <Avatar avatar={value} kind={kind} size={64} />
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void choose()}
        >
          <Icon name="Upload" />
          {busy ? '导入中…' : '从电脑选择'}
        </button>
        <small>PNG / JPEG / WebP · 2 MB</small>
      </div>
      {kind !== 'HUMAN_BRIDGE' && (
        <div className="avatar-preset-grid" aria-label="预置头像">
          {presetAvatars.map((item) => (
            <button
              type="button"
              className={`avatar-preset ${value === item.ref ? 'selected' : ''}`}
              key={item.ref}
              aria-label={item.name}
              aria-pressed={value === item.ref}
              onClick={() => onChange(item.ref)}
            >
              <Avatar avatar={item.ref} name={item.name} size={48} />
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="inline-message error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
