// Turns the on-screen segments of a corrected service (transcript.json from a `dev:record` session) into
// translation test items: the Dutch the operator left on screen, its neighbours as context (as the app
// sends them), and the English the operator wrote or corrected by hand as the reference. Only rows the
// operator wrote or changed (`manualOverride`) count: an untouched machine translation is not a gold
// reference, it is the thing being measured. Pure, so it is unit-tested.

export interface SnapshotSegment {
  index: number;
  sourceText?: string;
  translatedText?: string;
  manualOverride?: boolean;
  /** The machine translation the operator replaced (kept in transcript.json since segments carry machineText). */
  machineText?: string;
}

export interface TranslationFixtureItem {
  id: string;
  source: string;
  before: string[];
  after: string[];
  reference: string;
  /** What the model said before the operator changed it, when known. */
  machine?: string;
}

export interface FixtureOptions {
  /** Neighbouring rows sent as context — the app's defaults (sermonContextBefore/After). */
  contextBefore?: number;
  contextAfter?: number;
  /** Skip rows with fewer Dutch words than this: a one-word "Amen." says nothing about translation quality. */
  minWords?: number;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export function buildTranslationFixtures(segments: SnapshotSegment[], opts: FixtureOptions = {}): TranslationFixtureItem[] {
  const before = opts.contextBefore ?? 2, after = opts.contextAfter ?? 1, minWords = opts.minWords ?? 3;
  const rows = [...segments].sort((a, b) => a.index - b.index);
  const items: TranslationFixtureItem[] = [];
  rows.forEach((seg, i) => {
    const source = (seg.sourceText ?? '').trim(), reference = (seg.translatedText ?? '').trim();
    if (!seg.manualOverride || !source || !reference || words(source) < minWords) return;
    items.push({
      id: `seg-${seg.index}`,
      source, reference,
      before: rows.slice(Math.max(0, i - before), i).map(r => (r.sourceText ?? '').trim()).filter(Boolean),
      after: rows.slice(i + 1, i + 1 + after).map(r => (r.sourceText ?? '').trim()).filter(Boolean),
      ...(seg.machineText?.trim() ? { machine: seg.machineText.trim() } : {}),
    });
  });
  return items;
}
