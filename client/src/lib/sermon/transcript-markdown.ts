// The English of a service as one markdown document — what the listener phones showed, saved after the
// sermon (useTranscriptSave.ts → POST /api/sermon/transcript-md, and the toolbar's "Save .md").
// Pure, so it is unit-tested.

import { selectPublishableLines, type SegmentStoreState } from './segment-store';

export interface TranscriptMeta {
  /** "Today's service" title; 'Sermon' when empty. */
  title?: string;
  /** Planned Bible passages, one per entry. */
  passages?: string[];
  date: Date;
}

/**
 * Phones render a single newline as a line break (remark-breaks, ListenerMarkdown.tsx); plain markdown
 * viewers don't. Turn each in-block newline into a hard break (two trailing spaces) so the file looks the
 * same. Blank lines (paragraph breaks) are left alone.
 */
function hardBreaks(block: string): string {
  return block
    .split(/\n{2,}/)
    .map(para => para.split('\n').map(l => l.replace(/\s+$/, '')).join('  \n'))
    .join('\n\n');
}

export function buildTranscriptMarkdown(state: SegmentStoreState, meta: TranscriptMeta): string {
  const blocks = selectPublishableLines(state)
    .map(line => line.text.replace(/\r\n?/g, '\n').trim())
    .filter(Boolean)
    .map(hardBreaks);
  if (!blocks.length) return '';

  const title = meta.title?.trim().replace(/\s+/g, ' ') || 'Sermon';
  const date = meta.date.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const head = [`# ${title}`, '', `*${date}*`];
  const passages = (meta.passages ?? []).map(p => p.trim()).filter(Boolean);
  if (passages.length) head.push('', ...passages.map(p => `- ${p}`));
  head.push('', '---');

  // A blank line between blocks, so a `> quote` at the end of one block never swallows the next.
  return [head.join('\n'), ...blocks].join('\n\n') + '\n';
}
