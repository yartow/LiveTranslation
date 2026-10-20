import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import type { SourceSelection } from './AddToGlossaryBubble';

// Categories a term can be filed under (server/lib/glossary-parse.ts KNOWN_CATEGORIES).
// Contextafhankelijk and Bijbelboek are left out: they need a disambiguation rule or a book number, not just a pair.
const CATEGORIES = ['Theologisch', 'Eigennaam', 'Plaatsnaam', 'Eschatologisch/Leerstellig', 'Archaïsch'];

export interface GlossarySaved {
  selection: SourceSelection;
  /** The "transcribed as" phrase as finally typed — may be narrower than the highlight. */
  heard: string;
  dutch: string;
  fixRow: boolean;
  glossaryRowAdded: boolean;
  correctionAdded: boolean;
}

interface AddToGlossaryDialogProps {
  /** The highlighted words; the dialog is open while this is non-null. */
  selection: SourceSelection | null;
  /** Glossary CSV (basename) the English translation is appended to — settings.sermonGlossaryCsv. */
  glossaryCsv: string;
  onClose: () => void;
  onSaved: (result: GlossarySaved) => void;
}

// Dutch term on the left, English on the right. The highlighted words are kept as the
// "heard as" phrase: from then on the server replaces that phrase with the Dutch term in
// every new transcript chunk (server/lib/asr-corrections.ts), correction pass on or off.
export default function AddToGlossaryDialog({ selection, glossaryCsv, onClose, onSaved }: AddToGlossaryDialogProps) {
  const [heard, setHeard] = useState('');
  const [dutch, setDutch] = useState('');
  const [english, setEnglish] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [fixRow, setFixRow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);

  // A fresh, empty form for each selection.
  useEffect(() => {
    if (!selection) return;
    setHeard(selection.text);
    setDutch('');
    setEnglish('');
    setCategory(CATEGORIES[0]);
    setFixRow(true);
    setError(null);
    setDuplicateOf(null);
    setBusy(false);
  }, [selection]);

  /** `correctionOnly`: the term is already in the glossary — save just the "transcribed as" fix, not a second glossary row. */
  async function save(opts: { force?: boolean; correctionOnly?: boolean } = {}) {
    if (!selection) return;
    if (!dutch.trim()) { setError('Fill in the Dutch word.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sermon/glossary/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: glossaryCsv, heard, dutch, english: opts.correctionOnly ? '' : english, category, force: opts.force === true }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) { setDuplicateOf(json.existingEnglish ?? ''); return; }
      if (!res.ok) { setError(json.error ?? `Could not save (${res.status})`); return; }
      onSaved({
        selection, heard: heard.trim(), dutch: dutch.trim(), fixRow,
        glossaryRowAdded: !!json.glossaryRowAdded, correctionAdded: !!json.correctionAdded,
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  // A "transcribed as" phrase that differs from the Dutch word is a correction worth saving on its own.
  const canSaveCorrectionOnly = heard.trim().length > 0 && heard.trim().toLowerCase() !== dutch.trim().toLowerCase();

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save({ force: duplicateOf !== null }); }
  };

  return (
    <Dialog open={!!selection} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-full max-w-[calc(100vw-2rem)] sm:max-w-lg" data-testid="dialog-add-to-glossary">
        <DialogHeader>
          <DialogTitle>Add to glossary</DialogTitle>
          <DialogDescription>
            Next time this is heard it is corrected to the Dutch word automatically, and the English word is used when translating.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="glossary-heard" className="text-xs">Transcribed as</Label>
            <Input id="glossary-heard" value={heard} onChange={(e) => setHeard(e.target.value)} onKeyDown={submitOnEnter} data-testid="input-glossary-heard" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="glossary-dutch" className="text-xs">Dutch (correct word)</Label>
              <Input
                id="glossary-dutch"
                autoFocus
                value={dutch}
                onChange={(e) => { setDutch(e.target.value); setDuplicateOf(null); }}
                onKeyDown={submitOnEnter}
                placeholder="e.g. ecclesiologie"
                data-testid="input-glossary-dutch"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="glossary-english" className="text-xs">English</Label>
              <Input
                id="glossary-english"
                value={english}
                onChange={(e) => { setEnglish(e.target.value); setDuplicateOf(null); }}
                onKeyDown={submitOnEnter}
                placeholder="e.g. ecclesiology"
                data-testid="input-glossary-english"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="glossary-fix-row" checked={fixRow} onCheckedChange={(v) => setFixRow(v === true)} />
            <Label htmlFor="glossary-fix-row" className="text-xs font-normal">Also correct it in this row now</Label>
          </div>

          {duplicateOf !== null && (
            <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="glossary-duplicate">
              “{dutch.trim()}” is already in the glossary{duplicateOf ? ` as “${duplicateOf}”` : ''}. Add it anyway?
            </p>
          )}
          {error && <p className="text-xs text-destructive" data-testid="glossary-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {duplicateOf !== null && canSaveCorrectionOnly && (
            <Button variant="outline" onClick={() => void save({ correctionOnly: true })} disabled={busy} data-testid="button-glossary-correction-only">
              Only save the correction
            </Button>
          )}
          <Button onClick={() => void save({ force: duplicateOf !== null })} disabled={busy} data-testid="button-glossary-save">
            {duplicateOf !== null ? 'Add anyway' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
