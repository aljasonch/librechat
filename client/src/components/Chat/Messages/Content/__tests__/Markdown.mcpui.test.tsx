import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { useConversationUIResources } from '~/hooks/Messages/useConversationUIResources';
import { UI_RESOURCE_MARKER } from '~/components/MCPUIResource/plugin';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';

// Mock specific leaf hook rather than barrel exports to avoid circular module evaluation in Jest
jest.mock('~/hooks/Messages/useConversationUIResources', () => ({
  useConversationUIResources: jest.fn(),
}));

// Mock @mcp-ui/client to render identifiable elements for assertions
jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: ({ resource }: any) => (
    <div data-testid="ui-resource-renderer" data-resource-uri={resource?.uri} />
  ),
}));

const mockUseConversationUIResources = useConversationUIResources as jest.MockedFunction<
  typeof useConversationUIResources
>;

describe('Markdown with MCP UI markers (resource IDs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

    const resourceMap = new Map<string, any>([
      ['abc123', paris],
      ['def456', nyc],
    ]);
    mockUseConversationUIResources.mockReturnValue(resourceMap as any);

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
  });

  it('shows only LibreChat loading cursor for the latest initializing message', () => {
    const { container, rerender } = render(
      <RecoilRoot>
        <Markdown content="" isLatestMessage={true} />
      </RecoilRoot>,
    );

    expect(container.querySelector('.result-thinking')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_thinking')).not.toBeInTheDocument();

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

describe('Markdown table rendering', () => {
  const tableMarkdown = [
    '| Alpha | Bravo | Charlie | Delta | Echo | Foxtrot | Golf | Hotel |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| one | two | three | four | five | six | seven | eight |',
  ].join('\n');

  it('wraps GFM tables in a horizontally scrollable container', () => {
    render(
      <RecoilRoot>
        <Markdown content={tableMarkdown} isLatestMessage={false} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('table').parentElement).toHaveClass(
      'markdown-table-wrapper',
      'w-full',
      'max-w-full',
    );
  });

  it('wraps lightweight Markdown tables in a horizontally scrollable container', () => {
    render(<MarkdownLite content={tableMarkdown} />);

    expect(screen.getByRole('table').parentElement).toHaveClass(
      'markdown-table-wrapper',
      'w-full',
      'max-w-full',
    );
  });
});
