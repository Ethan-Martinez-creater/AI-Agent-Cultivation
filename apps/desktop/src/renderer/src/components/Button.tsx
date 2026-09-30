import React from 'react';
import { Icon } from './Icon.js';

export function Button({
  variant = 'secondary',
  icon,
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
  icon?: string;
}) {
  return (
    <button type="button" className={`button ${variant} ${className}`} {...props}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
