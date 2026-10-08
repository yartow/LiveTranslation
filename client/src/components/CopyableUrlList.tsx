import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A list of URLs, each in a code box with a copy button. Shared by the "Luisteraars" popover and Settings. */
export default function CopyableUrlList({ urls }: { urls: string[] }) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(prev => (prev === url ? null : prev)), 2000);
    });
  };

  return (
    <ul className="space-y-1.5">
      {urls.map(url => (
        <li key={url} className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate text-xs bg-muted rounded px-2 py-1">{url}</code>
          <button
            type="button"
            onClick={() => copy(url)}
            aria-label={`Copy ${url}`}
            className="shrink-0 text-muted-foreground hover:text-foreground p-1.5 rounded-md transition-colors"
          >
            {copiedUrl === url ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </li>
      ))}
    </ul>
  );
}
