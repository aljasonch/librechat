import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContentTypes, Tools, ToolCallTypes } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import Timeline from '../Timeline';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const dictionary: Record<string, string> = {
      com_assistants_completed_function: `Completed ${values?.[0] ?? ''}`,
      com_assistants_running_var: `Running ${values?.[0] ?? ''}`,
      com_ui_activity: 'Activity',
      com_ui_close: 'Close',
      com_ui_copy_thoughts_to_clipboard: 'Copy thoughts',
      com_ui_copied_to_clipboard: 'Copied',
      com_ui_done: 'Done',
      com_ui_found_n_web_pages: `Found ${values?.[0] ?? '0'} web pages`,
      com_ui_read_n_pages: `Read ${values?.[0] ?? '0'} pages`,
      com_ui_thought_for_seconds: `Thought for ${values?.[0] ?? '0'} seconds`,
      com_ui_thinking: 'Thinking...',
      com_ui_thoughts: 'Thoughts',
      com_ui_tools: 'Tools',
      com_ui_view_all: 'View All',
      com_ui_web_searched: 'Searched the web',
      com_ui_web_searching: 'Searching the web',
    };
    return dictionary[key] ?? key;
  },
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('~/components/Web/SourceHovercard', () => ({
  FaviconImage: ({ domain }: { domain: string }) => <span data-testid="favicon">{domain}</span>,
  getCleanDomain: (url: string) => url.replace(/(^\w+:|^)\/\//, '').split('/')[0],
}));

const renderTimeline = (
  props: Partial<React.ComponentProps<typeof Timeline>> & {
    parts: React.ComponentProps<typeof Timeline>['parts'];
  },
) =>
  render(
    <RecoilRoot>
      <Timeline
        isSubmitting={true}
        isLast={true}
        lastContentIdx={props.parts.at(-1)?.idx ?? 0}
        searchResults={undefined}
        getAttachments={() => undefined}
        renderPart={() => null}
        {...props}
      />
    </RecoilRoot>,
  );

const openActivity = () => {
  fireEvent.click(screen.getAllByRole('button')[0]);
};

const makeRawSentence = (firstWord: string, wordCount: number) =>
  `${firstWord} ${Array.from(
    { length: wordCount - 1 },
    (_, index) => `${firstWord.toLowerCase()}${index + 1}`,
  ).join(' ')}.`;

describe('Timeline', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders compact thoughts plus found/read web rows', () => {
    const webPart = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'web-1',
        type: ToolCallTypes.TOOL_CALL,
        name: Tools.web_search,
        args: '{}',
        progress: 1,
        output: 'done',
      },
    } as unknown as TMessageContentParts;
    const webAttachment = {
      type: Tools.web_search,
      toolCallId: 'web-1',
      [Tools.web_search]: {
        turn: 0,
        organic: [
          { title: 'Result A', link: 'https://a.example/path', processed: true },
          { title: 'Result B', link: 'https://b.example/path' },
        ],
      },
    } as unknown as TAttachment;

    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'I will search first.',
          } as unknown as TMessageContentParts,
        },
        { idx: 1, part: webPart },
      ],
      getAttachments: (part) => (part === webPart ? [webAttachment] : undefined),
    });

    expect(screen.queryByRole('dialog', { name: 'Activity' })).not.toBeInTheDocument();
    openActivity();

    expect(screen.getByText('I will search first.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('Found 2 web pages')).toBeInTheDocument();
    expect(screen.getByText('Read 1 pages')).toBeInTheDocument();
    expect(screen.getByText('Result A')).toBeInTheDocument();
    expect(screen.getAllByTestId('favicon')).toHaveLength(2);
  });

  it('keeps read web pages visible when later stream updates omit processed flags', () => {
    const webPart = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'web-1',
        type: ToolCallTypes.TOOL_CALL,
        name: Tools.web_search,
        args: '{}',
        progress: 1,
        output: 'done',
      },
    } as unknown as TMessageContentParts;
    const webAttachment = {
      type: Tools.web_search,
      toolCallId: 'web-1',
      [Tools.web_search]: {
        turn: 0,
        organic: [{ title: 'Result A', link: 'https://a.example/path', processed: true }],
      },
    } as unknown as TAttachment;
    const laterWebAttachment = {
      type: Tools.web_search,
      toolCallId: 'web-1',
      [Tools.web_search]: {
        turn: 0,
        organic: [{ title: 'Result A', link: 'https://a.example/path' }],
      },
    } as unknown as TAttachment;

    const timelineProps = {
      parts: [{ idx: 0, part: webPart }],
      isSubmitting: true,
      isLast: true,
      lastContentIdx: 0,
      searchResults: undefined,
      renderPart: () => null,
    };

    const { rerender } = render(
      <RecoilRoot>
        <Timeline
          {...timelineProps}
          getAttachments={(part) => (part === webPart ? [webAttachment] : undefined)}
        />
      </RecoilRoot>,
    );

    openActivity();
    expect(screen.getByText('Read 1 pages')).toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <Timeline
          {...timelineProps}
          getAttachments={(part) => (part === webPart ? [laterWebAttachment] : undefined)}
        />
      </RecoilRoot>,
    );

    expect(screen.getByText('Read 1 pages')).toBeInTheDocument();
    expect(screen.getByText('Result A')).toBeInTheDocument();
  });

  it('turns bold thinking summaries into separate titled bullet nodes', () => {
    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: [
              '**Researching overview**',
              '',
              'I will start broad.',
              '**Evaluating sources**',
              '',
              'I will check citations.',
            ].join('\n'),
          } as unknown as TMessageContentParts,
        },
      ],
    });

    openActivity();

    expect(screen.getByText('Researching overview')).toHaveClass('font-medium');
    expect(screen.getByText('Researching overview')).toHaveClass('text-[rgb(93,93,93)]');
    expect(screen.getByText('I will start broad.')).toBeInTheDocument();
    expect(screen.getAllByText('Evaluating sources')[0]).toHaveClass('thinking-shimmer');
    expect(screen.getAllByText('Evaluating sources')[1]).toHaveClass('font-medium');
    expect(screen.getAllByText('Evaluating sources')[1]).toHaveClass('text-[rgb(93,93,93)]');
    expect(screen.queryByText('I will check citations.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Evaluating sources/ })).toBeInTheDocument();
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\*\*Researching overview\*\*/)).not.toBeInTheDocument();
  });

  it('shows the live fallback title without an ellipsis', () => {
    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'I am checking this without a bold heading.',
          } as unknown as TMessageContentParts,
        },
      ],
    });

    const trigger = screen.getByRole('button', { name: /Thinking/ });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass('font-normal');
    expect(trigger).toHaveClass('text-text-secondary');
    expect(trigger).toHaveClass('bg-transparent');
    expect(screen.getByText('Thinking')).toHaveClass('thinking-shimmer');
    expect(screen.queryByRole('dialog', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('shows a collapsed live preview from completed raw nodes only', () => {
    const sentences = [
      makeRawSentence('Alpha', 30),
      makeRawSentence('Beta', 30),
      makeRawSentence('Gamma', 30),
      makeRawSentence('Delta', 30),
      makeRawSentence('Epsilon', 30),
      makeRawSentence('Zeta', 30),
    ];
    const makeParts = (count: number) => [
      {
        idx: 0,
        part: {
          type: ContentTypes.THINK,
          think: sentences.slice(0, count).join(' '),
        } as unknown as TMessageContentParts,
      },
    ];
    const { rerender } = render(
      <RecoilRoot>
        <Timeline
          parts={makeParts(3)}
          isSubmitting={true}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    expect(screen.queryByRole('dialog', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Thinking/ })).toHaveClass('motion-safe:animate-in');
    expect(screen.getByTestId('activity-preview-node')).toHaveClass('activity-preview-node-enter');
    expect(screen.getByTestId('activity-preview-node')).toHaveClass('font-normal');
    expect(screen.getByTestId('activity-preview-node')).toHaveClass('text-[rgb(93,93,93)]');
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Gamma/)).toBeInTheDocument();
    expect(screen.queryByText(/Delta/)).not.toBeInTheDocument();

    rerender(
      <RecoilRoot>
        <Timeline
          parts={makeParts(6)}
          isSubmitting={true}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
    expect(screen.getByText(/Delta/)).toBeInTheDocument();
    expect(screen.getByText(/Zeta/)).toBeInTheDocument();
  });

  it('uses the summarized thinking title as the collapsed live preview label', () => {
    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: [
              '**Calculating intersection probabilities**',
              'I need to compute the expected number of pairwise intersections.',
            ].join('\n'),
          } as unknown as TMessageContentParts,
        },
      ],
    });

    expect(screen.getByText('Calculating intersection probabilities')).toHaveClass(
      'thinking-shimmer',
    );
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(
      screen.queryByText('I need to compute the expected number of pairwise intersections.'),
    ).not.toBeInTheDocument();
  });

  it('closes the responsive activity panel from the drawer control', async () => {
    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'Closing panel.',
          } as unknown as TMessageContentParts,
        },
      ],
    });

    openActivity();
    expect(screen.getByRole('dialog', { name: 'Activity' })).toHaveClass('dark:bg-gray-800');

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closeButtons[closeButtons.length - 1]);

    expect(screen.getByRole('dialog', { name: 'Activity' })).toHaveClass(
      'lg:motion-safe:animate-slide-out-right',
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Activity' })).not.toBeInTheDocument();
    });
  });

  it('shows done in the activity timeline after live thinking completes', async () => {
    const parts = [
      {
        idx: 0,
        part: {
          type: ContentTypes.THINK,
          think: 'Live thought is finishing.',
        } as unknown as TMessageContentParts,
      },
    ];
    const { rerender } = render(
      <RecoilRoot>
        <Timeline
          parts={parts}
          isSubmitting={true}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    openActivity();

    rerender(
      <RecoilRoot>
        <Timeline
          parts={parts}
          isSubmitting={false}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Thought for 1 seconds/)).toHaveLength(2);
  });

  it('restores completed thought duration after a refresh', () => {
    window.localStorage.setItem('librechat.activityTimeline.duration:c1:m1:0', '14');

    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'Stored thought duration.',
          } as unknown as TMessageContentParts,
        },
      ],
      isSubmitting: false,
      durationKey: 'c1:m1:0',
    });

    expect(screen.getByRole('button', { name: /Thought for 14 seconds/ })).toBeInTheDocument();

    openActivity();

    expect(screen.getByRole('dialog', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getAllByText(/Thought for 14 seconds/)).toHaveLength(2);
  });

  it('keeps raw thinking literal instead of rendering markdown', () => {
    const { baseElement } = renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: [
              'Here is a compact raw thought.',
              '',
              '## Market table',
              '',
              '| Time | Price |',
              '| --- | --- |',
              '| Now | $77,852 |',
            ].join('\n'),
          } as unknown as TMessageContentParts,
        },
      ],
    });

    openActivity();

    expect(screen.getByText(/## Market table/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(baseElement.querySelectorAll('.group\\/timeline-node')).toHaveLength(1);
  });

  it('groups raw thinking by complete sentence paragraphs', () => {
    const rawText = [
      makeRawSentence('Alpha', 30),
      makeRawSentence('Beta', 30),
      makeRawSentence('Gamma', 30),
      makeRawSentence('Delta', 30),
      makeRawSentence('Epsilon', 30),
      makeRawSentence('Zeta', 30),
    ].join(' ');
    const { baseElement } = renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: rawText,
          } as unknown as TMessageContentParts,
        },
      ],
    });

    openActivity();

    const nodes = baseElement.querySelectorAll('.group\\/timeline-node');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toHaveTextContent('Alpha');
    expect(nodes[0]).toHaveTextContent('Gamma');
    expect(nodes[0]).not.toHaveTextContent('Delta');
    expect(nodes[0].textContent?.trim().endsWith('.')).toBe(true);
    expect(nodes[1]).toHaveTextContent('Delta');
    expect(nodes[1]).toHaveTextContent('Zeta');
  });

  it('keeps raw thinking mode when later stream text contains bold markers', () => {
    const makeParts = (think: string) => [
      {
        idx: 0,
        part: {
          type: ContentTypes.THINK,
          think,
        } as unknown as TMessageContentParts,
      },
    ];
    const { rerender } = render(
      <RecoilRoot>
        <Timeline
          parts={makeParts('Opening raw thought.')}
          isSubmitting={true}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    rerender(
      <RecoilRoot>
        <Timeline
          parts={makeParts('Opening raw thought.\n\n**Fake summary title**\nStill raw.')}
          isSubmitting={true}
          isLast={true}
          lastContentIdx={0}
          searchResults={undefined}
          getAttachments={() => undefined}
          renderPart={() => null}
        />
      </RecoilRoot>,
    );

    openActivity();

    expect(screen.getByRole('button', { name: /Thinking/ })).toBeInTheDocument();
    expect(screen.getByText(/\*\*Fake summary title\*\*/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fake summary title/ })).not.toBeInTheDocument();
  });

  it('shows the active node line while thinking is still streaming', () => {
    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'Active raw thought.',
          } as unknown as TMessageContentParts,
        },
      ],
      isSubmitting: true,
    });

    openActivity();

    expect(screen.getByTestId('timeline-node-line').className).not.toContain('group-last');
  });

  it('keeps generic tool detail collapsible inside the timeline', () => {
    const toolPart = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'tool-1',
        type: ToolCallTypes.TOOL_CALL,
        name: 'custom_tool',
        args: '{}',
        output: 'done',
        progress: 1,
      },
    } as unknown as TMessageContentParts;

    renderTimeline({
      parts: [
        {
          idx: 0,
          part: {
            type: ContentTypes.THINK,
            think: 'Need a helper tool.',
          } as unknown as TMessageContentParts,
        },
        { idx: 1, part: toolPart },
      ],
      renderPart: () => <div data-testid="tool-detail" />,
    });

    openActivity();

    const toolToggle = screen.getByRole('button', { name: /Completed custom_tool/ });
    expect(toolToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('tool-detail')).toBeInTheDocument();

    fireEvent.click(toolToggle);
    expect(toolToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('tool-detail')).toBeInTheDocument();
  });
});
