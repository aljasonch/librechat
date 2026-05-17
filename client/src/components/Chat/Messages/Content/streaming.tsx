import React, { memo, useEffect, useState } from 'react';
import type { Element, Content, Root, Text } from 'hast';
import type { Plugin } from 'unified';
import { cn } from '~/utils';

type StreamingSpanProps = React.ComponentPropsWithoutRef<'span'> & {
  node?: Element;
  'data-streaming-word'?: string | boolean;
};

const SKIPPED_TAGS = new Set([
  'artifact',
  'canvas',
  'code',
  'composite-citation',
  'iframe',
  'mcp-ui-carousel',
  'mcp-ui-resource',
  'pre',
  'script',
  'style',
  'svg',
  'textarea',
]);

const SKIPPED_CLASSES = new Set(['katex', 'math', 'mermaid', 'not-prose']);
const WHITESPACE_PATTERN = /^(\s+)$/;

const scheduleVisible = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback);
    return () => {
      cancelAnimationFrame(frame);
    };
  }

  const timeout = setTimeout(callback, 0);
  return () => {
    clearTimeout(timeout);
  };
};

const getClassNames = (node: Element): string[] => {
  const className = node.properties?.className;
  if (Array.isArray(className)) {
    return className.map(String);
  }
  if (typeof className === 'string') {
    return className.split(/\s+/);
  }
  return [];
};

const shouldSkipChildren = (node: Element): boolean => {
  if (SKIPPED_TAGS.has(node.tagName)) {
    return true;
  }

  return getClassNames(node).some((className) => SKIPPED_CLASSES.has(className));
};

const createWordNode = (value: string, index: number): Element => ({
  type: 'element',
  tagName: 'span',
  properties: {
    className: ['streaming-word'],
    'data-streaming-word': String(index),
  },
  children: [{ type: 'text', value }],
});

const splitTextNode = (node: Text, wordIndex: { current: number }): Content[] =>
  node.value
    .split(/(\s+)/)
    .filter(Boolean)
    .map((value) => {
      if (WHITESPACE_PATTERN.test(value)) {
        return { type: 'text', value };
      }
      const nextWordIndex = wordIndex.current;
      wordIndex.current += 1;
      return createWordNode(value, nextWordIndex);
    });

const wrapTextChildren = (node: Root | Element, wordIndex: { current: number }) => {
  const children = node.children as Content[];

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];

    if (child.type === 'text') {
      const replacement = splitTextNode(child, wordIndex);
      children.splice(i, 1, ...replacement);
      i += replacement.length - 1;
      continue;
    }

    if (child.type === 'element' && !shouldSkipChildren(child)) {
      wrapTextChildren(child, wordIndex);
    }
  }
};

export const rehypeStreamingWords: Plugin<[], Root> = () => (tree) => {
  wrapTextChildren(tree, { current: 0 });
};

export const StreamingSpan: React.ElementType = memo(function StreamingSpan({
  node: _node,
  children,
  className,
  'data-streaming-word': streamingWord,
  ...props
}: StreamingSpanProps) {
  const isStreamingWord = streamingWord != null;
  const [isVisible, setIsVisible] = useState(!isStreamingWord);

  useEffect(() => {
    if (!isStreamingWord) {
      setIsVisible(true);
      return;
    }

    setIsVisible(false);
    return scheduleVisible(() => {
      setIsVisible(true);
    });
  }, [isStreamingWord]);

  return (
    <span
      {...props}
      data-streaming-word={streamingWord}
      className={cn(className, isStreamingWord && isVisible && 'visible')}
    >
      {children}
    </span>
  );
});

StreamingSpan.displayName = 'StreamingSpan';
