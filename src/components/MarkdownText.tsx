import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownTextProps = {
  text: string;
  className?: string;
  maxSourceLength?: number;
};

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const markdownPlugins = [remarkGfm];

export const MarkdownText = memo(function MarkdownText({
  text,
  className = 'self-text-markdown',
  maxSourceLength,
}: MarkdownTextProps) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  const source = maxSourceLength && trimmed.length > maxSourceLength
    ? `${trimmed.slice(0, maxSourceLength).trimEnd()}...`
    : trimmed;

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        components={markdownComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
