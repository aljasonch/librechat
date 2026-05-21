import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContentTypes, Tools, ToolCallTypes } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import Timeline from '../Timeline';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const dictionary: Record<string, string> = {
      com_assistants_completed_function: `Completed ${values?.[0] ?? ''}`,
      com_assistants_running_var: `Running ${values?.[0] ?? ''}`,
      com_ui_copy_thoughts_to_clipboard: 'Copy thoughts',
      com_ui_copied_to_clipboard: 'Copied',
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

describe('Timeline', () => {
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

    expect(screen.getByText('I will search first.')).toBeInTheDocument();
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

    expect(screen.getByText('Researching overview')).toHaveClass('text-text-primary');
    expect(screen.getByText('I will start broad.')).toBeInTheDocument();
    expect(screen.getAllByText('Evaluating sources')[0]).toHaveClass('thinking-shimmer');
    expect(screen.getAllByText('Evaluating sources')[1]).toHaveClass('text-text-primary');
    expect(screen.getByText('I will check citations.')).toBeInTheDocument();
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

    expect(screen.getByRole('button', { name: /Thinking/ })).toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
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

    const toolToggle = screen.getByRole('button', { name: /Completed custom_tool/ });
    expect(toolToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('tool-detail')).toBeInTheDocument();

    fireEvent.click(toolToggle);
    expect(toolToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('tool-detail')).toBeInTheDocument();
  });
});
