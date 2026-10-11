import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  AudioLines, BookA, BookOpen, Bug, ChevronLeft, ChevronRight, Cpu, KeyRound, Languages,
  Mic, Search, SlidersHorizontal, Sparkles, SpellCheck, Timer, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AppSettings } from '@/hooks/useSettings';
import { ModeBadge } from './primitives';
import {
  defaultPageId,
  getPage,
  groupsForMode,
  pagesInGroup,
  searchSettings,
} from './settings-index';
import type { SettingsMode } from './settings-index';
import type { SettingsPageProps } from './pages/types';
import {
  ApiKeysPage, DebugPage, GlossaryPage, LanguagesPage, MicrophonePage, OllamaPage, SpeechPage,
} from './pages/general';
import {
  SermonCorrectionPage, SermonListenersPage, SermonScripturePage, SermonTimingPage,
  SermonTranslationPage,
} from './pages/sermon';
import { LiveAudioPage, LiveImprovePage, LiveTranslationPage } from './pages/live';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (updates: Partial<AppSettings>) => void;
  /** The mode the dialog was opened from — its group is listed first and opened by default. */
  mode: SettingsMode;
  webGpuSupported?: boolean | null;
}

const ICONS: Record<string, LucideIcon> = {
  AudioLines, BookA, BookOpen, Bug, Cpu, KeyRound, Languages, Mic, SlidersHorizontal,
  Sparkles, SpellCheck, Timer, Users,
};

const PAGES: Record<string, ComponentType<SettingsPageProps>> = {
  'api-keys': ApiKeysPage,
  languages: LanguagesPage,
  speech: SpeechPage,
  microphone: MicrophonePage,
  ollama: OllamaPage,
  glossary: GlossaryPage,
  'sermon-correction': SermonCorrectionPage,
  'sermon-translation': SermonTranslationPage,
  'sermon-timing': SermonTimingPage,
  'sermon-scripture': SermonScripturePage,
  'sermon-listeners': SermonListenersPage,
  'live-translation': LiveTranslationPage,
  'live-improve': LiveImprovePage,
  'live-audio': LiveAudioPage,
  debug: DebugPage,
};

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background'];
const HIGHLIGHT_MS = 1800;

export default function SettingsDialog({ isOpen, onClose, settings, onUpdate, mode, webGpuSupported }: SettingsDialogProps) {
  const [query, setQuery] = useState('');
  // null = the root list (phone) / the mode's default page (desktop).
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // `n` makes picking the same result twice re-trigger the scroll/highlight.
  const [scrollTarget, setScrollTarget] = useState<{ id: string; n: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Start every opening from the root list with no search.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActivePageId(null);
      setScrollTarget(null);
    }
  }, [isOpen]);

  const groups = useMemo(() => groupsForMode(mode), [mode]);
  const results = useMemo(() => searchSettings(query), [query]);
  const isSearching = query.trim().length > 0;

  const shownPageId = activePageId ?? defaultPageId(mode);
  const shownPage = getPage(shownPageId);
  const PageComponent = PAGES[shownPageId];

  // After the page is on screen: jump to the searched setting and flash it, or
  // reset the scroll position when just changing page.
  useEffect(() => {
    if (!isOpen) return;
    if (!scrollTarget) {
      contentRef.current?.scrollTo({ top: 0 });
      return;
    }
    let clear: ReturnType<typeof setTimeout> | undefined;
    const show = setTimeout(() => {
      const el = document.getElementById(`setting-${scrollTarget.id}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add(...HIGHLIGHT_CLASSES);
      clear = setTimeout(() => el.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS);
    }, 60);
    return () => {
      clearTimeout(show);
      if (clear) clearTimeout(clear);
    };
  }, [isOpen, shownPageId, scrollTarget]);

  function openPage(pageId: string, itemId?: string) {
    setActivePageId(pageId);
    setScrollTarget(itemId ? { id: itemId, n: Date.now() } : null);
    setQuery('');
  }

  const pageProps: SettingsPageProps = { settings, onUpdate, isOpen, mode, webGpuSupported };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="w-full max-w-[calc(100vw-2rem)] sm:max-w-4xl h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col overflow-hidden outline-none"
        data-testid="dialog-settings"
        // Don't auto-focus the search box: on a phone that would pop the keyboard up on open.
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}
      >
        <DialogHeader className="flex-row items-center gap-1 space-y-0 border-b border-border px-4 py-3 pr-12">
          {activePageId !== null && !isSearching && (
            <Button
              variant="ghost"
              size="sm"
              className="sm:hidden -ml-2 h-8 px-2 text-primary"
              onClick={() => setActivePageId(null)}
              data-testid="button-settings-back"
            >
              <ChevronLeft className="h-4 w-4" />
              Settings
            </Button>
          )}
          <DialogTitle className={activePageId !== null && !isSearching ? 'sr-only sm:not-sr-only' : ''}>
            Settings
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* ── Navigation column: search + grouped page list (or search results) ── */}
          <nav
            className={`${activePageId === null || isSearching ? 'flex' : 'hidden'} sm:flex w-full sm:w-72 sm:shrink-0 flex-col border-border sm:border-r min-h-0`}
            aria-label="Settings categories"
          >
            <div className="p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                  placeholder="Search settings"
                  aria-label="Search settings"
                  className="h-9 pl-8 text-sm"
                  data-testid="input-settings-search"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              {isSearching ? (
                <SearchResults query={query} results={results} onPick={openPage} />
              ) : (
                <div className="space-y-5">
                  {groups.map((group) => (
                    <section key={group.id} aria-label={group.title}>
                      <h3 className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.title}
                        {group.isCurrent && <span className="ml-1.5 font-normal normal-case tracking-normal">(this mode)</span>}
                      </h3>
                      <ul className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
                        {pagesInGroup(group.id).map((page) => {
                          const Icon = ICONS[page.icon];
                          const selected = page.id === shownPageId;
                          return (
                            <li key={page.id}>
                              <button
                                type="button"
                                onClick={() => openPage(page.id)}
                                aria-current={selected ? 'page' : undefined}
                                data-testid={`settings-page-${page.id}`}
                                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent ${selected ? 'sm:bg-accent' : ''}`}
                              >
                                {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium text-foreground">{page.title}</span>
                                  <span className="block truncate text-xs text-muted-foreground sm:hidden">{page.summary}</span>
                                </span>
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground sm:hidden" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </nav>

          {/* ── Page column ── */}
          <div
            ref={contentRef}
            className={`${activePageId === null || isSearching ? 'hidden' : 'block'} sm:block min-w-0 flex-1 overflow-y-auto px-5 py-4`}
            data-testid="settings-page-content"
          >
            {PageComponent && shownPage && <PageComponent key={shownPageId} {...pageProps} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchResults({
  query,
  results,
  onPick,
}: {
  query: string;
  results: ReturnType<typeof searchSettings>;
  onPick: (pageId: string, itemId: string) => void;
}) {
  if (results.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted-foreground">
        No settings match “{query.trim()}”.
      </p>
    );
  }
  return (
    <ul className="space-y-1" aria-label="Search results">
      {results.map(({ item, page, group, scope }) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onPick(page.id, item.id)}
            data-testid={`settings-result-${item.id}`}
            className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.label}</span>
              <ModeBadge scope={scope} />
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {group.title} › {page.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
