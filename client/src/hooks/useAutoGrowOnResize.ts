import { useEffect } from 'react';

/**
 * Re-run a textarea's auto-grow when its *width* changes. The cells only grow on
 * text changes, but browser zoom, a window resize, the md breakpoint or a webfont
 * loading re-wraps the text without touching it — the fixed `height` then clips
 * the last lines (`overflow-hidden`). Only width is compared, because growing
 * changes the height, which would otherwise re-trigger the observer.
 */
/**
 * Sizes a textarea to its text: height = scrollHeight. scrollHeight is rounded to a whole pixel, and at
 * a fractional zoom / device pixel ratio that can be 1px short, which clips the last line behind
 * whatever sits below (the "check:" chips) — so if it still doesn't fit, grow by the difference.
 */
export function growToFit(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
  const short = el.scrollHeight - el.clientHeight;
  if (short > 0) el.style.height = `${el.scrollHeight + short}px`;
}

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
    window.addEventListener(TEXT_SIZE_EVENT, autoGrow);
    // Browser zoom (Cmd +/-) fires window `resize` and changes devicePixelRatio; the row can wrap
    // differently without this textarea's own width changing, so don't rely on the observer alone.
    window.addEventListener('resize', autoGrow);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', autoGrow);
    return () => {
      ro.disconnect();
      window.removeEventListener(TEXT_SIZE_EVENT, autoGrow);
      window.removeEventListener('resize', autoGrow);
      vv?.removeEventListener('resize', autoGrow);
    };
  }, [ref, autoGrow]);
}

/** Dispatched on `window` when the sermon text size changes: the cells' height is fixed in px, and a font-size change alters neither the text nor the width, so nothing else would re-measure them. */
export const TEXT_SIZE_EVENT = 'sermon-text-size';
