import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  Search,
  Wrench,
  X,
} from 'lucide-react';
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
const RAW_THOUGHT_WORD_LIMIT = 90;
const ACTIVITY_PANEL_ANIMATION_MS = 300;
const ACTIVITY_PANEL_DRAG_CLOSE_THRESHOLD = 96;
const ACTIVITY_DURATION_STORAGE_PREFIX = 'librechat.activityTimeline.duration';
const ACTIVITY_SIDEBAR_OPEN_CLASS = 'activity-sidebar-open';
const ACTIVITY_TIMELINE_OPEN_EVENT = 'librechat:activity-timeline-open';
const BOLD_HEADING_PATTERN = /\*\*([^*]+?)\*\*/g;
const SENTENCE_BOUNDARY_PATTERN = /(\.["')\]]*)\s+(?=[^\p{L}\p{N}]*\p{Lu})/gu;

type ThoughtMode = 'summarized' | 'raw';

type RenderPart = (part: TMessageContentParts, idx: number, isLastPart: boolean) => ReactNode;

type TimelineProps = {
  parts: PartWithIndex[];
  isSubmitting: boolean;
  isLast: boolean;
  lastContentIdx: number;
  searchResults?: { [key: string]: SearchResultData };
  durationKey?: string;
  storedDuration?: number;
  onDurationFinalized?: (elapsedSeconds: number) => void;
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

type RawThoughtNodeData = {
  text: string;
  wordCount: number;
  isComplete: boolean;
};

type ThoughtPreviewNode = {
  key: string;
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

function detectThoughtMode(text: string): ThoughtMode | null {
  const trimmed = text.trimStart();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('**')) {
    return 'summarized';
  }
  if (trimmed === '*') {
    return null;
  }
  return 'raw';
}

function splitRawThoughtNodes(text: string): RawThoughtNodeData[] {
  const normalizedText = text.trim().replace(/\s+/g, ' ');
  if (!normalizedText) {
    return [];
  }

  const sentenceUnits: string[] = [];
  let unitStart = 0;
  for (const match of normalizedText.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    const boundaryEnd = (match.index ?? 0) + match[1].length;
    sentenceUnits.push(normalizedText.slice(unitStart, boundaryEnd).trim());
    unitStart = boundaryEnd + match[0].slice(match[1].length).length;
  }
  sentenceUnits.push(normalizedText.slice(unitStart).trim());

  const chunks: RawThoughtNodeData[] = [];
  let activeChunk = '';
  let activeWordCount = 0;

  const flushActiveChunk = () => {
    if (!activeChunk) {
      return;
    }
    const trimmedChunk = activeChunk.trim();
    chunks.push({
      text: trimmedChunk,
      wordCount: activeWordCount,
      isComplete: /\.["')\]]*$/.test(trimmedChunk),
    });
    activeChunk = '';
    activeWordCount = 0;
  };

  for (const unit of sentenceUnits) {
    if (!unit) {
      continue;
    }
    const activeIsComplete = /\.["')\]]*$/.test(activeChunk.trim());
    const unitStartsWithUppercase = /^[^\p{L}\p{N}]*\p{Lu}/u.test(unit);
    if (
      activeChunk &&
      activeWordCount >= RAW_THOUGHT_WORD_LIMIT &&
      activeIsComplete &&
      unitStartsWithUppercase
    ) {
      flushActiveChunk();
    }
    activeChunk = activeChunk ? `${activeChunk} ${unit}` : unit;
    activeWordCount += unit.match(/\S+/g)?.length ?? 0;
  }

  flushActiveChunk();
  return chunks;
}

function splitRawThoughtText(text: string): string[] {
  return splitRawThoughtNodes(text).map((node) => node.text);
}

function getInlinePreviewNode(
  text: string,
  mode: ThoughtMode,
  isSubmitting: boolean,
): ThoughtPreviewNode | null {
  if (mode === 'summarized') {
    const sections = parseThoughtSections(text);
    if (sections.length === 0) {
      return null;
    }
    if (!isSubmitting) {
      const sectionIndex = sections.length - 1;
      const section = sections[sectionIndex];
      return { key: `summary-${sectionIndex}`, title: section.title, body: section.body };
    }
    if (sections.length > 1) {
      const sectionIndex = sections.length - 2;
      const section = sections[sectionIndex];
      return { key: `summary-${sectionIndex}`, title: section.title, body: section.body };
    }
    const section = sections[0];
    return section.title ? { key: 'summary-0-title', title: section.title, body: '' } : null;
  }

  const nodes = splitRawThoughtNodes(text);
  if (nodes.length === 0) {
    return null;
  }
  if (!isSubmitting) {
    const nodeIndex = nodes.length - 1;
    return { key: `raw-${nodeIndex}`, body: nodes[nodeIndex].text };
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.isComplete && (index < nodes.length - 1 || node.wordCount >= RAW_THOUGHT_WORD_LIMIT)) {
      return { key: `raw-${index}`, body: node.text };
    }
  }
  return null;
}

function getStableSummarizedSections(text: string, isSubmitting: boolean): ThoughtSection[] {
  const sections = parseThoughtSections(text);
  if (!isSubmitting || sections.length === 0) {
    return sections;
  }

  const lastIndex = sections.length - 1;
  const stableSections = sections.slice(0, lastIndex);
  const activeSection = sections[lastIndex];
  if (activeSection.title) {
    stableSections.push({ title: activeSection.title, body: '' });
  }
  return stableSections;
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

function stripTrailingEllipsis(text: string): string {
  return text.replace(/\s*(?:\.{3}|\u2026)+$/u, '');
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

function TimelineNode({
  children,
  icon,
  forceLine = false,
}: {
  children: ReactNode;
  icon?: ReactNode;
  forceLine?: boolean;
}) {
  return (
    <div className="group/timeline-node relative pb-4 pl-6 last:pb-0">
      <span
        data-testid="timeline-node-line"
        className={cn(
          'absolute bottom-0 left-2 top-6 border-l border-border-light',
          !forceLine && 'group-last/timeline-node:hidden',
        )}
        aria-hidden="true"
      />
      <span className="absolute left-0 top-1 flex size-4 items-center justify-center text-text-secondary">
        {icon ?? (
          <span className="size-1.5 rounded-full bg-text-secondary ring-2 ring-surface-primary" />
        )}
      </span>
      <div className="min-w-0 text-sm leading-6 text-text-secondary">{children}</div>
    </div>
  );
}

function RawThoughtNode({ text, forceLine }: { text: string; forceLine: boolean }) {
  return (
    <TimelineNode forceLine={forceLine}>
      <p className="whitespace-pre-wrap break-words font-normal text-[rgb(93,93,93)] dark:text-[rgb(175,175,175)]">
        {text}
      </p>
    </TimelineNode>
  );
}

function RawThoughtNodes({ text, forceLine }: { text: string; forceLine: boolean }) {
  return (
    <>
      {splitRawThoughtText(text).map((chunk, index) => (
        <RawThoughtNode key={`raw-thought-${index}`} text={chunk} forceLine={forceLine} />
      ))}
    </>
  );
}

function ThoughtItem({
  text,
  mode,
  forceLine,
  isSubmitting,
}: {
  text: string;
  mode: ThoughtMode;
  forceLine: boolean;
  isSubmitting: boolean;
}) {
  if (!text) {
    return null;
  }
  if (mode === 'raw') {
    return <RawThoughtNodes text={text} forceLine={forceLine} />;
  }

  const sections = getStableSummarizedSections(text, isSubmitting);
  if (sections.length === 0) {
    return <RawThoughtNodes text={text} forceLine={forceLine} />;
  }

  return (
    <>
      {sections.flatMap((section, sectionIndex) => {
        if (section.title) {
          return (
            <TimelineNode key={`${section.title}-${sectionIndex}`} forceLine={forceLine}>
              <p className="font-medium text-[rgb(93,93,93)] dark:text-[rgb(175,175,175)]">
                {section.title}
              </p>
              {section.body && (
                <p className="mt-1 whitespace-pre-wrap font-normal text-[rgb(93,93,93)] dark:text-[rgb(175,175,175)]">
                  {section.body}
                </p>
              )}
            </TimelineNode>
          );
        }

        return (
          <RawThoughtNodes
            key={`thought-${sectionIndex}`}
            text={section.body}
            forceLine={forceLine}
          />
        );
      })}
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
      <TimelineNode
        icon={<Search className="size-3.5" aria-hidden="true" />}
        forceLine={isSubmitting}
      >
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <span>{foundLabel}</span>
          <SourceIcons sources={sources} />
        </span>
      </TimelineNode>
      {readSources.length > 0 && (
        <TimelineNode
          icon={<FileText className="size-3.5" aria-hidden="true" />}
          forceLine={isSubmitting}
        >
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
    <TimelineNode
      icon={<Wrench className="size-3.5" aria-hidden="true" />}
      forceLine={isSubmitting}
    >
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

function CompletionItem({ elapsedSeconds }: { elapsedSeconds: number }) {
  const localize = useLocalize();
  return (
    <TimelineNode icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
      <p>{localize('com_ui_thought_for_seconds', { 0: String(Math.max(1, elapsedSeconds)) })}</p>
      <p className="mt-1 text-text-primary">{localize('com_ui_done')}</p>
    </TimelineNode>
  );
}

function getDurationStorageKey(durationKey?: string): string | null {
  return durationKey ? `${ACTIVITY_DURATION_STORAGE_PREFIX}:${durationKey}` : null;
}

function readStoredDuration(durationKey?: string): number | null {
  const storageKey = getDurationStorageKey(durationKey);
  if (!storageKey || typeof window === 'undefined') {
    return null;
  }

  try {
    const parsedValue = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(parsedValue) && parsedValue > 0 ? Math.round(parsedValue) : null;
  } catch {
    return null;
  }
}

function writeStoredDuration(durationKey: string | undefined, elapsedSeconds: number) {
  const storageKey = getDurationStorageKey(durationKey);
  if (!storageKey || typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, String(Math.max(1, Math.round(elapsedSeconds))));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function addActivitySidebarLayoutOffset(): () => void {
  const body = typeof document === 'undefined' ? null : document.body;
  if (!body) {
    return () => undefined;
  }

  const openCount = Number(body.dataset.activitySidebarOpenCount ?? '0') + 1;
  body.dataset.activitySidebarOpenCount = String(openCount);
  body.classList.add(ACTIVITY_SIDEBAR_OPEN_CLASS);

  return () => {
    const nextOpenCount = Math.max(0, Number(body.dataset.activitySidebarOpenCount ?? '1') - 1);
    if (nextOpenCount > 0) {
      body.dataset.activitySidebarOpenCount = String(nextOpenCount);
      return;
    }

    delete body.dataset.activitySidebarOpenCount;
    body.classList.remove(ACTIVITY_SIDEBAR_OPEN_CLASS);
  };
}

function announceActivityTimelineOpen(id: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(ACTIVITY_TIMELINE_OPEN_EVENT, { detail: { id } }));
}

function useLiveDuration(
  isSubmitting: boolean,
  durationKey?: string,
  storedDuration?: number,
  onDurationFinalized?: (elapsedSeconds: number) => void,
): number | null {
  const initialStoredDuration = storedDuration ?? readStoredDuration(durationKey);
  const startTimeRef = useRef<number | null>(isSubmitting ? Date.now() : null);
  const hadLiveSessionRef = useRef(isSubmitting || initialStoredDuration != null);
  const onDurationFinalizedRef = useRef(onDurationFinalized);
  const lastPersistedDurationRef = useRef<number | null>(storedDuration ?? null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(
    isSubmitting ? 0 : initialStoredDuration,
  );

  useEffect(() => {
    onDurationFinalizedRef.current = onDurationFinalized;
  }, [onDurationFinalized]);

  useEffect(() => {
    if (storedDuration != null) {
      hadLiveSessionRef.current = true;
      lastPersistedDurationRef.current = storedDuration;
      setElapsedSeconds(storedDuration);
    }
  }, [storedDuration]);

  useEffect(() => {
    if (isSubmitting && startTimeRef.current == null) {
      startTimeRef.current = Date.now();
      hadLiveSessionRef.current = true;
      setElapsedSeconds(0);
    }

    if (!isSubmitting) {
      if (hadLiveSessionRef.current && startTimeRef.current != null) {
        const finalDuration = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000));
        writeStoredDuration(durationKey, finalDuration);
        if (lastPersistedDurationRef.current !== finalDuration) {
          lastPersistedDurationRef.current = finalDuration;
          onDurationFinalizedRef.current?.(finalDuration);
        }
        setElapsedSeconds(finalDuration);
        startTimeRef.current = null;
        return;
      }

      const latestStoredDuration = storedDuration ?? readStoredDuration(durationKey);
      if (latestStoredDuration != null) {
        hadLiveSessionRef.current = true;
        setElapsedSeconds(latestStoredDuration);
        return;
      }
      setElapsedSeconds(null);
      return;
    }

    const interval = window.setInterval(() => {
      if (startTimeRef.current != null) {
        const nextDuration = Math.round((Date.now() - startTimeRef.current) / 1000);
        setElapsedSeconds(nextDuration);
        if (nextDuration > 0) {
          writeStoredDuration(durationKey, nextDuration);
        }
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [durationKey, isSubmitting, storedDuration]);

  return hadLiveSessionRef.current ? elapsedSeconds : null;
}

function useLockedThoughtMode(text: string): ThoughtMode {
  const modeRef = useRef<ThoughtMode | null>(null);
  const detectedMode = detectThoughtMode(text);
  if (modeRef.current == null && detectedMode != null) {
    modeRef.current = detectedMode;
  }
  return modeRef.current ?? 'raw';
}

function Timeline({
  parts,
  isSubmitting,
  isLast,
  lastContentIdx,
  searchResults,
  durationKey,
  storedDuration,
  onDurationFinalized,
  getAttachments,
  renderPart,
}: TimelineProps) {
  const localize = useLocalize();
  const contentId = useId();
  const showThinking = useAtomValue(showThinkingAtom);
  const autoExpandTools = useRecoilValue(store.autoExpandTools);
  const elapsedSeconds = useLiveDuration(
    isSubmitting,
    durationKey,
    storedDuration,
    onDurationFinalized,
  );
  const hasThoughts = useMemo(
    () => parts.some(({ part }) => getReasoningText(part).length > 0),
    [parts],
  );
  const hasTools = useMemo(
    () => parts.some(({ part }) => part.type === ContentTypes.TOOL_CALL),
    [parts],
  );
  const defaultExpanded =
    !isSubmitting && isLast && ((hasThoughts && showThinking) || (hasTools && autoExpandTools));
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [isPanelMounted, setIsPanelMounted] = useState(defaultExpanded);
  const [isPanelClosing, setIsPanelClosing] = useState(false);
  const [userOverride, setUserOverride] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDraggingPanel, setIsDraggingPanel] = useState(false);
  const panelDragRef = useRef<{ pointerId: number; startY: number } | null>(null);
  const dragOffsetRef = useRef(0);

  useEffect(() => {
    const handleTimelineOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      if (!detail?.id || detail.id === contentId) {
        return;
      }
      setIsExpanded(false);
    };

    window.addEventListener(ACTIVITY_TIMELINE_OPEN_EVENT, handleTimelineOpen);
    return () => window.removeEventListener(ACTIVITY_TIMELINE_OPEN_EVENT, handleTimelineOpen);
  }, [contentId]);

  useEffect(() => {
    if (isSubmitting) {
      return;
    }
    if (!userOverride && isLast && elapsedSeconds != null) {
      return;
    }
    if (!userOverride) {
      setIsExpanded(defaultExpanded);
    }
  }, [defaultExpanded, elapsedSeconds, isLast, isSubmitting, userOverride]);

  useEffect(() => {
    if (isExpanded) {
      dragOffsetRef.current = 0;
      setDragOffset(0);
      setIsPanelMounted(true);
      setIsPanelClosing(false);
      return;
    }
    if (!isPanelMounted) {
      return;
    }

    setIsPanelClosing(true);
    const timeout = window.setTimeout(() => {
      setIsPanelMounted(false);
      setIsPanelClosing(false);
      dragOffsetRef.current = 0;
      setDragOffset(0);
    }, ACTIVITY_PANEL_ANIMATION_MS);

    return () => window.clearTimeout(timeout);
  }, [isExpanded, isPanelMounted]);

  useEffect(() => {
    if (!isPanelMounted) {
      return;
    }

    return addActivitySidebarLayoutOffset();
  }, [isPanelMounted]);

  const thoughtText = useMemo(
    () =>
      parts
        .map(({ part }) => getReasoningText(part))
        .filter(Boolean)
        .join('\n\n'),
    [parts],
  );
  const thoughtMode = useLockedThoughtMode(thoughtText);
  const activeThoughtTitle = useMemo(
    () => (thoughtMode === 'summarized' ? getLatestThoughtTitle(thoughtText) : ''),
    [thoughtMode, thoughtText],
  );
  const previewNode = useMemo(
    () => getInlinePreviewNode(thoughtText, thoughtMode, isSubmitting),
    [isSubmitting, thoughtMode, thoughtText],
  );
  const thinkingLabel = useMemo(
    () => stripTrailingEllipsis(localize('com_ui_thinking')),
    [localize],
  );
  const activityLabel = localize('com_ui_activity');
  const durationLabel = elapsedSeconds != null ? `${Math.max(1, elapsedSeconds)}s` : '';

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
    setIsExpanded((prev) => {
      const nextExpanded = !prev;
      if (nextExpanded) {
        announceActivityTimelineOpen(contentId);
      }
      return nextExpanded;
    });
  }, [contentId]);

  const handleClose = useCallback(() => {
    setUserOverride(true);
    setIsExpanded(false);
  }, []);

  const updateDragOffset = useCallback((nextOffset: number) => {
    dragOffsetRef.current = nextOffset;
    setDragOffset(nextOffset);
  }, []);

  const handlePanelPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 1024px)').matches
    ) {
      return;
    }

    const target = event.target as HTMLElement;
    if (!target.closest('[data-activity-drag-region="true"]')) {
      return;
    }
    if (target.closest('button,a,input,textarea,select')) {
      return;
    }

    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
    const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
    panelDragRef.current = { pointerId, startY };
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDraggingPanel(true);
    event.currentTarget.setPointerCapture?.(pointerId);
  }, []);

  const handlePanelPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = panelDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const clientY = Number.isFinite(event.clientY) ? event.clientY : drag.startY;
      const nextOffset = Math.max(0, clientY - drag.startY);
      updateDragOffset(nextOffset);
      event.preventDefault();
    },
    [updateDragOffset],
  );

  const finishPanelDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = panelDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      panelDragRef.current = null;
      setIsDraggingPanel(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      if (dragOffsetRef.current >= ACTIVITY_PANEL_DRAG_CLOSE_THRESHOLD) {
        handleClose();
        return;
      }

      updateDragOffset(0);
    },
    [handleClose, updateDragOffset],
  );

  const label = useMemo(() => {
    if (isSubmitting) {
      return activeThoughtTitle || thinkingLabel;
    }
    if (elapsedSeconds != null) {
      return localize('com_ui_thought_for_seconds', { 0: String(Math.max(1, elapsedSeconds)) });
    }
    return localize('com_ui_thoughts');
  }, [activeThoughtTitle, elapsedSeconds, isSubmitting, localize, thinkingLabel]);
  const showInlinePreview = !isExpanded && isSubmitting && !!thoughtText;
  const showCompletionFooter = !isSubmitting && elapsedSeconds != null;
  const inlinePreviewTitle =
    thoughtMode === 'summarized' && previewNode?.title ? previewNode.title : thinkingLabel;
  const inlinePreviewBody =
    thoughtMode === 'summarized' && previewNode?.title ? previewNode.body : previewNode?.body;

  const activityContent = (
    <div className="mt-4">
      <h2 className="mb-3 text-base font-normal leading-6 text-text-primary">{thinkingLabel}</h2>
      <div>
        {parts.map(({ part, idx }) => {
          if (part.type === ContentTypes.THINK) {
            return (
              <ThoughtItem
                key={`thought-${idx}`}
                text={getReasoningText(part)}
                mode={thoughtMode}
                forceLine={isSubmitting}
                isSubmitting={isSubmitting}
              />
            );
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
        {showCompletionFooter && <CompletionItem elapsedSeconds={elapsedSeconds} />}
      </div>
    </div>
  );

  const activityPanel = isPanelMounted ? (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={localize('com_ui_close')}
        className={cn(
          'fixed inset-0 z-[79] bg-black/40 transition-opacity duration-300 lg:hidden',
          isPanelClosing && 'opacity-0',
        )}
        onClick={handleClose}
      />
      <aside
        id={contentId}
        role="dialog"
        aria-label={activityLabel}
        aria-modal="false"
        onPointerDown={handlePanelPointerDown}
        onPointerMove={handlePanelPointerMove}
        onPointerUp={finishPanelDrag}
        onPointerCancel={finishPanelDrag}
        style={
          {
            '--activity-panel-drag-offset': `${dragOffset}px`,
          } as CSSProperties
        }
        className={cn(
          'activity-panel-sheet fixed inset-x-0 bottom-0 z-[80] flex max-h-[82dvh] flex-col rounded-t-2xl border border-border-light bg-white text-text-primary shadow-[0_-12px_48px_rgba(0,0,0,0.18)] dark:bg-gray-800 lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[384px] lg:rounded-none lg:border-y-0 lg:border-r-0 lg:shadow-xl',
          isPanelClosing ? 'activity-panel-sheet-closing' : 'activity-panel-sheet-open',
          isDraggingPanel && 'activity-panel-sheet-dragging',
        )}
      >
        <div
          className="activity-panel-drag-region flex justify-center pt-2 lg:hidden"
          data-activity-drag-region="true"
          aria-hidden="true"
        >
          <span className="h-1 w-12 rounded-full bg-border-medium" />
        </div>
        <div
          className="activity-panel-drag-region flex items-center justify-between border-b border-border-light px-5 py-4"
          data-activity-drag-region="true"
        >
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-lg font-normal leading-6 text-text-primary">
              {activityLabel}
            </h1>
            {durationLabel && (
              <span className="shrink-0 text-sm text-text-secondary">· {durationLabel}</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={localize('com_ui_close')}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="activity-panel-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {activityContent}
        </div>
      </aside>
    </>
  ) : null;
  const portalTarget = typeof document === 'undefined' ? null : document.body;

  return (
    <section className="my-2" data-testid="activity-timeline">
      <div className="group/timeline flex max-w-full flex-col text-text-secondary">
        <div className="flex max-w-full items-center gap-1.5">
          {showInlinePreview ? (
            <button
              type="button"
              onClick={handleToggle}
              aria-expanded={isExpanded}
              aria-controls={contentId}
              className="flex w-full max-w-3xl items-start rounded-2xl border border-border-light bg-transparent px-4 py-3 text-left font-normal text-text-secondary transition-[border-color,color,transform] duration-300 ease-out hover:border-border-medium hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
            >
              <span className="min-w-0">
                <TextShimmer className="block text-base font-medium leading-6">
                  {inlinePreviewTitle}
                </TextShimmer>
                {previewNode && (
                  <span
                    key={previewNode.key}
                    data-testid="activity-preview-node"
                    className="activity-preview-node-enter mt-2 block text-sm font-normal leading-5 text-[rgb(93,93,93)] dark:text-[rgb(175,175,175)]"
                  >
                    {thoughtMode !== 'summarized' && previewNode.title && (
                      <span className="block whitespace-pre-wrap">{previewNode.title}</span>
                    )}
                    {inlinePreviewBody && (
                      <span className="block whitespace-pre-wrap">{inlinePreviewBody}</span>
                    )}
                  </span>
                )}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleToggle}
              aria-expanded={isExpanded}
              aria-controls={contentId}
              className="inline-flex min-w-0 items-center gap-1.5 rounded text-base font-normal leading-7 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
            >
              {isSubmitting ? (
                <TextShimmer className="truncate font-medium">{label}</TextShimmer>
              ) : (
                <span className="truncate">{label}</span>
              )}
              <ChevronDown
                className={cn('size-4 shrink-0 transition-transform', isExpanded && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
          )}
          {thoughtText && !showInlinePreview && (
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
        {activityPanel &&
          (portalTarget ? createPortal(activityPanel, portalTarget) : activityPanel)}
      </div>
    </section>
  );
}

export default memo(Timeline);
