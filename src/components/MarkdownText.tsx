import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownTextProps = {
  text: string;
  className?: string;
};

export function MarkdownText({ text, className = 'self-text-markdown' }: MarkdownTextProps) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}
