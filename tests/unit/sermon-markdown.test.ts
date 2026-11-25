import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripMarkdown, sameWords } from '../../client/src/lib/sermon/markdown.js';
import { buildTranscriptMarkdown } from '../../client/src/lib/sermon/transcript-markdown.js';
import { initState, segmentReducer, type SegmentStoreState } from '../../client/src/lib/sermon/segment-store.js';
import { hashText } from '../../client/src/lib/sermon/segment-model.js';
import ListenerMarkdown from '../../client/src/components/listener/ListenerMarkdown.js';

const PSALM = 'This is where the psalm is read. Psalm 23:1.\n> The Lord is my Shepherd, I shall not want.';

describe('stripMarkdown', () => {
  it('reduces formatted text to its words', () => {
    expect(stripMarkdown(PSALM)).toBe('This is where the psalm is read. Psalm 23:1. The Lord is my Shepherd, I shall not want.');
    expect(stripMarkdown('## Title\n- **one**\n2. _two_\n---\n>> deep')).toBe('Title one two deep');
  });

  it('tells a formatting-only change from a wording change', () => {
    expect(sameWords('Psalm 23:1. The Lord is my Shepherd.', PSALM.slice(PSALM.indexOf('Psalm')).replace(', I shall not want', ''))).toBe(true);
    expect(sameWords('The Lord is my shepherd.', '> The Lord is my guide.')).toBe(false);
  });
});

describe('ListenerMarkdown (phone view)', () => {
  const render = (text: string) => renderToStaticMarkup(createElement(ListenerMarkdown, { text }));

  it('renders a quote after a line break', () => {
    const html = render(PSALM);
    expect(html).toContain('<p>This is where the psalm is read. Psalm 23:1.</p>');
    expect(html).toMatch(/<blockquote[^>]*>\s*<p>The Lord is my Shepherd, I shall not want.<\/p>\s*<\/blockquote>/);
  });

  it('turns a single newline into a line break and keeps bold', () => {
    expect(render('one\ntwo **three**')).toBe('<div class="space-y-2 "><p>one<br/>\ntwo <strong>three</strong></p></div>');
  });

  it('never renders raw HTML, links or images', () => {
    const html = render('<b>x</b> <script>alert(1)</script> [site](http://evil.example) ![i](http://evil.example/i.png)');
    expect(html).not.toMatch(/<b>|<script|<a |<img/);
    expect(html).toContain('site');
  });
});

describe('buildTranscriptMarkdown', () => {
  const withLines = (texts: string[]): SegmentStoreState => {
    let s = initState('t');
    texts.forEach((t, i) => {
      s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: `r${i}`, sourceText: `Bron ${i}.`, startTime: i, endTime: i + 1, now: 0 });
      s = segmentReducer(s, { type: 'APPLY_TRANSLATION', id: `r${i}`, translation: t, requestHash: hashText(`Bron ${i}.`) });
    });
    return s;
  };
  const date = new Date(2026, 10, 8);

  it('is empty when nothing was translated', () => {
    expect(buildTranscriptMarkdown(initState('t'), { date })).toBe('');
  });

  it('writes a header and one block per line, a quote never swallowing the next block', () => {
    const md = buildTranscriptMarkdown(withLines([PSALM, 'Next thought.']), { title: ' Good  Shepherd ', passages: ['Psalm 23:1-6', ' '], date });
    expect(md).toBe(
      '# Good Shepherd\n\n*Sunday, 8 November 2026*\n\n- Psalm 23:1-6\n\n---\n\n' +
      'This is where the psalm is read. Psalm 23:1.  \n> The Lord is my Shepherd, I shall not want.\n\n' +
      'Next thought.\n',
    );
  });

  it('keeps paragraph breaks and uses a default title', () => {
    const md = buildTranscriptMarkdown(withLines(['a\n\nb\r\nc']), { date });
    expect(md.startsWith('# Sermon\n')).toBe(true);
    expect(md.endsWith('---\n\na\n\nb  \nc\n')).toBe(true);
  });
});
