import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Check, ChevronDown, Copy, ExternalLink, FileText, Search, Wrench } from 'lucide-react';
import { ContentTypes, Tools, ToolCallTypes } from 'librechat-data-provider';
import type {
  Agents,
  SearchResultData,
  TAttachment,
  TMessageContentParts,
  ValidSource,
} from 'librechat-data-provider';
import type { PartWithIndex } from './ParallelContent';
import { FaviconImage, getCleanDomain } from '~/components/Web/SourceHovercard';
import { useExpandCollapse, useLocalize } from '~/hooks';
import { showThinkingAtom } from '~/store/showThinking';
import { getToolDisplayLabel } from '~/utils/toolLabels';
import { isBashProgrammaticToolCall } from './routing';
import TextShimmer from './TextShimmer';
import cn from '~/utils/cn';
import store from '~/store';

const MAX_SOURCE_ICONS = 4;
const MAX_READ_LINKS = 4;
const BOLD_HEADING_PATTERN = /\*\*([^*]+?)\*\*/g;

type RenderPart = (part: TMessageContentParts, idx: number, isLastPart: boolean) => ReactNode;

type TimelineProps = {
  parts: PartWithIndex[];
  isSubmitting: boolean;
  isLast: boolean;
  lastContentIdx: number;
  searchResults?: { [key: string]: SearchResultData };
  getAttachments: (part: TMessageContentParts) => TAttachment[] | undefined;
  renderPart: RenderPart;
};

type ToolObject = Record<string, unknown>;

function getObject(value: unknown): ToolObject | null {
  return value != null && typeof value === 'object' ? (value as ToolObject) : null;
}

function getTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const obj = getObject(value);
  return typeof obj?.value === 'string' ? obj.value : '';
}

function stripThinkTags(value: string): string {
  return value
    .replace(/^<think>\s*/i, '')
    .replace(/\s*<\/think>$/i, '')
    .trim();
}

type ThoughtSection = {
  title?: string;
  body: string;
};

function parseThoughtSections(text: string): ThoughtSection[] {
  const sections: ThoughtSection[] = [];
  let lastIndex = 0;
  let activeSection: ThoughtSection | null = null;

  for (const match of text.matchAll(BOLD_HEADING_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const title = match[1]?.trim();
    if (!title) {
      continue;
    }

    const bodyBeforeHeading = text.slice(lastIndex, matchIndex).trim();
    if (activeSection) {
      activeSection.body = bodyBeforeHeading;
      sections.push(activeSection);
    } else if (bodyBeforeHeading) {
      sections.push({ body: bodyBeforeHeading });
    }

    activeSection = { title, body: '' };
    lastIndex = matchIndex + match[0].length;
  }

  const trailingBody = text.slice(lastIndex).trim();
  if (activeSection) {
    activeSection.body = trailingBody;
    sections.push(activeSection);
  } else if (trailingBody) {
    sections.push({ body: trailingBody });
  }

  return sections;
}

function getLatestThoughtTitle(text: string): string {
  const sections = parseThoughtSections(text);
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const title = sections[index].title;
    if (title) {
      return title;
    }
  }
  return '';
}

function getReasoningText(part: TMessageContentParts): string {
  if (part.type !== ContentTypes.THINK) {
    return '';
  }
  const source = part as unknown as Record<string, unknown>;
  return stripThinkTags(getTextValue(source[ContentTypes.THINK]));
}

function getToolObject(part: TMessageContentParts): ToolObject | null {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return null;
  }
  return getObject((part as { [ContentTypes.TOOL_CALL]?: unknown })[ContentTypes.TOOL_CALL]);
}

function getStandardToolCall(part: TMessageContentParts) {
  const toolCall = getToolObject(part);
  if (!toolCall || !('args' in toolCall)) {
    return null;
  }
  const type = typeof toolCall.type === 'string' ? toolCall.type : undefined;
  if (type && type !== ToolCallTypes.TOOL_CALL) {
    return null;
  }
  return toolCall as Agents.ToolCall & { progress?: number };
}

