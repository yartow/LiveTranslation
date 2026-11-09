// One line of the listener phone view (ListenerMode.tsx), rendered as markdown so the operator can
// format the English they type: Shift+Enter then `> ` for a quoted Bible verse, `**bold**`, lists.
//
// The page is reachable by anyone on the LAN, so only a small set of elements is rendered: raw HTML is
// skipped and anything else (links, images, code, tables) is unwrapped to its plain text — a stray
// `<b>` or `[x](http://…)` shows as text, never as markup. remark-breaks makes a single newline a line
// break, matching what the operator sees in their textarea.

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';

const ALLOWED = ['p', 'br', 'blockquote', 'em', 'strong', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'hr'];
const REMARK_PLUGINS = [remarkBreaks];

// No italic anywhere in here: on this page italic already means "this line was revised".
const COMPONENTS: Components = {
  p: ({ children }) => <p>{children}</p>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-primary/60 pl-4 text-foreground/90 space-y-2">{children}</blockquote>
  ),
  ul: ({ children }) => <ul className="list-disc pl-6 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 space-y-1">{children}</ol>,
  h1: ({ children }) => <h2 className="text-2xl font-semibold sm:text-3xl">{children}</h2>,
  h2: ({ children }) => <h2 className="text-2xl font-semibold sm:text-3xl">{children}</h2>,
  h3: ({ children }) => <h3 className="font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="font-semibold">{children}</h4>,
  hr: () => <hr className="border-border" />,
};

interface ListenerMarkdownProps {
  text: string;
  className?: string;
}

function ListenerMarkdown({ text, className }: ListenerMarkdownProps) {
  return (
    <div className={'space-y-2 ' + (className ?? '')}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        allowedElements={ALLOWED}
        unwrapDisallowed
        skipHtml
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Every incoming update re-renders the whole list; only the changed line should be parsed again.
export default memo(ListenerMarkdown);
