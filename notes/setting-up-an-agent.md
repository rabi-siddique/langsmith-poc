# Setting up an agent with Mastra and a local model

An agent is a model that can call tools in a loop. These are the objects you
need, in the order you would write them. The first five go in
`src/mastra/agents/agent.ts`, the last one in `src/mastra/index.ts`.

## 1. Model

Where the agent sends its prompts. For Ollama, use its OpenAI-compatible URL.
No API key is needed.

```ts
const localModel = {
  id: 'ollama/qwen3-16k:8b', // provider/model-name
  url: 'http://localhost:11434/v1',
} as const;
```

`qwen3-16k:8b` is `qwen3:8b` with a bigger context window. Ollama's default
window is 4,096 tokens, which is smaller than the prompt plus tool list. Create
it once from the `Modelfile`:

```
FROM qwen3:8b
PARAMETER num_ctx 16384
```

```sh
ollama create qwen3-16k:8b -f Modelfile
```

## 2. Tools

A tool is a function the model may call. `description` and the schema are what
the model reads to decide when and how to call it.

```ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const wordCountTool = createTool({
  id: 'word_count',
  description: 'Count the words in a piece of text.',
  inputSchema: z.object({
    text: z.string().describe('The text to count'),
  }),
  outputSchema: z.object({ words: z.number() }),
  execute: async ({ text }) => ({
    words: text.trim().split(/\s+/).filter(Boolean).length,
  }),
});
```

Add `requireApproval: true` to make the agent wait for your OK before it runs:

```ts
const sendEmailTool = createTool({
  id: 'send_email',
  description: 'Send an email.',
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  requireApproval: true,
  execute: async ({ to }) => `Sent to ${to}`,
});
```

Mastra also ships ready-made tools:

```ts
import { askUserTool, webFetchTool } from '@mastra/core/tools';
```

## 3. Workspace

Gives the agent file and command tools, limited to one folder. You do not list
these tools yourself; passing `workspace` to the agent adds them.

```ts
import {
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  Workspace,
} from '@mastra/core/workspace';

const workspace = new Workspace({
  id: 'agent-workspace',
  name: 'Agent Workspace',
  filesystem: new LocalFilesystem({ basePath: 'workspace' }), // file tools
  sandbox: new LocalSandbox({ workingDirectory: 'workspace' }), // command tool
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { requireApproval: true },
  },
});
```

## 4. Memory

Keeps the conversation between turns. It needs storage (step 6) to save to.

```ts
import { Memory } from '@mastra/memory';

// Simplest: send the last 20 messages back to the model each turn.
const memory = new Memory({
  options: { lastMessages: 20 },
});
```

What this project uses: thread titles, plus observational memory, which
summarises old messages so long chats still fit in the model's window.

```ts
const memory = new Memory({
  options: {
    generateTitle: true,
    observationalMemory: {
      model: localModel,
      // Defaults are 30k and 40k tokens, too big for a 16k window.
      observation: { messageTokens: 4_000 },
      reflection: { observationTokens: 2_500 },
    },
  },
});
```

## 5. Agent

Ties everything together. `id`, `name`, `instructions` and `model` are enough
for a working agent; the rest is optional.

```ts
import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';

export const agent = new Agent({
  id: 'agent', // used in API routes: /api/agents/agent
  name: 'code-assistant', // display name
  description: 'A local coding assistant.',
  instructions: SYSTEM_PROMPT, // the system prompt
  model: localModel,
  tools: {
    // The key is the name the model sees.
    word_count: wordCountTool,
    web_fetch: webFetchTool,
    ask_user: askUserTool,
  },
  workspace,
  memory,
  signals: [new TaskSignalProvider()], // adds the task-list tools
  defaultOptions: { maxSteps: 20 }, // max model/tool rounds per turn
  metadata: {
    suggestedPrompts: ['List the files in the workspace.'], // shown in Studio
  },
});
```

## 6. Storage and registration

The `Mastra` object is what the server loads. Register the agent here and give
it a database for memory to save to.

```ts
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { agent } from './agents/agent';

export const mastra = new Mastra({
  agents: { agent },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: 'file:./mastra.db', // a local SQLite file
  }),
});
```

This project wraps that store in a `MastraCompositeStore` so traces go to a
separate DuckDB file. See `src/mastra/index.ts`.

## 7. Run and test

```sh
yarn tsc --noEmit   # type-check
yarn dev            # Studio at http://localhost:4111
```

Send one plain message and one that needs a tool. A reply alone does not prove
the tools work.

## Gotchas we hit

- **`npm error code EALLOWSCRIPTS` when scaffolding.** A user-level
  `allow-scripts` line in `~/.npmrc` breaks any `npm install` started from
  inside `npx` or `npm run`
  ([npm/cli#9968](https://github.com/npm/cli/issues/9968)). Scaffold with
  `--no-install`, then run `yarn install` yourself.
- **The model says it has no tool for the job.** The prompt was truncated. Look
  for `truncating input prompt` in `~/.ollama/logs/server.log`, then raise
  `num_ctx` in the `Modelfile`.
- **`webSearchTool` fails with a local model.** It only works with OpenAI,
  Anthropic, Google and xAI models. Use `webFetchTool` instead.
- **Chats are a local file.** They live in `src/mastra/public/mastra.db`, which
  is not in git. Deleting that folder deletes the history.

## Sources

- [Mastra: use local models](https://mastra.ai/models)
- [Ollama: setting the context size for the OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility)
- Mastra's docs for the installed version:
  `node_modules/@mastra/core/dist/docs/references/`
