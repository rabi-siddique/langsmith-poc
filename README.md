# agent-with-mastra

A coding assistant built with [Mastra](https://mastra.ai). It can read, write and edit files, run shell commands in its own `workspace/` folder, fetch web pages, track multi-step tasks, and create recurring schedules.

## Features

- A local `workspace/` for files and command execution (created under `src/mastra/public/workspace/` when running `yarn dev`)
- A choice of ten models, picked with one line in `.env`
- Read-before-write checks for file changes, and an approval gate for deletions
- Conversation memory, generated thread titles, and task tracking
- Direct web page fetching
- Recurring schedules that persist across restarts
- Local libSQL storage and DuckDB observability, with optional Turso storage
- Tracing with [Langfuse](https://langfuse.com) and [LangSmith](https://smith.langchain.com)
- An eval suite that checks the agent's answers and tool use (`yarn eval`)
- Live evals that grade real conversations with LangSmith's online evaluators
- A bundled Mastra skill that helps coding agents use current Mastra APIs

## Get started

You need Node.js 22.13 or newer and Yarn.

Copy the example env file and install the dependencies:

```shell
cp .env.example .env
yarn install
```

The agent uses a free [OpenRouter](https://openrouter.ai) model by default. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys), set `OPENROUTER_API_KEY` in `.env`, then start the dev server:

```shell
yarn dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview).

Select **Agent** in Mastra Studio and try one of these prompts:

- `List the files in the workspace.`
- `Create hello.js that prints "Hello, world", then run it.`
- `Build a simple landing page in index.html.`

## Choosing a model

Set `AGENT_MODEL` in `.env` to one of these names. The list lives in `src/mastra/agents/agent.ts`.

| `AGENT_MODEL`          | Model                                          | What it needs in `.env`                          |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `openrouter` (default) | `nvidia/nemotron-3-super-120b-a12b:free`       | `OPENROUTER_API_KEY`                             |
| `gemini`               | `gemini-3.5-flash`                             | `GOOGLE_API_KEY`                                 |
| `mistral`              | `devstral-latest`                              | `MISTRAL_API_KEY`                                |
| `cloudflare`           | `@cf/meta/llama-4-scout-17b-16e-instruct`      | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `nvidia`               | `nvidia/nemotron-3-super-120b-a12b`            | `NVIDIA_API_KEY`                                 |
| `ollama-cloud`         | `gpt-oss:120b`                                 | `OLLAMA_API_KEY`                                 |
| `zai`                  | `glm-4.7-flash`                                | `ZHIPU_API_KEY`                                  |
| `kilo`                 | `nvidia/nemotron-3-super-120b-a12b:free`       | No key                                           |
| `ovh`                  | `gpt-oss-120b`                                 | No key (2 requests a minute)                     |
| `local`                | `qwen3-16k:8b` on [Ollama](https://ollama.com) | No key                                           |

The same model also writes the memory summaries.

### Running on a local model

Start Ollama, create the model once, then set `AGENT_MODEL=local`:

```shell
ollama create qwen3-16k:8b -f Modelfile
```

The `Modelfile` raises the context window to 16k tokens, because Ollama's default is smaller than this agent's prompt and tool list.

## Workspace safety

The local filesystem tools stay inside the `workspace/` directory, which resolves relative to the server's working directory (`src/mastra/public/workspace/` during `yarn dev`).

- **Writing and editing** a file needs no approval, but the agent must read an existing file before it changes it.
- **Deleting** asks for your approval first.
- **Shell commands run without asking.** They start in the workspace directory, but `LocalSandbox` does not provide operating-system isolation by default, so a command can reach files outside it.

Do not expose this project through an unauthenticated public server. To add more approval gates, set `requireApproval` in the workspace `tools` config in `src/mastra/agents/agent.ts`.

## Storage

The default `file:./mastra.db` database stores agent memory, tasks, and schedules locally. During `yarn dev` it lives at `src/mastra/public/mastra.db`, which is not in git. To use Turso, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`.

Recurring schedules continue to use model tokens until you pause them. When the agent creates a schedule, it returns an ID. Ask the agent to pause the schedule with that ID.

## Tracing

Traces are saved locally in DuckDB and shown in Mastra Studio. To also see them in Langfuse, set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in `.env`.

To send them to LangSmith, set `LANGSMITH_API_KEY` in `.env`. They go to a tracing project named `agent-with-mastra`; the name is set in `src/mastra/index.ts`. Each exporter stays off while its keys are missing.

## Evals

Evals check that the agent still behaves well after you change its prompt, tools or model. Run them with:

```shell
yarn eval
```

This runs each case in `evals/code-assistant.eval.ts` through the real agent, using the model set by `AGENT_MODEL`, and exits with an error if any case fails. Each case is checked in up to three ways:

- **Gates** are free, instant checks that must pass, such as "the answer contains `notes.txt`" or "no tool was called".
- **The correctness judge** is a second model that reads the answer and marks it against the case's `must` and `mustNot` lists. It lives in `src/mastra/scorers/correctness-scorer.ts` and always uses `@cf/openai/gpt-oss-120b` on Cloudflare Workers AI, so it needs `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`.
- **Workspace checks** look at the files the agent left behind.

Things to know before you run them:

- The prompts run for real. The agent writes files and runs shell commands on your machine, so keep new cases harmless.
- An eval run uses the `workspace/` folder in the project root and empties it before each case. It does not touch the Studio workspace in `src/mastra/public/workspace/`.
- An eval run saves its scores and traces to `mastra.db` and `mastra.duckdb` in the project root. Studio reads the files in `src/mastra/public/`, so these runs do not show up there.
- Models do not give the same answer every time, so a case can pass on one run and fail on the next.

The judge is registered in `src/mastra/index.ts`, so you can also pick it in Mastra Studio when you run an experiment on a dataset.

`notes/offline-evals.md` explains how the evals work and how to add a case.

### Tool-choice experiment in LangSmith

`yarn eval:tools` checks that the agent calls the tools a request needs, and no others. It runs as an experiment in LangSmith, on the `agent-tool-choice` dataset:

```shell
AGENT_MODEL=openrouter yarn eval:tools
```

- The dataset lives in LangSmith. `evals/langsmith-tool-choice.ts` creates it with six cases on the first run; after that, edit or add cases in LangSmith.
- A case needs `{ "question": ... }` as its input and `{ "expectedTools": [...] }` as its reference output. A real run added from `agent-with-mastra` has a different shape (`input`, and `text` as its output), so rename its input and add `expectedTools` by hand. Cases without `expectedTools` get no scores.
- Each case gets up to three scores: `expected_tools_called`, `no_unexpected_tools` (the task list tools do not count), and `args_correct` where the case lists expected arguments.
- Each run is a new experiment named after `AGENT_MODEL`, so two models can be compared side by side in LangSmith.
- The agent's own traces still go to the `agent-with-mastra` project, not into the experiment, so the live evaluator grades these runs too.

## Live evals

`yarn eval` checks a fixed list of prompts. Live evals grade real conversations as they happen. Here LangSmith does the grading: the agent sends its traces to LangSmith, and an [online evaluator](https://docs.langchain.com/langsmith/online-evaluations) that you create in the LangSmith UI judges them. The judge's prompt, model and sampling rate live in LangSmith, not in this repo.

1. Set `LANGSMITH_API_KEY` in `.env` and restart `yarn dev`.
2. Send one message to the agent in Mastra Studio, so the `agent-with-mastra` project appears in LangSmith with a run in it.
3. In LangSmith, open **Tracing**, select the `agent-with-mastra` project, and open its **Evaluators** tab.
4. Select **+ Evaluator**, then **LLM-as-a-Judge Evaluator**. Write the prompt that tells the judge how to grade a run, map its variables to the input and output of the run from step 2, and pick the judge model.
5. Set a filter and a sampling rate of 1, then save.
6. Send another message in Studio and check that its run gets a feedback score. Then lower the sampling rate.

Things to know:

- A live conversation has no expected answer, so the judge can only grade what it sees, such as whether the answer addresses the question. The `must` and `mustNot` lists belong to the offline evals.
- Every tool call and model step is its own run in LangSmith. Check that the evaluator's filter targets the top-level agent run, not each step.
- Each graded run is one judge call that you pay for. Once the first score shows up, lower the sampling rate and set the evaluator's spend limit.
- `yarn eval` also reads `.env`, so its runs land in the same project and are graded too.

LangSmith's guide to [LLM-as-a-judge online evaluators](https://docs.langchain.com/langsmith/online-evaluations-llm-as-judge) covers the setup in full.

`notes/live-evals.md` lists what is set up and what is left.

### User feedback

A thumbs up or down from the user is sent to `POST /feedback` on the Mastra server. It shows up in LangSmith as a `user_thumbs` feedback score on the agent's top-level run: 1 for up, 0 for down.

```shell
curl -X POST http://localhost:4111/feedback \
  -H 'content-type: application/json' \
  -d '{"traceId": "<traceId of the reply>", "thumbsUp": true, "comment": "optional"}'
```

The `traceId` comes back with every agent reply: on a generate or stream result, and in `content.metadata.traceId` on a saved assistant message. The route lives in `src/mastra/routes/feedback-route.ts`.

- We found no thumbs button in Mastra Studio's chat (`mastra` 1.33.0), so the button belongs in your own chat screen, which calls this route.
- A click straight after the reply can take a few seconds to answer: the route waits up to about 6 seconds for the reply's trace to be saved.
- The LangSmith exporter only remembers the runs it sent since the server started. A rating for a reply from before a restart is dropped, with a warning in the server log.

## Making it yours

- Edit `src/mastra/agents/agent.ts` to change the models, instructions, memory, workspace, or approval policy.
- Edit `evals/code-assistant.eval.ts` to add eval cases, and `src/mastra/scorers/` to change how answers are judged.
- Edit `src/mastra/tools/` to customize scheduling.
- Edit `src/mastra/index.ts` to change storage and observability.
- Add files or reusable skills under `src/mastra/public/workspace/` for the agent to use during `yarn dev`.

`notes/setting-up-an-agent.md` explains how the pieces fit together, step by step.

## Learn more

To learn more about Mastra, visit the [documentation](https://mastra.ai/docs/). If you're new to AI agents, check out the [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join the [Discord](https://discord.gg/mastra-ai) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework. Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).
