"use client";

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== 'light';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="emor-codeblock">
      <div className="emor-codeblock-header">
        <span>{language || 'text'}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={copy} aria-label="Copy code">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={isDark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: '0.85rem 1rem',
          background: 'transparent',
          fontSize: '0.84rem',
        }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
        wrapLongLines={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="emor-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const text = String(children ?? '').replace(/\n$/, '');
            const isBlock = match || text.includes('\n');
            if (!isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={match?.[1] ?? ''} code={text} />;
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto emor-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
