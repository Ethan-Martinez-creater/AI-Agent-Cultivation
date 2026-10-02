import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

export function Tooltip({ children, text }: { children: ReactNode; text: string }) {
  const id = useId();
  return (
    <span className="tooltip-group">
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
            'aria-describedby': id,
          })
        : children}
      <span id={id} className="product-tooltip" role="tooltip">
        {text}
      </span>
    </span>
  );
}
