import { useState, useMemo, memo, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { Atom, ChevronDown } from 'lucide-react';
import type { MouseEvent, FC } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const BUTTON_STYLES = {
  base: 'group mt-2 flex w-fit items-center justify-center rounded-xl text-sm leading-[18px] animate-thinking-appear',
  icon: 'icon-sm ml-1.5 transform-gpu text-text-primary transition-transform duration-200',
  shiningText: 'relative inline-block text-text-secondary',
  shiningTextBefore: 'absolute inset-0 animate-shine',
} as const;

const CONTENT_STYLES = {
  wrapper: 'relative pl-3 text-text-secondary',
  border:
    'absolute left-0 h-[calc(100%-10px)] border-l-2 border-border-medium dark:border-border-heavy',
  partBorder:
    'absolute left-0 h-[calc(100%)] border-l-2 border-border-medium dark:border-border-heavy',
  text: 'whitespace-pre-wrap leading-[26px]',
} as const;

export const ThinkingContent: FC<{ children: React.ReactNode; isPart?: boolean }> = memo(
  ({ isPart, children }) => (
    <div className={CONTENT_STYLES.wrapper}>
      <div className={isPart === true ? CONTENT_STYLES.partBorder : CONTENT_STYLES.border} />
      <p className={CONTENT_STYLES.text}>{children}</p>
    </div>
  ),
);

export const ThinkingButton = memo(
  ({
    isExpanded,
    onClick,
    label,
    isThinking = false,
  }: {
    isExpanded: boolean;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    label: string;
    isThinking?: boolean;
  }) => (
    <button type="button" onClick={onClick} className={BUTTON_STYLES.base}>
      <span className={BUTTON_STYLES.shiningText}>
        {label}
        {isThinking && (
          <span 
            className={BUTTON_STYLES.shiningTextBefore}
            style={{
              color: '#d6d6d6',
              maskImage: 'linear-gradient(to right, transparent 45%, black 50%, transparent 55%)',
              WebkitMaskImage: 'linear-gradient(to right, transparent 45%, black 50%, transparent 55%)',
              maskSize: '200% auto',
              WebkitMaskSize: '200% auto',
            }}
          >
            {label}
          </span>
        )}
      </span>
      {!isThinking && (
        <ChevronDown className={`${BUTTON_STYLES.icon} ${isExpanded ? 'rotate-180' : ''}`} />
      )}
    </button>
  ),
);

const Thinking: React.ElementType = memo(({ 
  children, 
  isThinking = false 
}: { 
  children: React.ReactNode;
  isThinking?: boolean;
}) => {
  const localize = useLocalize();
  const showThinking = useRecoilValue<boolean>(store.showThinking);
  const [isExpanded, setIsExpanded] = useState(showThinking);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsExpanded((prev) => !prev);
  }, []);

  const label = useMemo(() => {
    return isThinking ? localize('com_ui_thinking') : localize('com_ui_thoughts');
  }, [localize, isThinking]);

  if (children == null) {
    return null;
  }

  return (
    <>
      <div className="mb-5">
        <ThinkingButton 
          isExpanded={isExpanded} 
          onClick={handleClick} 
          label={label}
          isThinking={isThinking}
        />
      </div>
      <div
        className={cn('grid transition-all duration-300 ease-out', isExpanded && 'mb-8')}
        style={{
          gridTemplateRows: isExpanded ? '1fr' : '0fr',
        }}
      >
        <div className="overflow-hidden">
          <ThinkingContent isPart={true}>{children}</ThinkingContent>
        </div>
      </div>
    </>
  );
});

ThinkingButton.displayName = 'ThinkingButton';
ThinkingContent.displayName = 'ThinkingContent';
Thinking.displayName = 'Thinking';

export default memo(Thinking);
