// Tiny, single source of truth for "is this a Mac" — used to render ⌘ vs
// Ctrl+ hints next to hotkeys. Deliberately its own module rather than living
// in sermon/hotkeys.ts, which is kept DOM/navigator-free on purpose (see its
// header comment) so its chord predicates stay trivially unit-testable.
export const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /mac/i.test(navigator.platform || (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || '');
