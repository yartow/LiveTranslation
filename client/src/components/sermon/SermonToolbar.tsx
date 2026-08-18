import { useState } from 'react';
import { Loader2, Mic, RefreshCw, Settings, Square, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import ListenerAddressPanel from './ListenerAddressPanel';

interface SermonToolbarProps {
  isRecording: boolean;
  isProcessing: boolean;
  onToggleRecording: () => void;
  dirtyCount: number;
  onRefreshAll: () => void;
  autoTranslate: boolean;
  onToggleAutoTranslate: (value: boolean) => void;
  maxLatencySecs: number;
  onChangeMaxLatencySecs: (value: number) => void;
  /** Live count of connected /listen sockets — see useListenerBroadcast.ts. */
  listenerCount: number;
  onOpenSettings: () => void;
  isMac: boolean;
}

export default function SermonToolbar({
  isRecording, isProcessing, onToggleRecording, dirtyCount, onRefreshAll,
  autoTranslate, onToggleAutoTranslate, maxLatencySecs, onChangeMaxLatencySecs,
  listenerCount, onOpenSettings, isMac,
}: SermonToolbarProps) {
  const refreshHint = isMac ? '⌘⇧⏎' : 'Ctrl+Shift+Enter';
  const [isListenerPopoverOpen, setIsListenerPopoverOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-border bg-background">
      <button
        onClick={onToggleRecording}
        disabled={isProcessing && !isRecording}
        data-testid="button-sermon-record"
        aria-label={isRecording ? 'Stop opname' : 'Start opname'}
        className={
          'inline-flex items-center justify-center h-9 w-9 rounded-full transition-colors ' +
          (isRecording ? 'bg-red-600 text-white' : 'bg-primary text-primary-foreground hover:opacity-90') +
          ' disabled:opacity-40 disabled:cursor-not-allowed'
        }
      >
        {isProcessing && !isRecording
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : isRecording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
      </button>

      <Button
        variant="outline"
        size="sm"
        onClick={onRefreshAll}
        disabled={dirtyCount === 0}
        data-testid="button-refresh-all"
        title={`Hervertaal alle gewijzigde segmenten (${refreshHint})`}
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Refresh {dirtyCount > 0 && `(${dirtyCount})`}
        <kbd className="ml-1 hidden sm:inline text-[10px] text-muted-foreground border rounded px-1 py-0.5">{refreshHint}</kbd>
      </Button>

      <div className="flex items-center gap-2">
        <Label htmlFor="sermon-auto-translate" className="text-xs text-muted-foreground whitespace-nowrap">
          Auto-vertalen
        </Label>
        <Switch
          id="sermon-auto-translate"
          checked={autoTranslate}
          onCheckedChange={onToggleAutoTranslate}
          data-testid="switch-auto-translate"
        />
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="sermon-max-latency" className="text-xs text-muted-foreground whitespace-nowrap">
          Max. vertraging
        </Label>
        <input
          id="sermon-max-latency"
          type="number"
          min={3}
          max={20}
          value={maxLatencySecs}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v)) onChangeMaxLatencySecs(v);
          }}
          onBlur={(e) => {
            const v = parseInt(e.target.value, 10);
            onChangeMaxLatencySecs(Number.isNaN(v) ? maxLatencySecs : Math.max(3, Math.min(20, v)));
          }}
          className="w-14 rounded-md border border-input bg-background px-2 py-1 text-xs"
          data-testid="input-max-latency"
        />
        <span className="text-xs text-muted-foreground">s</span>
      </div>

      <div className="flex-1" />

      <Popover open={isListenerPopoverOpen} onOpenChange={setIsListenerPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-listeners"
            title="Adres voor luisteraars"
          >
            <Users className="w-3.5 h-3.5" />
            Luisteraars {listenerCount > 0 && `(${listenerCount})`}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <ListenerAddressPanel open={isListenerPopoverOpen} listenerCount={listenerCount} />
        </PopoverContent>
      </Popover>

      <button
        onClick={onOpenSettings}
        className="text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors"
        aria-label="Preekmodus-instellingen"
        data-testid="button-sermon-settings"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
