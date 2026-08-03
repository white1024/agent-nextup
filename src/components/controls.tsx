import { useEffect, useRef, type ReactNode } from "react";

// Custom form controls matching the design system (styles.css .check / .switch).
// Both wrap a real <input> so keyboard & a11y semantics stay native.

interface CheckProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Tri-state display for "select all" style checkboxes. */
  indeterminate?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
}

export function Check({
  checked,
  onChange,
  disabled,
  indeterminate,
  ariaLabel,
  children,
}: CheckProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate === true;
    }
  }, [indeterminate]);

  return (
    <label className="check">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="box" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      {children}
    </label>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, disabled, ariaLabel }: SwitchProps) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
    </label>
  );
}
