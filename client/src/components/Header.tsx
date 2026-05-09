import { Settings, Sun, Moon } from 'lucide-react';

interface HeaderProps {
  onThemeToggle?: () => void;
  onSettingsOpen?: () => void;
  isDark?: boolean;
}

export default function Header({ onThemeToggle, onSettingsOpen, isDark }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 bg-background border-b border-border">
      <div className="flex items-center justify-between h-12 px-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary" />
          <h1 className="text-base font-semibold tracking-tight text-foreground">SermonScribe</h1>
        </div>
        <div className="flex items-center gap-1">
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
