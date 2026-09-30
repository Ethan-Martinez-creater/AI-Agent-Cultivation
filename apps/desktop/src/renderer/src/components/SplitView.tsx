import React from 'react';
export function SplitView({
  list,
  children,
  className = '',
}: {
  list: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`product-split-view ${className}`}>
      <aside className="split-view-list">{list}</aside>
      <div className="split-view-detail">{children}</div>
    </div>
  );
}
