import { useEffect } from 'react';

/**
 * Re-run a textarea's auto-grow when its *width* changes. The cells only grow on
 * text changes, but browser zoom, a window resize, the md breakpoint or a webfont
 * loading re-wraps the text without touching it — the fixed `height` then clips
 * the last lines (`overflow-hidden`). Only width is compared, because growing
 * changes the height, which would otherwise re-trigger the observer.
 */
export function useAutoGrowOnResize(ref: React.RefObject<HTMLTextAreaElement>, autoGrow: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      autoGrow();
    });
    ro.observe(el);
    // Fonts arriving late re-wrap text at an unchanged width.
    void document.fonts?.ready.then(autoGrow);
    return () => ro.disconnect();
  }, [ref, autoGrow]);
}
