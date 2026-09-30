import React, { useEffect, useState } from 'react';
import portrait01 from '../assets/avatars/01.png';
import portrait02 from '../assets/avatars/02.png';
import portrait03 from '../assets/avatars/03.png';
import portrait04 from '../assets/avatars/04.png';
import portrait05 from '../assets/avatars/05.png';
import portrait06 from '../assets/avatars/06.png';
import portrait07 from '../assets/avatars/07.png';
import portrait08 from '../assets/avatars/08.png';
import portrait09 from '../assets/avatars/09.png';
import portrait10 from '../assets/avatars/10.png';
import humanBridge from '../assets/avatars/human-bridge.png';
import user from '../assets/avatars/user.png';

export const presetAvatars = [
  portrait01,
  portrait02,
  portrait03,
  portrait04,
  portrait05,
  portrait06,
  portrait07,
  portrait08,
  portrait09,
  portrait10,
].map((src, index) => ({
  ref: `preset:${String(index + 1).padStart(2, '0')}`,
  src,
  name: `人物 ${index + 1}`,
}));

/** Local references are resolved by Main; arbitrary file/HTTP URLs never become image sources. */
export function Avatar({
  avatar,
  name = '道友',
  kind = 'TEAMMATE',
  size = 40,
  className = '',
}: {
  avatar?: string | null;
  name?: string;
  kind?: 'TEAMMATE' | 'HUMAN_BRIDGE' | 'USER';
  size?: number;
  className?: string;
}) {
  const defaultIndex =
    [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % presetAvatars.length;
  const bundled =
    kind === 'HUMAN_BRIDGE'
      ? humanBridge
      : kind === 'USER'
        ? user
        : avatar
          ? presetAvatars.find((item) => item.ref === avatar)?.src
          : presetAvatars[defaultIndex]?.src;
  const [local, setLocal] = useState<{ ref: string; src: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setLocal(null);
    if (kind === 'TEAMMATE' && avatar?.startsWith('local:')) {
      void window.cultivation.avatars.read(avatar).then(
        (src) => {
          if (active && src) setLocal({ ref: avatar, src });
        },
        () => {
          if (active) setFailed(true);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [avatar, kind]);
  const source = bundled ?? (local && local.ref === avatar ? local.src : undefined);
  return (
    <span
      className={`object-avatar avatar-size-${size} ${className}`}
      role="img"
      aria-label={kind === 'USER' ? '用户头像' : `${name}头像`}
    >
      {source && !failed ? (
        <img src={source} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="avatar-fallback">{name.slice(0, 1)}</span>
      )}
    </span>
  );
}
