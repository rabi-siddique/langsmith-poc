import type { AnyExportedSpan } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';

// Studio sends each chat message to the agent as a signal: an object whose `contents`
// is the text, or a list of text and file parts. The agent run's span keeps the whole
// signal as its input.
type SignalInput = {
  type: string;
  contents: string | Array<{ type: string; text?: string }>;
};

// Legacy signals use 'user-message' for the same thing.
const isUserSignal = (input: unknown): input is SignalInput =>
  typeof input === 'object' &&
  input !== null &&
  'contents' in input &&
  'type' in input &&
  (input.type === 'user' || input.type === 'user-message');

const signalText = ({ contents }: SignalInput) =>
  typeof contents === 'string'
    ? contents
    : contents
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');

// Shapes spans for LangSmith's Threads view (https://docs.langchain.com/langsmith/threads),
// changing only what the LangSmith exporter sends:
// - Groups runs by Mastra memory thread. Mastra puts the threadId in every agent run
//   span's metadata, and child spans inherit it, but LangSmith groups by session_id or
//   thread_id. The exporter sends metadata.langsmith.sessionId as session_id.
// - Turns a Studio user signal into a plain user message. Otherwise each turn's
//   human message shows the signal's id instead of what the user typed.
export const formatSpanForLangsmithThreads = (
  span: AnyExportedSpan,
): AnyExportedSpan => {
  const threadId = span.metadata?.threadId;
  const metadata =
    typeof threadId === 'string'
      ? {
          ...span.metadata,
          langsmith: { ...span.metadata?.langsmith, sessionId: threadId },
        }
      : span.metadata;

  const input =
    span.type === SpanType.AGENT_RUN && isUserSignal(span.input)
      ? { messages: [{ role: 'user', content: signalText(span.input) }] }
      : span.input;

  // Returns a copy: the same span object goes to every exporter.
  return { ...span, metadata, input };
};
