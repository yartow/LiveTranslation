import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { useSessionHistory, type SessionRecord } from '@/hooks/useSessionHistory';
import { getLanguageName } from '@/components/LanguageSelector';
import ExportDialog from '@/components/ExportDialog';

interface SessionHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function SessionHistoryDialog({ isOpen, onClose }: SessionHistoryDialogProps) {
  const { sessions, load, remove } = useSessionHistory();
  const [exportSession, setExportSession] = useState<SessionRecord | null>(null);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[520px] max-h-[80vh] flex flex-col" data-testid="dialog-history">
          <DialogHeader>
            <DialogTitle>Session History</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-2 py-2 pr-1">
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8 italic">
                No saved sessions yet. Sessions are saved automatically when you stop recording.
              </p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="rounded-md border border-border p-3 space-y-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {formatDate(s.createdAt)} &middot; {getLanguageName(s.sourceLanguage)} → {getLanguageName(s.targetLanguage)}
                        {s.sessionCost > 0 && (
                          <span className="ml-1 text-muted-foreground/70">· ~${s.sessionCost.toFixed(3)}</span>
                        )}
                      </p>
                      <p className="text-sm text-foreground mt-0.5 line-clamp-2">
                        {s.originalText.slice(0, 140) || <span className="italic text-muted-foreground">No transcript</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => setExportSession(s)}
                      >
                        Export
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => remove(s.id)}
                        aria-label="Delete session"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {exportSession && (
        <ExportDialog
          isOpen={true}
          onClose={() => setExportSession(null)}
          originalText={exportSession.originalText}
          translatedText={exportSession.translatedText}
          targetLanguage={exportSession.targetLanguage}
          sourceLanguage={exportSession.sourceLanguage}
        />
      )}
    </>
  );
}
