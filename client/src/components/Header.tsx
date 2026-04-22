import { Settings } from 'lucide-react';

interface HeaderProps {
  onThemeToggle?: () => void;
  onSettingsOpen?: () => void;
}

export default function Header({ onThemeToggle, onSettingsOpen }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 bg-background border-b border-border">
      <div className="flex items-center justify-between h-14 px-4">
        <h1 className="text-xl font-medium text-foreground">SermonScribe</h1>
        <div className="flex items-center gap-1">
          {onSettingsOpen && (
            <button
              onClick={onSettingsOpen}
              className="text-muted-foreground hover-elevate active-elevate-2 p-2 rounded-md"
              aria-label="Open settings"
              data-testid="button-settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          )}
          {onThemeToggle && (
            <button
              onClick={onThemeToggle}
              className="text-muted-foreground hover-elevate active-elevate-2 p-2 rounded-md"
              aria-label="Toggle theme"
              data-testid="button-theme-toggle"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
