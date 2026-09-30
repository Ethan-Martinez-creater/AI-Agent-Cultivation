import React from 'react';
import { Icon } from './Icon.js';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="product-empty-state">
      <span className="empty-state-symbol">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
