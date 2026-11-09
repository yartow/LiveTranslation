import { useCallback, useMemo, useState } from 'react';
import type { SegmentStoreState } from '@/lib/sermon/segment-store';
import { editSuggestions } from '@/lib/sermon/edit-suggestions';

const DISMISSED_KEY = 'cttay_dismissed_suggestions';

/** Glossary suggestions from words corrected by hand (asrText vs sourceText) — never again once dismissed or added. */
export function useEditSuggestions(state: SegmentStoreState) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set<string>(); }
  });
  const dismissSuggestion = useCallback((key: string) => {
    setDismissed(prev => {
      const next = new Set(prev).add(key);
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(next).slice(-500))); } catch { /* optional */ }
      return next;
    });
  }, []);
  const suggestions = useMemo(
    () => editSuggestions(state.ids.map(id => state.byId[id]), dismissed),
    [state, dismissed],
  );
  return { suggestions, dismissSuggestion };
}
