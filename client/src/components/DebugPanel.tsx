import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface DebugPanelProps {
  logs: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClear: () => void;
  /**
   * The panel's rendered height (header + body, whichever is showing), 0 once it is gone. The
   * text-display container reserves exactly that much bottom padding — the panel is a fixed
   * overlay and would otherwise cover the last line of text.
   */
  onHeightChange: (height: number) => void;
}

/** Live mode's collapsible debug log (settings.debugMode), fixed above the action bar. */
export default function DebugPanel({ logs, collapsed, onToggleCollapsed, onClear, onHeightChange }: DebugPanelProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => onHeightChange(entry.contentRect.height));
    observer.observe(el);
    return () => { observer.disconnect(); onHeightChange(0); };
  }, [onHeightChange]);

  return (
    <div
      ref={ref}
      className="fixed left-0 right-0 mx-4 z-10"
      style={{ bottom: 'calc(88px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow-lg overflow-hidden">
        <div className="px-3 py-1.5 border-b border-border flex items-center justify-between">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            data-testid="button-debug-panel-toggle"
          >
            {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
            Debug log ({logs.length})
          </button>
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
        {!collapsed && (
          <div className="max-h-32 overflow-y-auto px-3 py-2 space-y-0.5">
            {logs.map((log, i) => (
              <p key={i} className="text-xs font-mono text-muted-foreground leading-relaxed">{log}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
