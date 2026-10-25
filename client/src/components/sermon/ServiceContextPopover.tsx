import { useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { isEmptyServiceContext, parsePassages, type ServiceContext } from '@/lib/sermon/service-context';

interface ServiceContextPopoverProps {
  value: ServiceContext;
  onChange: (next: ServiceContext) => void;
}

// "Today's service": what the operator knows before the preacher starts. Names and terms sharpen the
// speech recognition (they join Whisper's vocabulary from the next chunk on); all of it goes to the
// translator; the passages let a verbatim Bible reading be caught even when the preacher never announces it.
export default function ServiceContextPopover({ value, onChange }: ServiceContextPopoverProps) {
  const empty = isEmptyServiceContext(value);
  const passages = useMemo(() => parsePassages(value.passages), [value.passages]);
  const unreadable = passages.filter(p => !p.ref);
  const noVerse = passages.filter(p => p.ref && p.ref.verseStart === null);
  const set = (patch: Partial<ServiceContext>) => onChange({ ...value, ...patch });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-service-context" title="Title, Bible passages and names for today's service">
          <ClipboardList className="w-3.5 h-3.5" />
          Service
          {!empty && <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-label="Service details filled in" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 max-h-[80vh] overflow-y-auto" data-testid="service-context-panel">
        <div className="space-y-1">
          <Label htmlFor="service-title" className="text-xs">Title</Label>
          <Input id="service-title" value={value.title} onChange={e => set({ title: e.target.value })} placeholder="Sermon title" maxLength={200} />
        </div>

        <div className="space-y-1">
          <Label htmlFor="service-passages" className="text-xs">Bible passages (one per line, in Dutch)</Label>
          <Textarea id="service-passages" rows={2} value={value.passages} onChange={e => set({ passages: e.target.value })} placeholder={'Hebreeën 12:1-3\nJohannes 3:16'} maxLength={600} />
          {unreadable.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="service-passages-unreadable">
              Could not read: {unreadable.map(p => `“${p.line}”`).join(', ')}. Use a Dutch book name and numbers, like Hebreeën 12:1-3.
            </p>
          )}
          {noVerse.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {noVerse.map(p => `“${p.line}”`).join(', ')}: add verse numbers to have a reading of it recognised.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="service-terms" className="text-xs">Names and terms (one per line)</Label>
          <Textarea id="service-terms" rows={4} value={value.terms} onChange={e => set({ terms: e.target.value })} placeholder={'Reinier Milort\nevengeven = evangelie'} maxLength={4000} />
          <p className="text-[11px] text-muted-foreground">Write <em>misheard = correct</em> for something Whisper keeps getting wrong.</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="service-notes" className="text-xs">Notes for the translation</Label>
          <Textarea id="service-notes" rows={2} value={value.notes} onChange={e => set({ notes: e.target.value })} placeholder="Theme, congregation, anything that helps" maxLength={2000} />
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Kept for this browser tab only.</p>
          <Button variant="outline" size="sm" disabled={empty} onClick={() => onChange({ title: '', passages: '', terms: '', notes: '' })} data-testid="button-service-clear">
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
