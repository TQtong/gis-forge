import { HexColorPicker } from 'react-colorful';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

/**
 * Props for the compact hex color picker with popover and manual hex input.
 */
export interface ColorPickerProps {
  /** Current color as `#rrggbb` (or any string shown on the swatch). */
  color: string;
  /** Fires when the user picks a new color (always normalized `#rrggbb` when possible). */
  onChange: (color: string) => void;
  /** Optional accessible label for the swatch button. */
  label?: string;
}

/**
 * Normalize arbitrary hex input to `#rrggbb` or return last valid.
 *
 * @param value - Raw user input.
 * @returns Normalized hex or null if invalid.
 */
function parseHexInput(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    return v.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(v)) {
    return `#${v.toLowerCase()}`;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const h = v.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  return null;
}

/**
 * Small swatch that opens a `react-colorful` hex picker popover; click-outside closes.
 *
 * @param props - {@link ColorPickerProps}
 * @returns Color picker control element.
 */
export function ColorPicker(props: ColorPickerProps): ReactElement {
  const { color, onChange, label } = props;
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(color);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHexDraft(color);
  }, [color]);

  const handleDocMouseDown = useCallback(
    (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el || !open) {
        return;
      }
      if (e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false);
      }
    },
    [open],
  );

  useEffect(() => {
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [handleDocMouseDown]);

  const applyHex = useCallback(
    (next: string) => {
      const parsed = parseHexInput(next);
      if (parsed) {
        onChange(parsed);
        setHexDraft(parsed);
      }
    },
    [onChange],
  );

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label={label ?? '选择颜色'}
        className="h-7 w-10 shrink-0 rounded border border-[var(--border)] bg-[var(--bg-input)] shadow-inner focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ backgroundColor: color }}
        onClick={() => setOpen((o) => !o)}
      />
      {open ? (
        <div
          className="absolute right-0 z-50 mt-1 w-[200px] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] p-2 shadow-lg"
          role="dialog"
          aria-label={label ?? '颜色选择器'}
        >
          <HexColorPicker
            color={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#000000'}
            onChange={(c) => {
              onChange(c);
              setHexDraft(c);
            }}
            style={{ width: '100%', height: '140px' }}
          />
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={() => applyHex(hexDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyHex(hexDraft);
              }
            }}
            className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]"
            aria-label="十六进制颜色"
          />
        </div>
      ) : null}
    </div>
  );
}
