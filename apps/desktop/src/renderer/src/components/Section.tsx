import React from 'react';
import { Icon } from './Icon.js';
export function Section({
  title,
  icon,
  action,
  children,
  className = '',
}: {
  title: string;
  icon?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`product-section ${className}`}>
      <header className="section-heading">
        <h2>
          {icon && <Icon name={icon} />}
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}
