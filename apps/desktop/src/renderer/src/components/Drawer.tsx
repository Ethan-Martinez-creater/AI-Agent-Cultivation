import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon.js';

/** Native modal semantics, focus containment and Escape handling without a framework. */
export function Drawer({
  title,
  open,
  onClose,
  children,
  className = '',
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`product-drawer ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="drawer-heading">
        <h2>{title}</h2>
        <button className="icon-button" type="button" aria-label="关闭面板" onClick={onClose}>
          <Icon name="Close" />
        </button>
      </header>
      <div className="drawer-content">{children}</div>
    </dialog>
  );
}
