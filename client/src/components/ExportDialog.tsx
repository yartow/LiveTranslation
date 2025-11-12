import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  originalText: string;
  translatedText: string;
  targetLanguage: string;
}

export default function ExportDialog({
  isOpen,
  onClose,
  originalText,
  translatedText,
  targetLanguage,
}: ExportDialogProps) {
  const [exportType, setExportType] = useState<'original' | 'translation' | 'both'>('both');
  const [fileFormat, setFileFormat] = useState<'txt' | 'md'>('txt');
  const [isExporting, setIsExporting] = useState(false);
  const [exportToGoogleDrive, setExportToGoogleDrive] = useState(false);
  const { toast } = useToast();

  const hasContent = !!(originalText || translatedText);

  const handleExport = async () => {
    setIsExporting(true);

    try {
      const response = await fetch('/api/export-format', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalText: exportType === 'original' || exportType === 'both' ? originalText : '',
          translatedText: exportType === 'translation' || exportType === 'both' ? translatedText : '',
          targetLanguage,
          exportType,
          fileFormat,
        }),
      });

      if (!response.ok) {
        throw new Error('Export formatting failed');
      }

      const data = await response.json();

      if (exportToGoogleDrive) {
        await exportToGoogleDriveFunc(data.formattedContent, fileFormat);
      } else {
        downloadFile(data.formattedContent, fileFormat);
      }

      toast({
        title: "Export successful",
        description: `Transcript exported as ${fileFormat.toUpperCase()}`,
      });

      onClose();
    } catch (error) {
      console.error('Export error:', error);
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export transcript.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const downloadFile = (content: string, format: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sermon-transcript-${Date.now()}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportToGoogleDriveFunc = async (content: string, format: string) => {
    toast({
      title: "Google Drive export",
      description: "Google Drive export will be available after connection setup.",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]" data-testid="dialog-export">
        <DialogHeader>
          <DialogTitle>Export Transcript</DialogTitle>
          <DialogDescription>
            Choose what to export and in which format. The transcript will be reformatted with proper punctuation and line breaks.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-3">
            <Label>Export content</Label>
            <RadioGroup value={exportType} onValueChange={(value: any) => setExportType(value)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="original" id="original" data-testid="radio-export-original" />
                <Label htmlFor="original" className="font-normal cursor-pointer">
                  Original text only
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="translation" id="translation" data-testid="radio-export-translation" />
                <Label htmlFor="translation" className="font-normal cursor-pointer">
                  Translation only
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="both" id="both" data-testid="radio-export-both" />
                <Label htmlFor="both" className="font-normal cursor-pointer">
                  Both (side by side)
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <Label>File format</Label>
            <RadioGroup value={fileFormat} onValueChange={(value: any) => setFileFormat(value)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="txt" id="txt" data-testid="radio-format-txt" />
                <Label htmlFor="txt" className="font-normal cursor-pointer">
                  Plain text (.txt)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="md" id="md" data-testid="radio-format-md" />
                <Label htmlFor="md" className="font-normal cursor-pointer">
                  Markdown (.md)
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="google-drive"
              checked={exportToGoogleDrive}
              onCheckedChange={(checked) => setExportToGoogleDrive(checked as boolean)}
              data-testid="checkbox-google-drive"
            />
            <Label htmlFor="google-drive" className="font-normal cursor-pointer">
              Export to Google Drive (coming soon)
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isExporting} data-testid="button-cancel-export">
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !hasContent} data-testid="button-confirm-export">
            {isExporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
