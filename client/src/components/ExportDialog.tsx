import { useState, useEffect } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import { getLanguageName } from '@/components/LanguageSelector';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  originalText: string;
  translatedText: string;
  targetLanguage: string;
  sourceLanguage?: string;
  sermonContext?: string;
}

function buildMetadataHeader(
  exportType: 'original' | 'translation' | 'both',
  sourceLanguage: string | undefined,
  targetLanguage: string,
  sermonContext: string | undefined,
  fileFormat: 'txt' | 'md',
): string {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const title = sermonContext || 'Sermon Transcript';
  const srcName = getLanguageName(sourceLanguage ?? 'en');
  const tgtName = getLanguageName(targetLanguage);
  const langLine = exportType === 'original' ? srcName
    : exportType === 'translation' ? tgtName
    : `${srcName} → ${tgtName}`;
  if (fileFormat === 'md') {
    return `# ${title}\n**Date:** ${date}\n**Language:** ${langLine}\n\n---\n\n`;
  }
  return `${title}\nDate: ${date}\nLanguage: ${langLine}\n\n`;
}

export default function ExportDialog({
  isOpen,
  onClose,
  originalText,
  translatedText,
  targetLanguage,
  sourceLanguage,
  sermonContext,
}: ExportDialogProps) {
  const [exportType, setExportType] = useState<'original' | 'translation' | 'both'>('both');
  const [fileFormat, setFileFormat] = useState<'txt' | 'md'>('txt');
  const [isExporting, setIsExporting] = useState(false);
  const [exportToGoogleDrive, setExportToGoogleDrive] = useState(false);
  const [driveFolderId, setDriveFolderId] = useState<string>('root');
  const [driveFolders, setDriveFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const { toast } = useToast();

  const hasContent = !!(originalText || translatedText);

  useEffect(() => {
    if (isOpen && exportToGoogleDrive && driveFolders.length === 0) {
      loadDriveFolders();
    }
  }, [isOpen, exportToGoogleDrive]);

  const loadDriveFolders = async () => {
    setIsLoadingFolders(true);
    try {
      const response = await fetch('/api/drive-folders');
      if (!response.ok) {
        throw new Error('Failed to load Drive folders');
      }
      const data = await response.json();
      setDriveFolders(data.folders || []);
    } catch (error) {
      console.error('Error loading Drive folders:', error);
      toast({
        title: "Could not load Google Drive folders",
        description: "You can still upload to the root folder.",
        variant: "destructive",
      });
    } finally {
      setIsLoadingFolders(false);
    }
  };

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
      const header = buildMetadataHeader(exportType, sourceLanguage, targetLanguage, sermonContext, fileFormat);
      const finalContent = header + data.formattedContent;

      if (exportToGoogleDrive) {
        await exportToGoogleDriveFunc(finalContent, fileFormat);
      } else {
        downloadFile(finalContent, fileFormat);
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
    const mimeType = format === 'md' ? 'text/markdown' : 'text/plain';
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sermon-transcript-${Date.now()}.${format}`;
    
    document.body.appendChild(a);
    
    setTimeout(() => {
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }, 100);
  };

  const exportToGoogleDriveFunc = async (content: string, format: string) => {
    try {
      const fileName = `sermon-transcript-${Date.now()}.${format}`;
      const mimeType = format === 'md' ? 'text/markdown' : 'text/plain';
      
      const response = await fetch('/api/upload-to-drive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName,
          fileContent: content,
          mimeType,
          folderId: driveFolderId === 'root' ? undefined : driveFolderId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to upload to Google Drive');
      }

      const data = await response.json();
      
      toast({
        title: "Uploaded to Google Drive",
        description: data.webViewLink 
          ? "Your transcript has been saved successfully." 
          : "Your transcript has been saved to Google Drive.",
      });

      if (data.webViewLink) {
        window.open(data.webViewLink, '_blank');
      }

      return data;
    } catch (error) {
      console.error('Google Drive upload error:', error);
      throw error;
    }
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

          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="google-drive"
                checked={exportToGoogleDrive}
                onCheckedChange={(checked) => setExportToGoogleDrive(checked as boolean)}
                data-testid="checkbox-google-drive"
              />
              <Label htmlFor="google-drive" className="font-normal cursor-pointer">
                Upload to Google Drive
              </Label>
            </div>
            
            {exportToGoogleDrive && (
              <div className="ml-6 space-y-2">
                <Label htmlFor="drive-folder" className="text-sm">
                  Select folder
                </Label>
                <Select value={driveFolderId} onValueChange={setDriveFolderId}>
                  <SelectTrigger id="drive-folder" data-testid="select-drive-folder" disabled={isLoadingFolders}>
                    <SelectValue placeholder={isLoadingFolders ? "Loading folders..." : "Select a folder"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">My Drive (root)</SelectItem>
                    {driveFolders.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
