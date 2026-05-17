import React from 'react';
import { render, screen } from '@testing-library/react';
import Markdown from '../Markdown';
import { RecoilRoot } from 'recoil';
import { UI_RESOURCE_MARKER } from '~/components/MCPUIResource/plugin';
import {
  useMessageContext,
  useOptionalMessagesConversation,
  useOptionalMessagesOperations,
} from '~/Providers';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useLocalize } from '~/hooks';

// Mocks for hooks used by MCPUIResource when rendered inside Markdown.
// Keep Provider components intact while mocking only the hooks we use.
jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers'),
  useMessageContext: jest.fn(),
  useOptionalMessagesConversation: jest.fn(),
  useOptionalMessagesOperations: jest.fn(),
}));
jest.mock('~/data-provider');
jest.mock('~/hooks');

// Mock @mcp-ui/client to render identifiable elements for assertions
jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: ({ resource }: any) => (
    <div data-testid="ui-resource-renderer" data-resource-uri={resource?.uri} />
  ),
}));

const mockUseMessageContext = useMessageContext as jest.MockedFunction<typeof useMessageContext>;
const mockUseMessagesConversation = useOptionalMessagesConversation as jest.MockedFunction<
  typeof useOptionalMessagesConversation
>;
const mockUseMessagesOperations = useOptionalMessagesOperations as jest.MockedFunction<
  typeof useOptionalMessagesOperations
>;
const mockUseGetMessagesByConvoId = useGetMessagesByConvoId as jest.MockedFunction<
  typeof useGetMessagesByConvoId
>;
const mockUseLocalize = useLocalize as jest.MockedFunction<typeof useLocalize>;

describe('Markdown with MCP UI markers (resource IDs)', () => {
  let currentTestMessages: any[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    currentTestMessages = [];

    mockUseMessageContext.mockReturnValue({ messageId: 'msg-weather' } as any);
    mockUseMessagesConversation.mockReturnValue({
      conversation: { conversationId: 'conv1' },
      conversationId: 'conv1',
    } as any);
    mockUseMessagesOperations.mockReturnValue({
      ask: jest.fn(),
      getMessages: () => currentTestMessages,
    } as any);
    mockUseLocalize.mockReturnValue(((key: string) => key) as any);
  });

  it('renders two UIResourceRenderer components for markers with resource IDs across separate attachments', () => {
    // Two tool responses, each produced one ui_resources attachment
    const paris = {
      resourceId: 'abc123',
      uri: 'ui://weather/paris',
      mimeType: 'text/html',
      text: '<div>Paris Weather</div>',
    };
    const nyc = {
      resourceId: 'def456',
      uri: 'ui://weather/nyc',
      mimeType: 'text/html',
      text: '<div>NYC Weather</div>',
    };

    currentTestMessages = [
      {
        messageId: 'msg-weather',
        attachments: [
          { type: 'ui_resources', ui_resources: [paris] },
          { type: 'ui_resources', ui_resources: [nyc] },
        ],
      },
    ];

    mockUseGetMessagesByConvoId.mockReturnValue({ data: currentTestMessages } as any);

    const content = [
      'Here are the current weather conditions for both Paris and New York:',
      '',
      '- Paris: Slight rain, 53°F, humidity 76%, wind 9 mph.',
      '- New York: Clear sky, 63°F, humidity 91%, wind 6 mph.',
      '',
      `Browse these weather cards for more details ${UI_RESOURCE_MARKER}{abc123} ${UI_RESOURCE_MARKER}{def456}`,
    ].join('\n');

    render(
      <RecoilRoot>
        <Markdown content={content} isLatestMessage={false} />
      </RecoilRoot>,
    );

    const renderers = screen.getAllByTestId('ui-resource-renderer');
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveAttribute('data-resource-uri', 'ui://weather/paris');
    expect(renderers[1]).toHaveAttribute('data-resource-uri', 'ui://weather/nyc');
  });
});

describe('Markdown streaming word animation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMessageContext.mockReturnValue({ messageId: 'msg-stream', partIndex: 0 } as any);
    mockUseLocalize.mockReturnValue(((key: string) => key) as any);
  });

  it('shows the shimmer thinking placeholder only for the latest initializing message', () => {
    const { container, rerender } = render(
      <RecoilRoot>
        <Markdown content="" isLatestMessage={true} />
      </RecoilRoot>,
    );

    expect(screen.getByText('com_ui_thinking')).toHaveClass('thinking-shimmer');

    rerender(
      <RecoilRoot>
        <Markdown content="" isLatestMessage={false} />
      </RecoilRoot>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('wraps prose words only when streaming word animation is enabled', () => {
    const { container, rerender } = render(
      <RecoilRoot>
        <Markdown content="Hello **bright** world" isLatestMessage={true} />
      </RecoilRoot>,
    );

    expect(container.querySelectorAll('[data-streaming-word]')).toHaveLength(0);

    rerender(
      <RecoilRoot>
        <Markdown content="Hello **bright** world" animateWords={true} isLatestMessage={true} />
      </RecoilRoot>,
    );

    const words = Array.from(container.querySelectorAll('[data-streaming-word]'));
    expect(words.map((word) => word.textContent)).toEqual(['Hello', 'bright', 'world']);
  });

  it('does not wrap code words for streaming animation', () => {
    const { container } = render(
      <RecoilRoot>
        <Markdown
          animateWords={true}
          content={'A word before `const value = "still code";`'}
          isLatestMessage={true}
        />
      </RecoilRoot>,
    );

    const animatedWords = Array.from(container.querySelectorAll('[data-streaming-word]')).map(
      (word) => word.textContent,
    );

    expect(animatedWords).toEqual(['A', 'word', 'before']);
    expect(container.querySelector('code')?.textContent).toContain('const value');
  });
});
