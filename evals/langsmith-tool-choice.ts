// Runs a tool-choice experiment in LangSmith: does the agent call the tools a request
// needs, and no others? The dataset lives in LangSmith, so cases can be edited there or
// added from real runs. The cases below only seed it the first time.
//
// Run with: AGENT_MODEL=openrouter yarn eval:tools
import './load-env';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { Client } from 'langsmith';
import { evaluate, type EvaluationResult } from 'langsmith/evaluation';
import { mastra } from '../src/mastra';
import { workspacePath } from '../src/mastra/agents/agent';

type FileSystem = Pick<typeof nodeFs, 'mkdir' | 'rm' | 'writeFile'>;

type ToolCall = { name: string; args: Record<string, unknown> };

type CaseInputs = { question: string };

type CaseReference = {
  // Tools the agent must call. Empty means it should answer without tools.
  expectedTools: string[];
  // Arguments the first call to expectedTools[0] must have.
  expectedArgs?: Record<string, unknown>;
};

type TargetOutputs = {
  answer: string;
  toolCalls: ToolCall[];
  // The agent's own trace, in the agent-with-mastra project.
  traceId?: string;
};

type EvaluatorArgs = {
  outputs: Record<string, any>;
  referenceOutputs?: Record<string, any>;
};

const DATASET_NAME = 'agent-tool-choice';

const EVAL_RESOURCE_ID = 'langsmith-tool-choice';

// Files every case can see. Cases run one at a time and only read them.
const WORKSPACE_FILES: Record<string, string> = {
  'notes.txt': 'Project codename: BLUE-HERON-42\n',
  'app.js': "console.log('app');\n",
};

// The task list tools come from TaskSignalProvider and the agent may use them on any
// request, so they are not counted as unexpected.
const BOOKKEEPING_TOOLS = new Set([
  'task_write',
  'task_update',
  'task_complete',
  'task_check',
]);

// Harmless prompts only: they run for real. No delete, ask_user or schedule prompts,
// which wait for a person or keep running after the experiment ends.
const SEED_CASES: { inputs: CaseInputs; outputs: CaseReference }[] = [
  {
    inputs: { question: 'Use the sum tool to add 1234 and 5678.' },
    outputs: {
      expectedTools: ['everything_get-sum'],
      expectedArgs: { a: 1234, b: 5678 },
    },
  },
  {
    inputs: {
      question:
        'Echo this exact message back with your echo tool: ymax eval check',
    },
    outputs: { expectedTools: ['everything_echo'] },
  },
  {
    inputs: { question: 'List the files in the workspace.' },
    outputs: { expectedTools: [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES] },
  },
  {
    inputs: { question: 'What is the project codename written in notes.txt?' },
    outputs: { expectedTools: [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE] },
  },
  {
    inputs: { question: 'Hi there!' },
    outputs: { expectedTools: [] },
  },
  {
    inputs: {
      question:
        'In one sentence, what does Array.prototype.map return in JavaScript?',
    },
    outputs: { expectedTools: [] },
  },
];

const ensureDataset = async (client: Client) => {
  if (await client.hasDataset({ datasetName: DATASET_NAME })) return;
  const dataset = await client.createDataset(DATASET_NAME, {
    description: 'Prompts with the tools the agent should call for each.',
  });
  await client.createExamples(
    SEED_CASES.map(seedCase => ({ ...seedCase, dataset_id: dataset.id })),
  );
};

const resetWorkspace = async (fs: FileSystem, workspaceDirectory: string) => {
  await fs.rm(workspaceDirectory, { recursive: true, force: true });
  await fs.mkdir(workspaceDirectory, { recursive: true });
  for (const [filePath, content] of Object.entries(WORKSPACE_FILES)) {
    await fs.writeFile(path.join(workspaceDirectory, filePath), content);
  }
};

const agent = mastra.getAgent('agent');

