import { useState } from 'react';
import { Languages, Loader2, Mic, Pause, Play, Plus, RefreshCw, Send, Settings, Square, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import ListenerAddressPanel from './ListenerAddressPanel';

interface SermonToolbarProps {
  isRecording: boolean;
  isProcessing: boolean;
  /** Recording is on but listening is paused — see useSermonIngest's pause(). */
  isPaused: boolean;
  onTogglePause: () => void;
  onToggleRecording: () => void;
  dirtyCount: number;
  onRefreshAll: () => void;
  /** Adds an empty row to type into by hand (no microphone needed). */
  onAddRow: () => void;
  autoTranslate: boolean;
  onToggleAutoTranslate: (value: boolean) => void;
  maxLatencySecs: number;
  onChangeMaxLatencySecs: (value: number) => void;
  /** Live count of connected /listen sockets — see useListenerBroadcast.ts. */
  listenerCount: number;
  /** "Send to listeners" switch — independent of recording and of auto-translate. */
  listenersEnabled: boolean;
  onToggleListeners: () => void;
  onOpenSettings: () => void;
  isMac: boolean;
}

function ToggleChip({ on, onClick, icon, label, title, testId }: {
  on: boolean; onClick: () => void; icon: React.ReactNode; label: string; title: string; testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      data-testid={testId}
      className={
        'inline-flex items-center gap-1.5 h-8 rounded-full border px-3 text-xs font-medium transition-colors ' +
        (on
          ? 'border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20'
          : 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25')
      }
    >
      {icon}
      {label}
    </button>
  );
}

export default function SermonToolbar({
  isRecording, isProcessing, isPaused, onTogglePause, onToggleRecording, dirtyCount, onRefreshAll, onAddRow,
  autoTranslate, onToggleAutoTranslate, maxLatencySecs, onChangeMaxLatencySecs,
  listenerCount, listenersEnabled, onToggleListeners, onOpenSettings, isMac,
}: SermonToolbarProps) {
  const refreshHint = isMac ? '⌘⇧⏎' : 'Ctrl+Shift+Enter';
  const [isListenerPopoverOpen, setIsListenerPopoverOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-border bg-background">
      <button
        onClick={onToggleRecording}
        disabled={isProcessing && !isRecording}
        data-testid="button-sermon-record"
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
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

      {isRecording && (
        <button
          onClick={onTogglePause}
          data-testid="button-sermon-pause"
          aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
          className={
            'inline-flex items-center justify-center h-9 w-9 rounded-full border transition-colors ' +
            (isPaused ? 'bg-amber-500 border-amber-500 text-white' : 'border-input bg-background text-foreground hover:bg-accent')
          }
        >
          {isPaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5 fill-current" />}
        </button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={onRefreshAll}
        disabled={dirtyCount === 0}
        data-testid="button-refresh-all"
        title={`Re-translate all changed segments (${refreshHint})`}
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Refresh {dirtyCount > 0 && `(${dirtyCount})`}
        <kbd className="ml-1 hidden sm:inline text-[10px] text-muted-foreground border rounded px-1 py-0.5">{refreshHint}</kbd>
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={onAddRow}
        data-testid="button-add-row"
        title="Add an empty row to type into by hand (works without a microphone)"
      >
        <Plus className="w-3.5 h-3.5" />
        Add row
      </Button>

      {/* Three independent switches: recording (round button + Pause above), translation, listeners.
          Any of them can be off while the others keep going, e.g. recording stopped but typing
          corrections that still go out to the phones. */}
      <ToggleChip
        on={autoTranslate}
        onClick={() => onToggleAutoTranslate(!autoTranslate)}
        icon={<Languages className="w-3.5 h-3.5" />}
        label={autoTranslate ? 'Auto-translate on' : 'Auto-translate off'}
        title={autoTranslate ? 'Click to stop translating automatically (you can type translations by hand)' : 'Click to resume automatic translation'}
        testId="toggle-auto-translate"
      />

      <ToggleChip
        on={listenersEnabled}
        onClick={onToggleListeners}
        icon={<Send className="w-3.5 h-3.5" />}
        label={listenersEnabled ? 'Sending to listeners' : 'Listeners paused'}
        title={listenersEnabled ? 'Click to stop sending text to the listeners’ phones' : 'Click to resume — everything written meanwhile is sent at once'}
        testId="toggle-listeners"
      />

      <div className="flex items-center gap-2">
        <Label htmlFor="sermon-max-latency" className="text-xs text-muted-foreground whitespace-nowrap">
          Block length
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
            title="Listener address"
          >
            <Users className="w-3.5 h-3.5" />
            Listeners {listenerCount > 0 && `(${listenerCount})`}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <ListenerAddressPanel open={isListenerPopoverOpen} listenerCount={listenerCount} />
        </PopoverContent>
      </Popover>

      <button
        onClick={onOpenSettings}
        className="text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors"
        aria-label="Sermon mode settings"
        data-testid="button-sermon-settings"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
