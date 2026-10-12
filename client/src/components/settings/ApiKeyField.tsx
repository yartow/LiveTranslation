import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { maskKey } from '@/lib/mask-key';

interface ApiKeyFieldProps {
  label: string;
  placeholder: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  keyPrefix?: string;
  badge?: ReactNode;
}

export default function ApiKeyField({ label, placeholder, description, value, onChange, keyPrefix, badge }: ApiKeyFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [validationError, setValidationError] = useState('');

  const isSet = value.length > 0;

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (keyPrefix && !trimmed.startsWith(keyPrefix)) {
      setValidationError(`Key must start with "${keyPrefix}"`);
      return;
    }
    setValidationError('');
    onChange(trimmed);
    setIsEditing(false);
    setDraft('');
  }

  function handleClear() {
    onChange('');
    setIsEditing(false);
    setDraft('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setIsEditing(false);
      setDraft('');
      setValidationError('');
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{label}</Label>
        {badge}
        {isSet ? (
          <span className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Saved</span>
        ) : (
          <span className="text-xs text-orange-500 font-medium">Not set</span>
        )}
      </div>

      {!isEditing && isSet ? (
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <code className="block flex-1 min-w-0 text-xs bg-muted rounded px-3 py-2 font-mono text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {maskKey(value)}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => { setDraft(''); setIsEditing(true); }}
          >
            Change
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-destructive hover:text-destructive"
            onClick={handleClear}
          >
            Clear
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder={placeholder}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setValidationError(''); }}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoFocus={isEditing}
              className={`font-mono text-sm ${validationError ? 'border-destructive' : ''}`}
            />
            <Button size="sm" onClick={handleSave} disabled={!draft.trim()}>
              Save
            </Button>
          </div>
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
          )}
          {isSet && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => { setIsEditing(false); setDraft(''); setValidationError(''); }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
