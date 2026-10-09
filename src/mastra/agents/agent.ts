import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool, webFetchTool } from '@mastra/core/tools';
import {
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  Workspace,
} from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { mcpTools } from '../tools/mcp-tools';
import { startScheduleTool, stopScheduleTool } from '../tools/schedule-tools';

const SYSTEM_PROMPT = `You are a helpful coding assistant running in the user's terminal. Talk directly to the user.
You can use tools to read, write and edit files and run shell commands in the current folder. Only use them when the user's request needs them.
For greetings or questions you can answer yourself, just reply normally.`;

export const workspacePath = 'workspace';

type ModelChoice = {
  model: `${string}/${string}` | { id: `${string}/${string}`; url: string };
  // When to compress old messages. Leave out to use Mastra's defaults (30k and 40k tokens).
  memoryLimits?: {
    observation: { messageTokens: number };
    reflection: { observationTokens: number };
  };
};

// The models the agent can run on. Pick one with AGENT_MODEL in .env.
const MODELS: Record<string, ModelChoice> = {
  // Free OpenRouter model; needs OPENROUTER_API_KEY.
  openrouter: { model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free' },
  // Needs GOOGLE_API_KEY.
  gemini: { model: 'google/gemini-3.5-flash' },
  // Needs MISTRAL_API_KEY.
  mistral: { model: 'mistral/devstral-latest' },
  // Needs CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID.
  cloudflare: {
    model: 'cloudflare-workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
  },
  // Needs NVIDIA_API_KEY. The second "nvidia" is part of the model's own name.
  nvidia: { model: 'nvidia/nvidia/nemotron-3-super-120b-a12b' },
  // Needs OLLAMA_API_KEY. Runs on Ollama's servers, unlike "local" below.
  'ollama-cloud': { model: 'ollama-cloud/gpt-oss:120b' },
  // Needs ZHIPU_API_KEY.
  zai: { model: 'zai/glm-4.7-flash' },
  // Kilo Code's free gateway; no API key. The url is set here because Mastra's
  // built-in kilo provider asks for a key.
  kilo: {
    model: {
      id: 'kilo/nvidia/nemotron-3-super-120b-a12b:free',
      url: 'https://api.kilo.ai/api/gateway',
    },
  },
  // OVHcloud's anonymous tier; no API key, but only 2 requests a minute, so
  // multi-step tasks are slow. The url is set here for the same reason as kilo.
  ovh: {
    model: {
      id: 'ovhcloud/gpt-oss-120b',
      url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    },
  },
  // Ollama on this machine; no API key. Create the model from the Modelfile first.
  local: {
    model: { id: 'ollama/qwen3-16k:8b', url: 'http://localhost:11434/v1' },
    // The defaults do not fit this model's 16k context window.
    memoryLimits: {
      observation: { messageTokens: 4_000 },
      reflection: { observationTokens: 2_500 },
    },
  },
};

const DEFAULT_MODEL = 'openrouter';

const selectModel = (env: NodeJS.ProcessEnv): ModelChoice => {
  const name = env.AGENT_MODEL || DEFAULT_MODEL;
  const choice = MODELS[name];
  if (!choice) {
    throw new Error(
      `Unknown AGENT_MODEL "${name}". Use one of: ${Object.keys(MODELS).join(', ')}`,
    );
  }
  return choice;
};

const { model, memoryLimits } = selectModel(process.env);

const workspace = new Workspace({
  id: 'agent-workspace',
  name: 'Agent Workspace',
  filesystem: new LocalFilesystem({
    basePath: workspacePath,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: workspacePath,
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});

export const agent = new Agent({
  id: 'agent',
  name: 'code-assistant',
  description:
    'A local coding assistant that can read, write and edit files and run shell commands in its workspace folder.',
  metadata: {
    suggestedPrompts: [
      'List the files in the workspace.',
      'Create hello.js that prints "Hello, world", then run it.',
      'Build a simple landing page in index.html.',
    ],
  },
  instructions: SYSTEM_PROMPT,
  model,
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: { model, ...memoryLimits },
    },
  }),
  workspace,
  tools: {
    ask_user: askUserTool,
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    web_fetch: webFetchTool,
    ...mcpTools,
  },
  signals: [new TaskSignalProvider()],
});
