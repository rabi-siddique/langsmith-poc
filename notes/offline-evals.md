# Offline evals for the agent

An offline eval runs a fixed list of prompts through the real agent and checks
the results. You run it yourself, before or after a change, to see whether the
agent got better or worse.

| File                                       | What it holds                         |
| ------------------------------------------ | ------------------------------------- |
| `evals/code-assistant.eval.ts`             | The cases and the loop that runs them |
| `src/mastra/scorers/correctness-scorer.ts` | The LLM judge                         |
| `src/mastra/index.ts`                      | Registers the scorers                 |
| `vitest.config.ts`, `evals/load-env.ts`    | Test runner setup                     |

## 1. Run them

```sh
yarn eval                         # all cases, on the model set by AGENT_MODEL
yarn eval -t "greeting"           # only cases whose name matches
AGENT_MODEL=openrouter yarn eval  # try another model without editing .env
```

It needs the key for the agent's model, plus `CLOUDFLARE_API_KEY` and
`CLOUDFLARE_ACCOUNT_ID` for the judge. The command exits with an error if any
case fails. `-t` is Vitest's [test name filter][vitest-t].

## 2. What a case looks like

Each case is checked in up to three ways. All of them must pass. Gates and
thresholds are how Mastra turns scores into a pass or fail
([Gates and verdicts][gates]).

```ts
{
  name: 'creates a script and runs it',
  input: 'Create hello.js that prints "Hello, world", then run it.',

  // 1. Gates: free, instant checks on the answer text or the tool calls.
  gates: [checks.calledTool(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND)],

  // 2. Ground truth: what the LLM judge looks for in the final answer.
  groundTruth: {
    must: [
      'Report that hello.js was created.',
      'Report that running it printed "Hello, world".',
    ],
    mustNot: ['Report an error that was left unresolved.'],
  },

  // 3. Workspace check: look at the files the agent left behind.
  checkWorkspace: async readWorkspaceFile => {
    expect.soft(await readWorkspaceFile('hello.js')).toContain('Hello, world');
  },
},
```

Use a gate when plain code can check it. Use the judge for meaning, where the
wording can vary. Use a workspace check when the proof is a file on disk.

## 3. Add a case

Add an object to the `cases` array. `workspaceFiles` puts files in the
workspace before the agent runs:

```ts
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
```

The gates come from `@mastra/evals/checks` ([Quick checks][quick-checks],
[full reference][checks-ref]):

| Check                                                 | Passes when                      |
| ----------------------------------------------------- | -------------------------------- |
| `checks.includes(text)` / `checks.excludes(text)`     | The answer has / lacks the text  |
| `checks.matches(regex)`                               | The answer matches the pattern   |
| `checks.calledTool(name)` / `checks.didNotCall(name)` | The tool was / was not called    |
| `checks.usedNoTools()`                                | No tool was called               |
| `checks.maxToolCalls(n)`                              | At most `n` tool calls were made |
| `checks.noToolErrors()`                               | No tool call failed              |

Workspace tools are named `mastra_workspace_*`. Take the name from
`WORKSPACE_TOOLS` instead of typing it.

Rules for a good case:

- **Keep it harmless.** The prompt runs for real: the agent writes files and
  runs shell commands on your machine without asking. Workspace tools need no
  approval unless the workspace config sets it
  ([Workspace tool configuration][workspace-class]).
- **No delete, `ask_user` or schedule prompts.** They wait for a person
  ([`ask_user`][ask-user]) or keep running after the eval ends.
- **Write criteria about meaning.** "State that the codename is X", not the
  exact sentence you expect.
- **One of each kind of check per case.** Every `checks.includes()` has the
  same id (`check-includes`); the [evals overview][overview] says the same of
  `checks.calledTool()`. We have not tried two in one case.

## 4. The judge

A second model reads the question, the answer and the case's `groundTruth`,
and returns pass or fail with a reason. It follows the judge in Mastra's
[eval loop guide][eval-loop] and is built with
[`createScorer`][custom-scorers].

