import { Settings, Sun, Moon, BookOpenText, Mic } from 'lucide-react';
import { Link, useLocation } from 'wouter';

interface HeaderProps {
  onThemeToggle?: () => void;
  onSettingsOpen?: () => void;
  isDark?: boolean;
}

export default function Header({ onThemeToggle, onSettingsOpen, isDark }: HeaderProps) {
  const [location] = useLocation();
  const inSermonMode = location === '/sermon';

  return (
    <header className="sticky top-0 z-50 bg-background border-b border-border">
      <div className="flex items-center justify-between h-12 px-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary" />
          <h1 className="text-base font-semibold tracking-tight text-foreground">CTT.AY</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={inSermonMode ? '/' : '/sermon'}
            className="text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors"
            aria-label={inSermonMode ? 'Live modus' : 'Preekmodus'}
            title={inSermonMode ? 'Terug naar live modus' : 'Preekmodus (dual-pane vertaaleditor)'}
            data-testid="link-sermon-mode-toggle"
          >
            {inSermonMode ? <Mic className="w-4 h-4" /> : <BookOpenText className="w-4 h-4" />}
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
