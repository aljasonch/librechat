import React, { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from './markdownConfig';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import MarkdownBlocks from './MarkdownBlocks';
import { preprocessLaTeX } from '~/utils';
import store from '~/store';

type TContentProps = {
  content: string;
  isLatestMessage: boolean;
  animateWords?: boolean;
};

const Markdown = memo(function Markdown({
  content = '',
  isLatestMessage,
  animateWords = false,
}: TContentProps) {
  const LaTeXParsing = useRecoilValue<boolean>(store.LaTeXParsing);
  const isInitializing = content === '';

  const currentContent = useMemo(() => {
    if (isInitializing) {
      return '';
    }
    return LaTeXParsing ? preprocessLaTeX(content) : content;
  }, [content, LaTeXParsing, isInitializing]);

  if (isInitializing) {
    if (!isLatestMessage) {
      return null;
    }

    return (
      <div className="absolute" aria-live="polite" aria-atomic="true">
        <p className="submitting relative">
          <span className="result-thinking" />
        </p>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary content={content} codeExecution={true}>
      <MarkdownBlocks
        content={currentContent}
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins(animateWords)}
        components={getMarkdownComponents()}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