// Runs one case through the real agent. Tool calls are read from the result, not from
// the trace: the agent's own trace goes to the agent-with-mastra project, separate from
// the experiment.
const runAgent = async ({ question }: CaseInputs): Promise<TargetOutputs> => {
  const memory = await agent.getMemory();
  const threadId = `tool-choice-${randomUUID()}`;
  await memory!.createThread({ threadId, resourceId: EVAL_RESOURCE_ID });

  const result = await agent.generate(question, {
    maxSteps: 10,
    memory: { thread: threadId, resource: EVAL_RESOURCE_ID },
  });

  const toolCalls = result.steps.flatMap(step =>
    step.toolCalls.map(call => ({
      name: call.payload.toolName,
      args: (call.payload.args ?? {}) as Record<string, unknown>,
    })),
  );
  return { answer: result.text, toolCalls, traceId: result.traceId };
};

const calledToolNames = (outputs: Record<string, any>): string[] =>
  (outputs as TargetOutputs).toolCalls.map(call => call.name);

// An example without expectedTools, such as a real run added to the dataset before it
// is labelled, gets no scores instead of failing.
const readReference = (referenceOutputs?: Record<string, any>) =>
  (referenceOutputs ?? {}) as Partial<CaseReference>;

// Every expected tool was called. Skipped for cases that expect no tools.
const expectedToolsCalled = ({
  outputs,
  referenceOutputs,
}: EvaluatorArgs): EvaluationResult[] => {
  const { expectedTools } = readReference(referenceOutputs);
  if (!expectedTools?.length) return [];
  const called = calledToolNames(outputs);
  const missing = expectedTools.filter(tool => !called.includes(tool));
  return [
    {
      key: 'expected_tools_called',
      score: missing.length === 0 ? 1 : 0,
      comment: missing.length ? `Not called: ${missing.join(', ')}` : undefined,
    },
  ];
};

// No tool was called beyond the expected ones and the task list tools.
const noUnexpectedTools = ({
  outputs,
  referenceOutputs,
}: EvaluatorArgs): EvaluationResult[] => {
  const { expectedTools } = readReference(referenceOutputs);
  if (!expectedTools) return [];
  const unexpected = calledToolNames(outputs).filter(
    tool => !expectedTools.includes(tool) && !BOOKKEEPING_TOOLS.has(tool),
  );
  return [
    {
      key: 'no_unexpected_tools',
      score: unexpected.length === 0 ? 1 : 0,
      comment: unexpected.length
        ? `Unexpected: ${[...new Set(unexpected)].join(', ')}`
        : undefined,
    },
  ];
};

// The first call to the expected tool had the expected arguments. Skipped for cases
// without expectedArgs.
const argsCorrect = ({
  outputs,
  referenceOutputs,
}: EvaluatorArgs): EvaluationResult[] => {
  const { expectedTools, expectedArgs } = readReference(referenceOutputs);
  if (!expectedTools?.length || !expectedArgs) return [];
  const call = (outputs as TargetOutputs).toolCalls.find(
    toolCall => toolCall.name === expectedTools[0],
  );
  const mismatched = Object.entries(expectedArgs).filter(
    ([name, value]) => call?.args[name] !== value,
  );
  return [
    {
      key: 'args_correct',
      score: call && mismatched.length === 0 ? 1 : 0,
      comment: call
        ? mismatched.length
          ? `Got ${JSON.stringify(call.args)}`
          : undefined
        : 'Tool not called',
    },
  ];
};

const client = new Client();
const agentModel = process.env.AGENT_MODEL || 'openrouter';

await ensureDataset(client);

const results = await evaluate(
  async (inputs: CaseInputs) => {
    await resetWorkspace(nodeFs, path.resolve(workspacePath));
    return runAgent(inputs);
  },
  {
    data: DATASET_NAME,
    evaluators: [expectedToolsCalled, noUnexpectedTools, argsCorrect],
    experimentPrefix: `tool-choice-${agentModel}`,
    metadata: { agentModel },
    // One case at a time: they share the workspace folder and free models are rate limited.
    maxConcurrency: 1,
    client,
  },
);

console.log(`Experiment: ${results.experimentName}`);

// Flushes the agent's traces before the process exits.
await mastra.shutdown();
// The demo MCP server runs as a child process and would keep this script alive.
process.exit(0);
