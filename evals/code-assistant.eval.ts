import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type { MastraScorer } from '@mastra/core/evals';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { checks } from '@mastra/evals/checks';
import { expectEval } from '@mastra/evals/vitest';
import { afterAll, expect, test } from 'vitest';
import { mastra } from '../src/mastra';
import { workspacePath } from '../src/mastra/agents/agent';
import {
  correctnessScorer,
  type ExpectedBehavior,
} from '../src/mastra/scorers/correctness-scorer';

type FileSystem = Pick<typeof nodeFs, 'mkdir' | 'rm' | 'writeFile'>;

type ReadWorkspaceFile = (filePath: string) => Promise<string>;

// The part of a finished eval run that gets printed.
type CompletedRun = {
  targetResult: { text: string };
  scorerResults: Record<string, { score?: number; reason?: string }>;
};

type EvalCase = {
  name: string;
  input: string;
  // Files put in the workspace before the agent runs, as path -> content.
  workspaceFiles?: Record<string, string>;
  // Free, instant checks that must all pass.
  gates?: MastraScorer<any, any, any, any>[];
  // What the LLM judge looks for in the agent's final answer.
  groundTruth: ExpectedBehavior;
  // Checks the files the agent left behind.
  checkWorkspace?: (readWorkspaceFile: ReadWorkspaceFile) => Promise<void>;
};

const EVAL_RESOURCE_ID = 'eval-suite';

// The eval prompts run for real: the agent writes files and runs shell commands on this
// machine without asking. Keep every prompt harmless, and leave out deleting, ask_user
// and schedules, which wait for a person or keep running after the eval ends.
const cases: EvalCase[] = [
  {
    name: 'answers a greeting without tools',
    input: 'Hi there!',
    gates: [checks.usedNoTools()],
    groundTruth: {
      must: ['Greet the user or offer to help.'],
      mustNot: ['Claim to have read, changed or run anything.'],
    },
  },
  {
    name: 'answers a knowledge question without tools',
    input:
      'In one or two sentences, what does Array.prototype.map return in JavaScript?',
    gates: [checks.usedNoTools()],
    groundTruth: {
      must: [
        'Say that map returns a new array holding the result of calling the callback on each element.',
      ],
      mustNot: ['Say that map changes the original array.'],
    },
  },
  {
    name: 'lists the files in the workspace',
    input: 'List the files in the workspace.',
    workspaceFiles: {
      'notes.txt': 'Buy milk.\n',
      'app.js': "console.log('app');\n",
    },
    gates: [checks.includes('notes.txt')],
    groundTruth: {
      must: ['Name both notes.txt and app.js as files in the workspace.'],
      mustNot: ['Name any file other than notes.txt and app.js.'],
    },
  },
  {
    name: 'reads a fact from a file',
    input: 'What is the project codename written in notes.txt?',
    workspaceFiles: {
      'notes.txt': 'Project codename: BLUE-HERON-42\n',
    },
    gates: [checks.includes('BLUE-HERON-42')],
    groundTruth: {
      must: ['State that the project codename is BLUE-HERON-42.'],
      mustNot: ['Give any other codename.'],
    },
  },
  {
    name: 'creates a script and runs it',
    input: 'Create hello.js that prints "Hello, world", then run it.',
    gates: [checks.calledTool(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND)],
    groundTruth: {
      must: [
        'Report that hello.js was created.',
        'Report that running it printed "Hello, world".',
      ],
      mustNot: ['Report an error that was left unresolved.'],
    },
    checkWorkspace: async readWorkspaceFile => {
      expect.soft(await readWorkspaceFile('hello.js')).toContain('Hello, world');
    },
  },
  {
    name: 'edits an existing file',
    input: 'In app.js, change the greeting from "Hello" to "Goodbye".',
    workspaceFiles: {
      'app.js': "const greeting = 'Hello';\nconsole.log(greeting);\n",
    },
    groundTruth: {
      must: ['Report that the greeting in app.js was changed to "Goodbye".'],
      mustNot: ['Say the change could not be made.'],
    },
    checkWorkspace: async readWorkspaceFile => {
      const appSource = await readWorkspaceFile('app.js');
      expect.soft(appSource).toContain('Goodbye');
      expect.soft(appSource).not.toContain('Hello');
    },
  },
];

// Empties the workspace and writes the case's files, so one case cannot affect the next.
const resetWorkspace = async (
  fs: FileSystem,
  workspaceDirectory: string,
  files: Record<string, string> = {},
) => {
  await fs.rm(workspaceDirectory, { recursive: true, force: true });
  await fs.mkdir(workspaceDirectory, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspaceDirectory, filePath), content);
  }
};

// Resolved through the Mastra instance, not imported directly, so the agent's tools can
// reach storage and schedules as they do in the server.
const agent = mastra.getAgent('agent');
const workspaceDirectory = path.resolve(workspacePath);

// A missing file reads as empty, so a workspace check fails with a normal assertion instead of throwing.
const readWorkspaceFile: ReadWorkspaceFile = filePath =>
  nodeFs
    .readFile(path.join(workspaceDirectory, filePath), 'utf8')
    .catch(() => '');

test.for(cases)('$name', async evalCase => {
  await resetWorkspace(nodeFs, workspaceDirectory, evalCase.workspaceFiles);

  // Observational memory needs a thread that already exists. Each case gets its own,
  // so nothing is remembered from one case to the next.
  const memory = await agent.getMemory();
  const threadId = `eval-${randomUUID()}`;
  await memory!.createThread({
    threadId,
    resourceId: EVAL_RESOURCE_ID,
    title: evalCase.name,
  });

  try {
    await expectEval({
      target: agent,
      data: { input: evalCase.input, groundTruth: evalCase.groundTruth },
      gates: evalCase.gates,
      scorers: [
        { scorer: correctnessScorer, threshold: 1 },
        // No threshold: shown in the score table, but a tool error the agent recovers from does not fail the case.
        checks.noToolErrors(),
      ],
      targetOptions: {
        maxSteps: 20,
        memory: { thread: threadId, resource: EVAL_RESOURCE_ID },
      },
      onItemComplete: ({ targetResult, scorerResults }: CompletedRun) => {
        const judgment = scorerResults[correctnessScorer.id];
        console.log(`Judge (${judgment?.score}): ${judgment?.reason}`);
        if (judgment?.score !== 1) {
          console.log(`Answer: ${targetResult.text}`);
        }
      },
    }).toPass();
  } finally {
    // Runs even when the eval fails, so the report also says what the agent did to the files.
    await evalCase.checkWorkspace?.(readWorkspaceFile);
  }
});

// Flushes the traces of the eval runs before the process exits.
afterAll(() => mastra.shutdown());
