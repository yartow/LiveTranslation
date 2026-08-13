import { Settings, Sun, Moon, BookOpenText, Mic } from 'lucide-react';
import { Link, useLocation } from 'wouter';

interface HeaderProps {
  onThemeToggle?: () => void;
  onSettingsOpen?: () => void;
  isDark?: boolean;
}

export default function Header({ onThemeToggle, onSettingsOpen, isDark }: HeaderProps) {
  const [location] = useLocation();
  // Preekmodus is now the app's default route ("/"); live/subtitle mode lives at "/live".
  const inLiveMode = location === '/live';

  return (
    <header className="sticky top-0 z-50 bg-background border-b border-border">
      <div className="flex items-center justify-between h-12 px-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary" />
          <h1 className="text-base font-semibold tracking-tight text-foreground">CTT.AY</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={inLiveMode ? '/' : '/live'}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground px-2.5 py-2 rounded-md transition-colors text-sm"
            aria-label={inLiveMode ? 'Preekmodus' : 'Live modus'}
            title={inLiveMode ? 'Naar preekmodus (dual-pane vertaaleditor)' : 'Naar live modus (ondertitels)'}
            data-testid="link-sermon-mode-toggle"
          >
            {inLiveMode ? <BookOpenText className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span className="hidden sm:inline">{inLiveMode ? 'Preekmodus' : 'Live modus'}</span>
          </Link>
          {onThemeToggle && (
            <button
              onClick={onThemeToggle}
              className="text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors"
              aria-label="Toggle theme"
              data-testid="button-theme-toggle"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          )}
          {onSettingsOpen && (
            <button
              onClick={onSettingsOpen}
              className="text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors"
              aria-label="Open settings"
              data-testid="button-settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