```ts
export const correctnessScorer = createScorer({
  id: 'correctness',
  type: 'agent',
  judge: { model: JUDGE_MODEL, instructions: JUDGE_INSTRUCTIONS },
})
  .analyze({
    outputSchema: z.object({ passed: z.boolean(), reason: z.string() }),
    createPrompt: ({ run }) => {
      const groundTruth = expectedBehaviorSchema.parse(run.groundTruth);
      return JSON.stringify({
        question: extractInputMessages(run.input).join('\n'),
        groundTruth,
        answer: extractAgentResponseMessages(run.output).join('\n'),
      });
    },
  })
  .generateScore(({ results }) => (results.analyzeStepResult.passed ? 1 : 0))
  .generateReason(({ results }) => results.analyzeStepResult.reason);
```

- **The score is 1 or 0.** A partly right answer fails, so one wrong claim
  cannot hide behind a mostly good answer. The [eval loop guide][eval-loop]
  makes the same choice.
- **The judge model is fixed** (`@cf/openai/gpt-oss-120b`). If it followed
  `AGENT_MODEL`, you could not compare the scores of two agent models. The
  guide also says to keep the judge fixed when comparing changes.
- **It only sees the text of the agent's replies**, not the tool calls. That
  is what `extractAgentResponseMessages` returns ([scorer utils][scorer-utils]).
  Gates and workspace checks cover the tool calls.

## 5. How a case runs

This is the loop at the bottom of the eval file, shortened:

```ts
test.for(cases)('$name', async evalCase => {
  // Empty the workspace and write this case's files.
  await resetWorkspace(nodeFs, workspaceDirectory, evalCase.workspaceFiles);

  // A new thread per case, so nothing is remembered between cases.
  const threadId = `eval-${randomUUID()}`;
  await memory!.createThread({ threadId, resourceId: EVAL_RESOURCE_ID });

  try {
    await expectEval({
      target: mastra.getAgent('agent'),
      data: { input: evalCase.input, groundTruth: evalCase.groundTruth },
      gates: evalCase.gates,
      scorers: [
        { scorer: correctnessScorer, threshold: 1 }, // must score 1
        checks.noToolErrors(), // no threshold: shown, but cannot fail the case
      ],
      targetOptions: {
        maxSteps: 20,
        memory: { thread: threadId, resource: EVAL_RESOURCE_ID },
      },
    }).toPass();
  } finally {
    // Runs even when the eval fails, so both problems are reported.
    await evalCase.checkWorkspace?.(readWorkspaceFile);
  }
});
```

- **`expectEval` and `test.for`** come from Mastra's
  [Vitest integration][vitest-integration]. `expectEval` takes the same options
  as [`runEvals`][run-evals], with one data item instead of a list.
- **`mastra.getAgent('agent')`, not a direct import.** Mastra's docs say to get
  the target this way, so scores are saved and tools can reach the Mastra
  instance ([Running scorers in CI][running-in-ci]).
- **The thread must exist first.** Mastra's docs say observational memory fails
  without a thread that was already created
  ([Evals with memory][evals-memory]).
- **Register scorers in `src/mastra/index.ts`.** Mastra only saves the scores
  of registered scorers. An unregistered one still scores, but prints a
  warning ([Evals overview, "Score persistence"][overview]). In our runs only
  the `scorers` list warned, not the gates.
- **`expect.soft` in the workspace checks.** A [soft assertion][expect-soft]
  records a failure and lets the test go on, so a file problem and a judge
  failure are both reported.

## 6. Read the output

For each case, the judge's score and reason are printed, plus the agent's
answer when it failed. A score table comes at the end, printed by Mastra's
reporter ([Vitest integration][vitest-integration]):

```text
• 'creates a script and runs it' (1 item)
   check-called-tool (gate)          1.0  ✓
   correctness (threshold: min 1)    0.0  ✗
   check-no-tool-errors              1.0
```

Before the case name, `✓` means it passed, `•` means the gates passed but
the judge did not, and `✗` means a gate failed. The docs only show `✓`; the
other two marks are from the reporter's source code. A line with no mark, like
`check-no-tool-errors`, is a scorer without a threshold, which is tracked but
cannot fail the case ([Gates and verdicts][gates]).