export function isWebSearchPart(part: TMessageContentParts): boolean {
  return getStandardToolCall(part)?.name === Tools.web_search;
}

function getToolName(part: TMessageContentParts): string {
  const standard = getStandardToolCall(part);
  if (standard) {
    return isBashProgrammaticToolCall(standard.name, standard.args)
      ? Tools.bash_tool
      : standard.name;
  }

  const toolCall = getToolObject(part);
  if (!toolCall) {
    return '';
  }
  if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
    return 'code_interpreter';
  }
  if (toolCall.type === ToolCallTypes.RETRIEVAL || toolCall.type === ToolCallTypes.FILE_SEARCH) {
    return 'file_search';
  }
  if (toolCall.type === ToolCallTypes.FUNCTION) {
    const fn = getObject(toolCall[ToolCallTypes.FUNCTION]);
    return typeof fn?.name === 'string' ? fn.name : '';
  }
  return '';
}

function hasToolOutput(part: TMessageContentParts): boolean {
  const standard = getStandardToolCall(part);
  if (standard) {
    return !!standard.output || standard.progress === 1;
  }

  const toolCall = getToolObject(part);
  if (!toolCall) {
    return false;
  }
  if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
    const codeInterpreter = getObject(toolCall[ToolCallTypes.CODE_INTERPRETER]);
    return Array.isArray(codeInterpreter?.outputs) && codeInterpreter.outputs.length > 0;
  }
  if (toolCall.type === ToolCallTypes.RETRIEVAL || toolCall.type === ToolCallTypes.FILE_SEARCH) {
    return typeof toolCall.output === 'string' && toolCall.output.length > 0;
  }
  if (toolCall.type === ToolCallTypes.FUNCTION) {
    const fn = getObject(toolCall[ToolCallTypes.FUNCTION]);
    return typeof fn?.output === 'string' && fn.output.length > 0;
  }
  return false;
}

function collectSources(results: Record<string, SearchResultData>): ValidSource[] {
  const sourceMap = new Map<string, ValidSource>();
  for (const result of Object.values(results)) {
    result?.organic?.forEach((source) => {
      if (source.link) {
        sourceMap.set(source.link, source);
      }
    });
    result?.topStories?.forEach((source) => {
      if (source.link) {
        sourceMap.set(source.link, source);
      }
    });
  }
  return Array.from(sourceMap.values());
}

function getOwnTurn(attachments?: TAttachment[]): string {
  if (!attachments) {
    return '0';
  }
  for (const attachment of attachments) {
    if (attachment.type === Tools.web_search && attachment[Tools.web_search]) {
      const turn = attachment[Tools.web_search].turn;
      return typeof turn === 'number' ? String(turn) : '0';
    }
  }
  return '0';
}

function getSources(
  attachments: TAttachment[] | undefined,
  searchResults: TimelineProps['searchResults'],
): ValidSource[] {
  if (attachments) {
    const turnMap: Record<string, SearchResultData> = {};
    for (const attachment of attachments) {
      if (attachment.type !== Tools.web_search || !attachment[Tools.web_search]) {
        continue;
      }
      const data = attachment[Tools.web_search];
      const key = typeof data.turn === 'number' ? String(data.turn) : '0';
      turnMap[key] = data;
    }
    if (Object.keys(turnMap).length > 0) {
      return collectSources(turnMap);
    }
  }

  const ownTurn = getOwnTurn(attachments);
  if (searchResults?.[ownTurn]) {
    return collectSources({ [ownTurn]: searchResults[ownTurn] });
  }
  return searchResults ? collectSources(searchResults) : [];
}

