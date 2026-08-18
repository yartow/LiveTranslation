# CTT.AY - Design Guidelines

## Design Approach

**Component library:** shadcn/ui ("new-york" style) on top of Radix UI primitives, styled with Tailwind CSS. All UI primitives (`Button`, `Dialog`, `Select`, `Switch`, `Card`, etc.) live in `client/src/components/ui/` and should be reused rather than hand-rolled — see CLAUDE.md's design principles.

**Rationale:** A content-focused utility app needing exceptional readability, clear state feedback, and mobile-first, one-handed operation. shadcn/ui gives accessible, unstyled-by-default Radix primitives that compose cleanly with Tailwind, without importing a heavier design framework.

## Core Design Principles

1. **Readability first** — large, legible typography for extended reading during sermons.
2. **Minimal distraction** — clean, flat interface (no drop shadows — see Elevation below) that doesn't compete with the spiritual/educational content.
3. **Instant feedback** — clear visual indicators for recording, processing, and translation states.
4. **One-handed, mobile-first operation** — primary controls (record button, export, history) live in a control bar fixed to the bottom of the viewport, within thumb reach; the settings dialog and other secondary controls are reachable from a header.

## Typography System

**Font:** Avenir Next (`--font-sans` / `--font-mono` in `client/src/index.css`, configured in `tailwind.config.ts`), falling back to `-apple-system, BlinkMacSystemFont, sans-serif`.

Use Tailwind's default type scale (`text-xs` through `text-xl`) with `font-medium`/`font-normal` as needed; there is no separate serif family in active use (`--font-serif` exists as a shadcn default but isn't referenced by app UI).

## Color & Theming

All color is driven by HSL CSS custom properties in `client/src/index.css`, mapped into Tailwind's `colors` config (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `ring`, plus `chart-1..5` and `sidebar*`). Light values live under `:root`, dark values under `.dark` (class-based dark mode, `darkMode: ["class"]` in `tailwind.config.ts`) — never hardcode a hex/RGB color in a component; use the semantic Tailwind classes (`bg-background`, `text-muted-foreground`, `border-border`, etc.) so both themes stay correct automatically.

A small set of literal status colors exist outside the semantic palette for things that are always the same color regardless of theme: `status.online/away/busy/offline` (chart/presence-style indicators) and ad hoc `bg-red-500` / `bg-yellow-400` / `bg-green-500` for the microphone input-level meter and the recording-pulse dot.

**Dark/light theme** — automatic detection with a manual toggle (existing app behavior; do not remove).

## Elevation

The shadow scale in `index.css` (`--shadow-xs` through `--shadow-2xl`) is defined but set to effectively **zero alpha** — this is a deliberately flat design. Separate surfaces with `border` (`border-border`) and background contrast (`bg-card` vs `bg-background`), not with drop shadows. The one intentional exception is `backdrop-blur-sm` + semi-transparent background (`bg-background/95`) on elements that float over scrolling content, e.g. the bottom control bar and the settings/export dialogs.

## Border Radius

Defined in `tailwind.config.ts`: `lg` = 9px, `md` = 6px, `sm` = 3px (`--radius: .5rem` base in `index.css`). Use `rounded-lg` for cards/panels/buttons, `rounded-md` for smaller controls, `rounded-full` for pills/badges/the record button.

## Layout System

**Mobile container:** full width, no max-width constraint on the primary transcription view (`max-w-sm mx-auto` is used specifically to center the bottom control row's icon buttons around the record button, not the page as a whole).

**Dialog sizing:** `w-full max-w-[calc(100vw-2rem)] sm:max-w-3xl` — overrides shadcn's `max-w-lg` default so dialogs (Settings, Export) use available width on mobile while staying readable on desktop. Apply this to any new `Dialog`/`DialogContent`. Note `DialogContent` is `display: grid` (shadcn default): a grid item's automatic minimum width defaults to its content's min-content size, so an unbreakable long string inside (e.g. a masked API key) can silently inflate the dialog past its max-width, clipped by `overflow-x-hidden` instead of truncating — give the content wrapper `min-w-0` to prevent this (see `SettingsDialog.tsx`).

Structural pattern seen throughout `Home.tsx` and `SermonMode.tsx`:
- A **sticky/fixed header row** (`border-b border-border`) for page-level controls (language pair, mode toggles).
- A **flexible content area** (`flex-1 overflow-hidden`) for the transcription/translation panes or the sermon-mode segment grid.
- A **fixed bottom control bar** (`fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur-sm`) holding the record button flanked by secondary actions (export, session history) — this is the actual "thumb reach" control panel, not a floating centered FAB.

## Icons

**Icon library:** [lucide-react](https://lucide.dev) exclusively — do not introduce Material Icons or any other icon set. Common icons in use: `Mic`/record state icons, `ArrowLeftRight` (swap languages), `Download` (export), `History` (session history), `AlertCircle`/`AlertTriangle` (error / warning states), `Loader2` (processing, animated via `animate-spin`), `ChevronUp`/`ChevronDown`, `RefreshCw`, `Clock`, `Wand2` (Improve button).

Icons that need a native tooltip must be wrapped in a `<span title="...">` rather than passed a `title` prop directly — Lucide's `LucideProps` doesn't accept one.

## Interaction Patterns

**Recording flow:**
1. User taps the record button in the fixed bottom bar.
2. Recording state is reflected via `RecordButton`'s `isRecording`/`isProcessing` props (icon/color change, pulsing red dot elsewhere in the header for "live" status).
3. Transcribed text streams into the transcription pane; a grey "preview" shows the raw/uncorrected partial before correction+translation resolves.
4. Translated text appears with a brief fade-in once available.

**Visual feedback:**
- Processing state: `Loader2` with `animate-spin`.
- Live/recording indicator: `animate-ping` + solid dot pair (see the header recording badge).
- New text: fade-in transitions (`transition-colors`/`duration-300`-class utilities), not custom animation code.
- Audio input level: an 8-bar level meter (green → yellow → red as it approaches/hits clipping) in the bottom control bar.

## RTL Support

Right-to-left layout (Arabic, Farsi) is **per-pane**, not a page-wide `dir` flip: each transcription/translation pane independently receives `isRTL={getLanguageRTL(lang)}` based on its own current language, since source and target languages can each independently be RTL or LTR at the same time.

## Accessibility

- Minimum touch target: 44×44px for interactive controls.
- `aria-label` on icon-only buttons (export, history, retry, refresh) — see any `Button variant="ghost" size="icon"` usage in `Home.tsx`/`SegmentRow.tsx` for the pattern.
- High-contrast text via the semantic color tokens (both themes are tuned for WCAG AA).
- Screen-reader-relevant state (errors, glossary warnings) uses `aria-label`, not color alone.

## Mobile Optimization

- Fixed header and fixed bottom control bar keep primary controls reachable while the content area scrolls independently.
- Safe-area padding for notched devices where the bottom bar meets the viewport edge.
- Landscape vs. portrait: panes may lay out side-by-side or stacked depending on available width — check the current `flex-col`/`md:flex-row` breakpoints in the component before assuming one or the other.

## Performance Considerations

- Debounced/batched text updates to avoid UI jank during streaming transcription.
- Sermon mode's `SegmentRow` is `memo`-ized on object identity so appending or translating one segment does not re-render unrelated rows (see CLAUDE.md's "Sermon mode" section).
- Minimal animation — reserved for state changes (recording pulse, spinners, fade-in), not decorative motion.

## No Decorative Images

This is a functional utility application with no hero images or decorative graphics. Focus remains entirely on text clarity and control accessibility.