Results on 2026-10-11:

| `AGENT_MODEL` | Passed | Notes                                                        |
| ------------- | ------ | ------------------------------------------------------------ |
| `openrouter`  | 6 of 6 | One run                                                      |
| `cloudflare`  | 4 of 6 | Same on three runs. It printed tool-call text as its answer. |

Models do not give the same answer every time, so run a case more than once
before trusting a single pass or fail.

## Gotchas we hit

- **A judge error looks like an agent failure.** If the judge's API call fails,
  the case fails with no `Judge` line. Look for `Upstream LLM API error` in the
  output.
- **Free tiers run out fast.** Every case is one judge call. Gemini's free tier
  stopped the judge at a limit of 20 requests and said to retry about 18 hours
  later ([Gemini rate limits][gemini-limits]). That is about three runs, and
  it is why the judge moved to Cloudflare.
- **`Scorer with id check-no-tool-errors not found`.** The scorer was not
  registered in `src/mastra/index.ts`. Scoring still works, but the score is
  not saved ([Evals overview][overview]).
- **Vitest must be version 3 or 4** ([Vitest integration][vitest-integration]).
  The peer dependency of `@mastra/evals` 1.10.5 rules out Vitest 5. We use 4.
- **Vitest only loads `.env` values that start with `VITE_`**
  ([Vitest environment variables][vitest-env]). So `evals/load-env.ts` loads
  the file with Node's [`process.loadEnvFile`][node-process]. In our test, a
  value set in the shell won over the one in `.env`.
- **Eval runs use their own files.** They save to `mastra.db` and
  `mastra.duckdb` in the project root and use `workspace/` there. Studio uses
  the files in `src/mastra/public/`, so it should not show these runs. We did
  not check this in Studio.

## Sources

Mastra:

- [Evals overview][overview]
- [Build an eval loop][eval-loop]
- [Quick checks][quick-checks] and the [checks reference][checks-ref]
- [Gates and verdicts][gates]
- [Custom scorers][custom-scorers] and [scorer utils][scorer-utils]
- [Vitest integration][vitest-integration]
- [Evals with memory][evals-memory]
- [Running scorers in CI][running-in-ci]
- [`runEvals` reference][run-evals]
- [Workspace class reference][workspace-class]
- [`ask_user` tool reference][ask-user]

Others:

- [Vitest: environment variables][vitest-env]
- [Vitest: `expect.soft`][expect-soft]
- [Vitest: `testNamePattern` (`-t`)][vitest-t]
- [Node.js: `process` API, see `process.loadEnvFile`][node-process]
- [Gemini API rate limits][gemini-limits]

The website follows the newest release. The docs that match the installed
version are in `node_modules/@mastra/core/dist/docs/references/` and
`node_modules/@mastra/evals/dist/docs/references/`.

[overview]: https://mastra.ai/docs/evals/overview
[eval-loop]: https://mastra.ai/docs/guides/build-an-eval-loop
[quick-checks]: https://mastra.ai/docs/evals/quick-checks
[checks-ref]: https://mastra.ai/reference/evals/checks
[gates]: https://mastra.ai/docs/evals/gates-and-verdicts
[custom-scorers]: https://mastra.ai/docs/evals/custom-scorers
[scorer-utils]: https://mastra.ai/reference/evals/scorer-utils
[vitest-integration]: https://mastra.ai/docs/evals/vitest-integration
[evals-memory]: https://mastra.ai/docs/evals/evals-with-memory
[running-in-ci]: https://mastra.ai/docs/evals/running-in-ci
[run-evals]: https://mastra.ai/reference/evals/run-evals
[workspace-class]: https://mastra.ai/reference/workspace/workspace-class
[ask-user]: https://mastra.ai/reference/tools/ask-user-tool
[vitest-env]: https://vitest.dev/guide/features#environment-variables
[expect-soft]: https://vitest.dev/api/expect#soft
[vitest-t]: https://vitest.dev/guide/cli#testnamepattern
[node-process]: https://nodejs.org/api/process.html
[gemini-limits]: https://ai.google.dev/gemini-api/docs/rate-limits
