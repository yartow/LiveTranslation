import { Lightbulb, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { EditSuggestion } from '@/lib/sermon/edit-suggestions';

interface SuggestionsPopoverProps {
  suggestions: EditSuggestion[];
  onAdd: (suggestion: EditSuggestion) => void;
  onDismiss: (suggestion: EditSuggestion) => void;
}

// Corrections the operator keeps making by hand (edit-suggestions.ts), offered as glossary entries.
// Only shown when there is something to suggest, so the toolbar stays quiet otherwise.
export default function SuggestionsPopover({ suggestions, onAdd, onDismiss }: SuggestionsPopoverProps) {
  if (suggestions.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-suggestions" title="Words you corrected by hand more than once — add them to the glossary">
          <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
          Suggestions ({suggestions.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-h-[70vh] overflow-y-auto p-2" data-testid="suggestions-panel">
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          You corrected these by hand. Add one to the glossary and it is fixed automatically from now on.
        </p>
        <ul className="space-y-1">
          {suggestions.map(s => (
            <li key={s.key} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" data-testid="suggestion-row">
              <span className="flex-1 min-w-0 text-sm truncate">
                <span className="text-muted-foreground line-through decoration-muted-foreground/50">{s.heard}</span>
                {' → '}
                <span className="font-medium">{s.correct}</span>
                {s.count > 1 && <span className="ml-1.5 text-xs text-muted-foreground">×{s.count}</span>}
              </span>
              <Button size="sm" className="h-7 px-2 text-xs" onClick={() => onAdd(s)} data-testid="suggestion-add">Add…</Button>
              <button
                type="button"
                onClick={() => onDismiss(s)}
                className="text-muted-foreground hover:text-foreground p-1 rounded"
                aria-label={`Do not suggest “${s.heard} → ${s.correct}” again`}
                title="Do not suggest this again"
                data-testid="suggestion-dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
