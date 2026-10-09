import { resolve } from 'node:path';

import type OpenAI from 'openai';

type ReadText = (path: string) => string;

export type YmaxToolSet = {
  systemPrompt: string;
  tools: OpenAI.ChatCompletionFunctionTool[];
};

const TOOL_HEADING = /^##\s+(.+?)\s*$/gm;

/**
 * Loads the MCP server's own instructions and tool descriptions straight from
 * a ymax-mcp-infra checkout, so the eval always tests the current wording.
 *
 * Input schemas are left empty: they are Zod schemas inside mcp.ts and are not
 * exported. That is enough to test which tool gets picked, not its arguments.
 */
export const loadYmaxTools = (
  readText: ReadText,
  instructionsDir: string,
): YmaxToolSet => {
  const systemPrompt = readText(
    resolve(instructionsDir, 'server-instructions.md'),
  );
  const markdown = readText(resolve(instructionsDir, 'tool-descriptions.md'));
  const headings = [...markdown.matchAll(TOOL_HEADING)];

  const tools = headings.map((heading, index) => {
    const name = heading[1];
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? markdown.length;
    const description = markdown.slice(bodyStart, bodyEnd).trim();
    if (!name || !description)
      throw new Error(`Malformed tool section at heading ${index + 1}`);

    return {
      type: 'function' as const,
      function: {
        name,
        description,
        parameters: { type: 'object', properties: {} },
      },
    };
  });

  if (tools.length === 0)
    throw new Error(`No "## tool_name" sections found in ${instructionsDir}`);

  return { systemPrompt, tools };
};
