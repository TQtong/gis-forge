import { useEffect, useState } from 'react';

/** Media query for reduced UI motion (OS accessibility setting). */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Media query for high contrast preference. */
const HIGH_CONTRAST_QUERY = '(prefers-contrast: more)';

/**
 * Reads prefers-reduced-motion and prefers-contrast from `matchMedia` and keeps them in sync.
 *
 * @returns Flags for motion reduction and high contrast.
 */
export function useA11y(): { reduceMotion: boolean; highContrast: boolean } {
  const [reduceMotion, setReduceMotion] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(REDUCED_MOTION_QUERY).matches : false,
  );
  const [highContrast, setHighContrast] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(HIGH_CONTRAST_QUERY).matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const mqMotion = window.matchMedia(REDUCED_MOTION_QUERY);
    const mqContrast = window.matchMedia(HIGH_CONTRAST_QUERY);

    const onMotion = (): void => {
      setReduceMotion(mqMotion.matches);
    };
    const onContrast = (): void => {
      setHighContrast(mqContrast.matches);
    };

    onMotion();
    onContrast();

    mqMotion.addEventListener('change', onMotion);
    mqContrast.addEventListener('change', onContrast);

    return () => {
      mqMotion.removeEventListener('change', onMotion);
      mqContrast.removeEventListener('change', onContrast);
    };
  }, []);

  return { reduceMotion, highContrast };
}
