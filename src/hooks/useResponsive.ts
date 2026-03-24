import { useEffect, useState } from 'react';
import type { Breakpoint } from '@/types';

/**
 * Resolves the active responsive bucket from two `matchMedia` queries (desktop first, then tablet).
 *
 * @returns Current {@link Breakpoint} for layout decisions.
 */
function resolveBreakpoint(): Breakpoint {
  if (typeof window === 'undefined') {
    return 'mobile';
  }
  if (window.matchMedia('(min-width: 1280px)').matches) {
    return 'desktop';
  }
  if (window.matchMedia('(min-width: 768px)').matches) {
    return 'tablet';
  }
  return 'mobile';
}

/**
 * Subscribes to viewport changes and returns the active layout breakpoint (`desktop` / `tablet` / `mobile`).
 * Uses `window.matchMedia` with `change` listeners and cleans up on unmount.
 *
 * @returns Current breakpoint derived from min-width 1280px (desktop) and 768px (tablet).
 *
 * @example
 * ```tsx
 * const bp = useResponsive();
 * const dense = bp === 'mobile';
 * ```
 */
export function useResponsive(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() => resolveBreakpoint());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mqDesktop = window.matchMedia('(min-width: 1280px)');
    const mqTablet = window.matchMedia('(min-width: 768px)');

    const update = (): void => {
      setBreakpoint(resolveBreakpoint());
    };

    update();

    mqDesktop.addEventListener('change', update);
    mqTablet.addEventListener('change', update);

    return () => {
      mqDesktop.removeEventListener('change', update);
      mqTablet.removeEventListener('change', update);
    };
  }, []);

  return breakpoint;
}
