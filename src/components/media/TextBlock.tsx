import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type TextBlockProps = {
  text: string;
  expanded?: boolean;
};

const TEXT_PREVIEW_LIMIT = 420;

export function TextBlock({ text, expanded = false }: TextBlockProps) {
  const [showFullText, setShowFullText] = useState(expanded);
  const trimmedText = text.trim();

  if (!trimmedText) {
    return null;
  }

  const isLongText = trimmedText.length > TEXT_PREVIEW_LIMIT;
  const collapsed = !expanded && !showFullText && isLongText;
  const markdownClassName = collapsed ? 'self-text-markdown self-text-collapsed' : 'self-text-markdown';

  return (
    <div>
      <div className={markdownClassName}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          }}
        >
          {trimmedText}
        </ReactMarkdown>
      </div>
      {!expanded && isLongText && (
        <button
          type="button"
          className="text-toggle"
          onClick={() => setShowFullText((current) => !current)}
        >
          {showFullText ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
