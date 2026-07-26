import { useState } from 'react';
import { MarkdownText } from '../MarkdownText';

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
      <MarkdownText
        text={trimmedText}
        className={markdownClassName}
        maxSourceLength={collapsed ? TEXT_PREVIEW_LIMIT : undefined}
      />
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
