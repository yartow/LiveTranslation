import { useEffect } from 'react';
import {
  isTextBiggerChord, isTextSmallerChord, isToggleHeaderChord, isToggleSourceChord, isToggleTargetChord,
  type KeyChord,
} from '@/lib/sermon/hotkeys';

interface LayoutHotkeyHandlers {
  onTextBigger: () => void;
  onTextSmaller: () => void;
  onToggleSource: () => void;
  onToggleTarget: () => void;
  onToggleHeader: () => void;
}

/**
 * Ctrl+= / Ctrl+- (text size), Ctrl+1 / Ctrl+2 (hide a column), Ctrl+3 (collapse the header), each
 * also as Ctrl+Alt+<digit>. Capture phase on window, like useRefreshHotkeys, so they work while a
 * textarea has focus; preventDefault also stops Ctrl+= / Ctrl+- from zooming the browser.
 */
export function useLayoutHotkeys(handlers: LayoutHotkeyHandlers) {
  const { onTextBigger, onTextSmaller, onToggleSource, onToggleTarget, onToggleHeader } = handlers;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const chord: KeyChord = {
        metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
        code: e.code, key: e.key, isComposing: e.isComposing,
      };
      const action =
        isToggleSourceChord(chord) ? onToggleSource
        : isToggleTargetChord(chord) ? onToggleTarget
        : isToggleHeaderChord(chord) ? onToggleHeader
        : isTextBiggerChord(chord) ? onTextBigger
        : isTextSmallerChord(chord) ? onTextSmaller
        : null;
      if (!action) return;
      e.preventDefault(); e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onTextBigger, onTextSmaller, onToggleSource, onToggleTarget, onToggleHeader]);
}
