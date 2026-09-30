import React, { useState } from 'react';
import { Icon } from './Icon.js';

type ContentPart =
  | { kind: 'text'; value: string }
  | { kind: 'code'; language: string; value: string };

/** Renders message text and fenced code as React text nodes, with no HTML injection. */
export function MessageContent({ content }: { content: string }) {
  const parts = parseContent(content);
  return (
    <div className="r33-message-content">
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <CodeBlock key={`code-${index}`} language={part.language} code={part.value} />
        ) : part.value.trim() ? (
          <p className="r33-message-text" key={`text-${index}`}>
            {renderInlineCode(part.value)}
          </p>
        ) : null,
      )}
    </div>
  );
}

function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content))) {
    if (match.index > cursor)
      parts.push({ kind: 'text', value: content.slice(cursor, match.index) });
    parts.push({
      kind: 'code',
      language: (match[1] ?? '').trim().replace(/[^a-zA-Z0-9_+#.-]/g, ''),
      value: (match[2] ?? '').replace(/\r\n/g, '\n'),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length || parts.length === 0)
    parts.push({ kind: 'text', value: content.slice(cursor) });
  return parts;
}

function renderInlineCode(value: string): React.ReactNode[] {
  return value.split(/(`[^`\n]+`)/g).map((part, index) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`'))
      return (
        <code className="r33-inline-code" key={index}>
          {part.slice(1, -1)}
        </code>
      );
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await window.cultivation.desktop.copyText(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <section
      className="r33-code-block"
      aria-label={language ? `${language} 代码` : '代码'}
      data-testid="code-block"
    >
      <div className="r33-code-toolbar">
        <span>{language || '代码'}</span>
        <button
          type="button"
          className="r33-code-copy"
          aria-label={copyState === 'copied' ? '代码已复制' : '复制代码'}
          data-testid="code-copy"
          onClick={() => void copy()}
        >
          <Icon name="Copy" size={14} />
          <span>
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
          </span>
        </button>
      </div>
      <div className="r33-code-scroll">
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    </section>
  );
}
