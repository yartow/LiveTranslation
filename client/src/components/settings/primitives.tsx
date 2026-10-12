import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { RadioGroupItem } from '@/components/ui/radio-group';
import { getItem, getPage, itemScope } from './settings-index';
import type { SettingsScope } from './settings-index';

const BADGE_STYLES: Record<SettingsScope, string> = {
  sermon: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  live: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  both: 'bg-muted text-muted-foreground',
};

const BADGE_LABELS: Record<SettingsScope, string> = {
  sermon: 'Sermon',
  live: 'Live',
  both: 'Both modes',
};

export function ModeBadge({ scope, className = '' }: { scope: SettingsScope; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none ${BADGE_STYLES[scope]} ${className}`}
      data-testid={`badge-mode-${scope}`}
    >
      {BADGE_LABELS[scope]}
    </span>
  );
}

export function PageHeader({ pageId }: { pageId: string }) {
  const page = getPage(pageId);
  if (!page) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">{page.title}</h2>
        <ModeBadge scope={page.scope} />
      </div>
      <p className="text-sm text-muted-foreground">{page.summary}</p>
    </div>
  );
}

interface SettingItemProps {
  /** Id from SETTINGS_ITEMS — label, description and mode badge come from there. */
  id: string;
  /** 'stack': control under the text. 'row': control to the right (switches). */
  layout?: 'stack' | 'row';
  /** `id` of the form control the label should point at. */
  htmlFor?: string;
  children?: ReactNode;
}

/**
 * One setting: its label/description come from the settings index, so what the
 * page shows and what search finds can't drift apart. Renders `#setting-<id>`,
 * which search results scroll to and highlight.
 */
export function SettingItem({ id, layout = 'stack', htmlFor, children }: SettingItemProps) {
  const item = getItem(id);
  const page = getPage(item.page);
  const scope = itemScope(item);
  // Only badge a setting when it differs from its page, so pages stay quiet.
  const showBadge = page ? scope !== page.scope : false;

  const text = (
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={htmlFor} className={`text-sm font-medium ${htmlFor ? 'cursor-pointer' : ''}`}>
          {item.label}
        </Label>
        {showBadge && <ModeBadge scope={scope} />}
      </div>
      <p className="text-xs text-muted-foreground">{item.description}</p>
    </div>
  );

  if (layout === 'row') {
    return (
      <div id={`setting-${id}`} className="flex items-start justify-between gap-4 rounded-md p-1 -m-1 transition-shadow">
        {text}
        <div className="shrink-0 pt-0.5">{children}</div>
      </div>
    );
  }

  return (
    <div id={`setting-${id}`} className="space-y-2 rounded-md p-1 -m-1 transition-shadow">
      {text}
      {children}
    </div>
  );
}

/** A bordered group of related controls inside a page. */
export function SettingCard({ children }: { children: ReactNode }) {
  return <div className="space-y-3 rounded-md border border-border p-3">{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function Warning({ children }: { children: ReactNode }) {
  return <p className="text-xs text-amber-600 dark:text-amber-400">{children}</p>;
}

interface RadioOptionProps {
  value: string;
  id: string;
  title: string;
  description: string;
  disabled?: boolean;
  /** Small green tag next to the title, e.g. "free · offline". */
  tag?: string;
  /** Mode badge, shown only when this option matters to a single mode. */
  scope?: SettingsScope;
  warning?: ReactNode;
  children?: ReactNode;
}

/** One selectable card inside a RadioGroup. */
export function RadioOption({ value, id, title, description, disabled, tag, scope, warning, children }: RadioOptionProps) {
  return (
    <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${disabled ? 'opacity-50' : ''}`}>
      <RadioGroupItem value={value} id={id} className="mt-0.5" disabled={disabled} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className={`font-medium ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
            {title}
          </Label>
          {tag && <span className="text-xs font-normal text-green-600 dark:text-green-400">{tag}</span>}
          {scope && <ModeBadge scope={scope} />}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        {warning && <div className="mt-0.5">{warning}</div>}
        {children}
      </div>
    </div>
  );
}
