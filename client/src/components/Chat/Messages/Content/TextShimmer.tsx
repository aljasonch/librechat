import { createElement, memo, useMemo } from 'react';
import type { CSSProperties, ElementType, ReactNode } from 'react';
import cn from '~/utils/cn';

type TextShimmerElementProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

type TextShimmerProps = {
  children: string;
  as?: ElementType<TextShimmerElementProps>;
  className?: string;
  duration?: number;
  spread?: number;
};

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 3.2,
  spread = 2,
}: TextShimmerProps) {
  const dynamicSpread = useMemo(() => children.length * spread, [children, spread]);
  const style = useMemo(
    () =>
      ({
        '--spread': `${dynamicSpread}px`,
        '--shimmer-duration': `${duration}s`,
      }) as CSSProperties,
    [duration, dynamicSpread],
  );

  return createElement(
    Component,
    { className: cn('thinking-shimmer', className), style },
    children,
  );
}

export default memo(TextShimmerComponent);
