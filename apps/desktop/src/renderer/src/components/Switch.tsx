export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  className = '',
  showLabel = true,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <span className={`product-switch-field ${className}`}>
      {showLabel && <span>{label}</span>}
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        className="product-switch"
        onClick={() => onChange(!checked)}
      >
        <span className="product-switch-thumb" />
      </button>
    </span>
  );
}
