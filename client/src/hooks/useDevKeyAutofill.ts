import { useEffect } from 'react';
import type { AppSettings } from './useSettings';

/**
 * In development, fills API keys that are still empty from the server's .env
 * (GET /api/dev-config — 403 in production and for non-loopback callers), so
 * you don't have to retype them every session. Never overwrites a key you set.
 * Used by every page that owns a settings instance, since either can be the
 * first one opened (Sermon mode is "/", Live mode is "/live").
 */
export function useDevKeyAutofill(
  settings: AppSettings,
  updateSettings: (updates: Partial<AppSettings>) => void,
) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch('/api/dev-config')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) return;
        const updates: Partial<AppSettings> = {};
        if (data.openaiApiKey && !settings.openaiApiKey) updates.openaiApiKey = data.openaiApiKey;
        if (data.anthropicApiKey && !settings.anthropicApiKey) updates.anthropicApiKey = data.anthropicApiKey;
        if (data.esvApiKey && !settings.esvApiKey) updates.esvApiKey = data.esvApiKey;
        if (Object.keys(updates).length) updateSettings(updates);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
