import type { AppSettings } from '@/hooks/useSettings';
import type { SettingsMode } from '../settings-index';

export interface SettingsPageProps {
  settings: AppSettings;
  onUpdate: (updates: Partial<AppSettings>) => void;
  /** Whether the dialog is open — pages that fetch data only do so while it is. */
  isOpen: boolean;
  /** The mode the dialog was opened from. */
  mode: SettingsMode;
  webGpuSupported?: boolean | null;
}