function mergeSources(previous: ValidSource[], next: ValidSource[]): ValidSource[] {
  const sourceMap = new Map<string, ValidSource>();

  const addSource = (source: ValidSource) => {
    if (!source.link) {
      return;
    }

    const existing = sourceMap.get(source.link);
    if (!existing) {
      sourceMap.set(source.link, source);
      return;
    }

    const mergedSource = { ...existing, ...source, title: source.title || existing.title };
    if (existing.processed === true || source.processed === true) {
      mergedSource.processed = true;
    }
    sourceMap.set(source.link, mergedSource);
  };

  previous.forEach(addSource);
  next.forEach(addSource);
  return Array.from(sourceMap.values());
}

function sourcesEqual(first: ValidSource[], second: ValidSource[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((source, index) => {
    const other = second[index];
    return (
      source.link === other.link &&
      source.title === other.title &&
      source.processed === other.processed
    );
  });
}

function getUniqueDomainSources(sources: ValidSource[], max: number): ValidSource[] {
  const seen = new Set<string>();
  const result: ValidSource[] = [];
  for (const source of sources) {
    const domain = getCleanDomain(source.link);
    if (seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(source);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

function SourceIcons({ sources }: { sources: ValidSource[] }) {
  const uniqueSources = useMemo(() => getUniqueDomainSources(sources, sources.length), [sources]);
  const visible = uniqueSources.slice(0, MAX_SOURCE_ICONS);
  const remaining = Math.max(uniqueSources.length - visible.length, 0);
  if (visible.length === 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {visible.map((source) => {
        const domain = getCleanDomain(source.link);
        return (
          <span
            key={source.link}
            className="inline-flex size-4 items-center justify-center rounded-full bg-surface-secondary"
            title={domain}
          >
            <FaviconImage domain={domain} className="size-3.5 rounded-full" />
          </span>
        );
      })}
      {remaining > 0 && (
        <span className="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[11px] leading-none text-text-secondary">
          +{remaining}
        </span>
      )}
    </span>
  );
}

function ReadLinks({ sources }: { sources: ValidSource[] }) {
  const localize = useLocalize();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sources : sources.slice(0, MAX_READ_LINKS);
  const hasMore = sources.length > MAX_READ_LINKS;

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 align-middle">
      {visible.map((source) => {
        const domain = getCleanDomain(source.link);
        return (
          <a
            key={source.link}
            href={source.link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-[260px] items-center gap-0.5 truncate underline decoration-border-heavy underline-offset-2 hover:text-text-primary"
          >
            <span className="truncate">{source.title || domain}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        );
      })}
      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="rounded-full bg-surface-secondary px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          {localize('com_ui_view_all')}
        </button>
      )}
    </span>
  );
}

function TimelineNode({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="relative pb-3 last:pb-0">
      <span className="absolute -left-[17px] top-[0.45rem] flex size-3 items-center justify-center text-text-secondary">
        {icon ?? (
          <span className="size-1.5 rounded-full bg-text-secondary ring-2 ring-surface-primary" />
        )}
      </span>
      <div className="min-w-0 text-sm leading-6 text-text-secondary">{children}</div>
    </div>
  );
}

function ThoughtItem({ text }: { text: string }) {
  if (!text) {
    return null;
  }
  const sections = parseThoughtSections(text);
  if (sections.length === 0) {
    return null;
  }

  return (
    <>
      {sections.map((section, index) => (
        <TimelineNode key={`${section.title ?? 'thought'}-${index}`}>
          {section.title && <p className="font-medium text-text-primary">{section.title}</p>}
          {section.body && (
            <p className={cn('whitespace-pre-wrap', section.title && 'mt-1')}>{section.body}</p>
          )}
        </TimelineNode>
      ))}
    </>
  );
}

function WebSearchItem({
  part,
  isSubmitting,
  searchResults,
  getAttachments,
}: Pick<TimelineProps, 'searchResults' | 'getAttachments' | 'isSubmitting'> & {
  part: TMessageContentParts;
}) {
  const localize = useLocalize();
  const attachments = getAttachments(part);
  const toolCallId = getStandardToolCall(part)?.id ?? '';
  const latestSources = useMemo(
    () => getSources(attachments, searchResults),
    [attachments, searchResults],
  );
  const [sources, setSources] = useState<ValidSource[]>(latestSources);
  const toolCallIdRef = useRef(toolCallId);

  useEffect(() => {
    setSources((previousSources) => {
      if (toolCallIdRef.current !== toolCallId) {
        toolCallIdRef.current = toolCallId;
        return latestSources;
      }

      const mergedSources = mergeSources(previousSources, latestSources);
      return sourcesEqual(previousSources, mergedSources) ? previousSources : mergedSources;
    });
  }, [latestSources, toolCallId]);

  const readSources = useMemo(
    () => sources.filter((source) => source.processed === true),
    [sources],
  );
  const foundLabel =
    sources.length > 0
      ? localize('com_ui_found_n_web_pages', { 0: String(sources.length) })
      : localize(isSubmitting ? 'com_ui_web_searching' : 'com_ui_web_searched');

  return (
    <>
      <TimelineNode icon={<Search className="size-3.5" aria-hidden="true" />}>
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <span>{foundLabel}</span>
          <SourceIcons sources={sources} />
        </span>
      </TimelineNode>
      {readSources.length > 0 && (
        <TimelineNode icon={<FileText className="size-3.5" aria-hidden="true" />}>
          <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
            <span>{localize('com_ui_read_n_pages', { 0: String(readSources.length) })}</span>
            <ReadLinks sources={readSources} />
          </span>
        </TimelineNode>
      )}
    </>
  );
}

function ToolItem({
  part,
  idx,
  isLastPart,
  isSubmitting,
  renderPart,
}: {
  part: TMessageContentParts;
  idx: number;
  isLastPart: boolean;
  isSubmitting: boolean;
  renderPart: RenderPart;
}) {
  const localize = useLocalize();
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const toolName = getToolName(part);
  const label = toolName ? getToolDisplayLabel(toolName, localize) : localize('com_ui_tools');
  const isComplete = !isSubmitting || hasToolOutput(part);
  const [isExpanded, setIsExpanded] = useState(() => autoExpand && isComplete);
  const { style, ref } = useExpandCollapse(isExpanded);

  useEffect(() => {
    if (autoExpand && isComplete) {
      setIsExpanded(true);
    }
  }, [autoExpand, isComplete]);

  const statusText = isComplete
    ? localize('com_assistants_completed_function', { 0: label })
    : localize('com_assistants_running_var', { 0: label });

  return (
    <TimelineNode icon={<Wrench className="size-3.5" aria-hidden="true" />}>
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="inline-flex min-w-0 items-center gap-1.5 rounded text-left transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        aria-expanded={isExpanded}
      >
        <span className="truncate">{statusText}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', isExpanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      <div style={style}>
        <div className="overflow-hidden" ref={ref}>
          <div className="bg-surface-secondary/60 mt-2 rounded-md border border-border-light px-2 py-1">
            {renderPart(part, idx, isLastPart)}
          </div>
        </div>
      </div>
    </TimelineNode>
  );
}

function useLiveDuration(isSubmitting: boolean): number | null {
  const startTimeRef = useRef<number | null>(isSubmitting ? Date.now() : null);
  const hadLiveSessionRef = useRef(isSubmitting);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(isSubmitting ? 0 : null);

  useEffect(() => {
    if (isSubmitting && startTimeRef.current == null) {
      startTimeRef.current = Date.now();
      hadLiveSessionRef.current = true;
      setElapsedSeconds(0);
    }

    if (!isSubmitting) {
      if (hadLiveSessionRef.current && startTimeRef.current != null) {
        setElapsedSeconds(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
      }
      return;
    }

    const interval = window.setInterval(() => {
      if (startTimeRef.current != null) {
        setElapsedSeconds(Math.round((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isSubmitting]);

  return hadLiveSessionRef.current ? elapsedSeconds : null;
}

function Timeline({
  parts,
  isSubmitting,
  isLast,
  lastContentIdx,
  searchResults,
  getAttachments,
  renderPart,
}: TimelineProps) {
  const localize = useLocalize();
  const contentId = useId();
  const showThinking = useAtomValue(showThinkingAtom);
  const autoExpandTools = useRecoilValue(store.autoExpandTools);
  const elapsedSeconds = useLiveDuration(isSubmitting);
  const hasThoughts = useMemo(
    () => parts.some(({ part }) => getReasoningText(part).length > 0),
    [parts],
  );
  const hasTools = useMemo(
    () => parts.some(({ part }) => part.type === ContentTypes.TOOL_CALL),
    [parts],
  );
  const defaultExpanded =
    isSubmitting || (hasThoughts && showThinking) || (hasTools && autoExpandTools);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [userOverride, setUserOverride] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const { style, ref } = useExpandCollapse(isExpanded);

  useEffect(() => {
    if (isSubmitting) {
      setIsExpanded(true);
      return;
    }
    if (!userOverride) {
      setIsExpanded(defaultExpanded);
    }
  }, [defaultExpanded, hasTools, isSubmitting, userOverride]);

  const thoughtText = useMemo(
    () =>
      parts
        .map(({ part }) => getReasoningText(part))
        .filter(Boolean)
        .join('\n\n'),
    [parts],
  );
  const activeThoughtTitle = useMemo(() => getLatestThoughtTitle(thoughtText), [thoughtText]);

  const handleCopy = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!thoughtText) {
        return;
      }
      navigator.clipboard?.writeText(thoughtText);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 2000);
    },
    [thoughtText],
  );

  const handleToggle = useCallback(() => {
    setUserOverride(true);
    setIsExpanded((prev) => !prev);
  }, []);

  const label = useMemo(() => {
    if (isSubmitting) {
      return activeThoughtTitle || localize('com_ui_thinking');
    }
    if (elapsedSeconds != null) {
      return localize('com_ui_thought_for_seconds', { 0: String(Math.max(1, elapsedSeconds)) });
    }
    return localize('com_ui_thoughts');
  }, [activeThoughtTitle, elapsedSeconds, isSubmitting, localize]);

  return (
    <section className="my-2" data-testid="activity-timeline">
      <div className="group/timeline inline-flex max-w-full flex-col text-text-secondary">
        <div className="flex max-w-full items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-controls={contentId}
            className="inline-flex min-w-0 items-center gap-1.5 rounded text-base font-medium leading-7 transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          >
            {isSubmitting ? (
              <TextShimmer className="truncate">{label}</TextShimmer>
            ) : (
              <span className="truncate">{label}</span>
            )}
            <ChevronDown
              className={cn('size-4 shrink-0 transition-transform', isExpanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
          {thoughtText && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={
                isCopied
                  ? localize('com_ui_copied_to_clipboard')
                  : localize('com_ui_copy_thoughts_to_clipboard')
              }
              className="rounded p-1 text-text-secondary opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy group-hover/timeline:opacity-100"
            >
              {isCopied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          style={style}
        >
          <div className="overflow-hidden" ref={ref}>
            <div className="ml-[7px] mt-2 border-l border-border-light pl-3">
              {parts.map(({ part, idx }) => {
                if (part.type === ContentTypes.THINK) {
                  return <ThoughtItem key={`thought-${idx}`} text={getReasoningText(part)} />;
                }
                if (isWebSearchPart(part)) {
                  return (
                    <WebSearchItem
                      key={`web-${idx}`}
                      part={part}
                      isSubmitting={isSubmitting}
                      searchResults={searchResults}
                      getAttachments={getAttachments}
                    />
                  );
                }
                if (part.type === ContentTypes.TOOL_CALL) {
                  return (
                    <ToolItem
                      key={`tool-${idx}`}
                      part={part}
                      idx={idx}
                      isSubmitting={isSubmitting}
                      isLastPart={isLast && idx === lastContentIdx}
                      renderPart={renderPart}
                    />
                  );
                }
                return null;
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default memo(Timeline);
