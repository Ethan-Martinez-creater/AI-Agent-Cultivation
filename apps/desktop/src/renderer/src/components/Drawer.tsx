import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon.js';

/** Native modal semantics, focus containment and Escape handling without a framework. */
export function Drawer({
  title,
  open,
  onClose,
  children,
  className = '',
  variant = 'drawer',
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  variant?: 'drawer' | 'dialog';
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.current?.showModal();
    }
    if (!open && dialog.current?.open) {
      dialog.current.close();
      returnFocus.current?.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`product-${variant} ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
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
