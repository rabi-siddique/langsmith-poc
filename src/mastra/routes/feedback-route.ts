import type { Mastra } from '@mastra/core/mastra';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';

const feedbackBodySchema = z.object({
  // The traceId of the agent reply being rated. A generate or stream result returns it,
  // and a saved assistant message keeps it in content.metadata.traceId.
  traceId: z.string().min(1),
  thumbsUp: z.boolean(),
  comment: z.string().optional(),
});

// The feedback key the rating appears under in LangSmith.
const FEEDBACK_KEY = 'user_thumbs';

// Traces are written to storage in batches up to 5 seconds apart, so a click right after
// the reply can come before its trace is saved. These are the delays Mastra's own
// addScore() retries with.
const TRACE_LOOKUP_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000, 2_000];

type Observability = Mastra['observability'];

const findRecordedTrace = async (
  observability: Observability,
  traceId: string,
) => {
  for (const delayMs of TRACE_LOOKUP_RETRY_DELAYS_MS) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const trace = await observability.getRecordedTrace?.({ traceId });
    if (trace) return trace;
  }
  return null;
};

// Records a user's thumbs up (1) or thumbs down (0) for one agent reply. The score goes
// through Mastra's observability, which saves it locally and the LangSmith exporter sends
// it on to LangSmith as feedback on the reply's run.
export const feedbackRoute = registerApiRoute('/feedback', {
  method: 'POST',
  handler: async c => {
    const body = feedbackBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        {
          error:
            'Expected { traceId: string, thumbsUp: boolean, comment?: string }',
        },
        400,
      );
    }
    const { traceId, thumbsUp, comment } = body.data;

    const trace = await findRecordedTrace(
      c.get('mastra').observability,
      traceId,
    );
    if (!trace) {
      return c.json(
        { error: `No trace with id ${traceId} in observability storage` },
        404,
      );
    }

    // Scored on the root span, the whole agent run: the LangSmith exporter drops a score
    // that has no span. It also only knows runs this server process sent to LangSmith,
    // so a rating for a reply from before the last restart is dropped with a warning.
    await trace.rootSpan.addScore({
      scorerId: FEEDBACK_KEY,
      scorerName: FEEDBACK_KEY,
      scoreSource: 'user',
      score: thumbsUp ? 1 : 0,
      reason: comment,
    });

    return c.json({ ok: true });
  },
});
