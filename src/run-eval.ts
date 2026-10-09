import { readFileSync } from 'node:fs';

import { Client } from 'langsmith';
import { evaluate, type EvaluationResult } from 'langsmith/evaluation';
import { traceable } from 'langsmith/traceable';
import OpenAI from 'openai';

import { loadYmaxTools, type YmaxToolSet } from './ymax-tools.ts';

type ToolPick = {
  tool: string;
  args: unknown;
  allTools: string[];
  text: string | null;
};

const NO_TOOL = 'none';

/**
 * The target: shows the model one request plus the YMax tools and records
 * which tool it would call. Nothing is executed, so no request can reach the
 * signer or the chain.
 */
const makePickTool = (openrouter: OpenAI, model: string, ymax: YmaxToolSet) =>
  traceable(
    async (inputs: { request: string }): Promise<ToolPick> => {
      const completion = await openrouter.chat.completions.create({
        model,
        tools: ymax.tools,
        messages: [
          { role: 'system', content: ymax.systemPrompt },
          { role: 'user', content: inputs.request },
        ],
      });
      const message = completion.choices[0]?.message;
      const functionCalls = (message?.tool_calls ?? []).filter(
        call => call.type === 'function',
      );
      const allTools = functionCalls.map(call => call.function.name);
      const toolCall = functionCalls[0];
      if (!toolCall)
        return {
          tool: NO_TOOL,
          args: null,
          allTools,
          text: message?.content ?? null,
        };

      // Free models sometimes emit malformed JSON; keep the raw string then.
      let args: unknown = toolCall.function.arguments;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {}
      return {
        tool: toolCall.function.name,
        args,
        allTools,
        text: message?.content ?? null,
      };
    },
    { name: 'pickTool' },
  );

const correctTool = ({
  outputs,
  referenceOutputs,
}: {
  outputs?: Record<string, any>;
  referenceOutputs?: Record<string, any>;
}): EvaluationResult => {
  const expected = referenceOutputs?.expected_tool;
  const accepted: unknown[] = Array.isArray(expected) ? expected : [expected];
  return {
    key: 'correct_tool',
    score: accepted.includes(outputs?.tool) ? 1 : 0,
  };
};

const model = process.env.OPENROUTER_MODEL;
if (!model) throw new Error('Set OPENROUTER_MODEL in .env');

const ymax = loadYmaxTools(
  path => readFileSync(path, 'utf8'),
  process.env.YMAX_INSTRUCTIONS_DIR ??
    '../ymax-mcp-infra/services/mcp-server/src/instructions',
);
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

await evaluate(makePickTool(openrouter, model, ymax), {
  client: new Client({ apiKey: process.env.LANGSMITH_API_KEY }),
  data: process.env.DATASET_NAME ?? 'ymax-tool-selection',
  evaluators: [correctTool],
  experimentPrefix: model.replace(/[/:]/g, '-'),
  metadata: { model },
  // Free OpenRouter models allow 20 requests/minute; one at a time stays under it.
  maxConcurrency: 1,
});
