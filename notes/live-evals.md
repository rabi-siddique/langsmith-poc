# Live evals with LangSmith

A live eval scores real conversations as they happen. The agent sends its
traces to LangSmith, and an evaluator set up in the LangSmith UI judges them.

Status on 2026-10-11.

## Done

- **Traces reach LangSmith.** `LangSmithExporter` from `@mastra/langsmith` is
  in `src/mastra/index.ts`. It needs only `LANGSMITH_API_KEY` and sends to the
  `agent-with-mastra` project.
- **An LLM judge runs on them.** The `agent-evaluator` evaluator was created in
  the LangSmith UI, on the project's **Evaluators** tab.
- **It scores one message at a time.** A run scored `answers_request = 1` about
  two minutes after the agent replied.

The evaluator's settings:

| Setting       | Value                                      |
| ------------- | ------------------------------------------ |
| Source        | Runs                                       |
| Filter        | `eq(is_root, true)`                        |
| Sampling rate | 100%                                       |
| Judge model   | `gemini-3.5-flash-lite`                    |
| Judge key     | The `GOOGLE_API_KEY` workspace secret      |
| `<input>`     | `input`                                    |
| `<output>`    | `output.text`                              |
| Score         | `answers_request`, Boolean, with reasoning |

Why two of them are set that way:

- **The filter.** One chat creates about 12 runs in LangSmith, one per internal
  step. Without the filter the judge picks up those steps.
- **The whole `input`.** A Studio chat puts the message in `input.contents`, an
  API call in `input.input`. Mapping the whole input covers both.

## Backfill and backtesting

Both use old runs, but they are not the same thing.

|                     | Backfill                    | Backtesting                      |
| ------------------- | --------------------------- | -------------------------------- |
| What gets judged    | Answers the agent gave      | New answers from a changed agent |
| Agent runs again    | No                          | Yes, on the old inputs           |
| Question it answers | How good were past replies? | Would the new version do better? |
| Kind of eval        | Live                        | Offline                          |

A backtest saves the inputs of past runs as a dataset, runs the new agent on
them, and compares the results with the original answers.

## Alerts

Set up and tested on 2026-10-12.

Two things tell us when the thread judge scores a conversation as bad:

- **An alert** says that something went wrong, but not where.
- **A webhook on an automation rule** sends each failing run, with a link to its
  trace.

The thread judge is the `thread-evaluator` evaluator. It writes its verdict as
the `trajectory_accuracy` feedback key, true (1) or false (0), on the thread's
latest top-level run.

### The alert

| Setting    | Value                                                     |
| ---------- | --------------------------------------------------------- |
| Name       | Thread judged negative                                    |
| Project    | `agent-with-mastra`                                       |
| Metric     | `feedback_score`                                          |
| Filter     | `eq(feedback_key, "trajectory_accuracy")`                 |
| Condition  | Average below 1 over 15 minutes                           |
| Sends to   | A webhook.site test inbox                                 |
| Find it in | **Monitoring** > **Alerts**, or the project's Alerts icon |

"Average below 1" means it fires if any thread scored in the window was false.

It was made through the API, not the UI:
`POST https://api.smith.langchain.com/api/v1/platform/alerts/{project id}`.

```json
{
  "rule": {
    "name": "Thread judged negative",
    "description": "Fires when any thread scored by thread-evaluator in the last 15 minutes has trajectory_accuracy = false.",
    "type": "threshold",
    "attribute": "feedback_score",
    "aggregation": "avg",
    "operator": "lt",
    "threshold": 1,
    "window_minutes": 15,
    "filter": "eq(feedback_key, \"trajectory_accuracy\")"
  },
  "actions": [
    {
      "target": "webhook",
      "config": "{\"url\":\"https://webhook.site/<inbox id>\",\"project_name\":\"agent-with-mastra\",\"headers\":\"{\\\"Content-Type\\\":\\\"application/json\\\"}\",\"body\":\"{\\\"text\\\":\\\"A conversation in agent-with-mastra failed the thread judge.\\\"}\"}"
    }
  ]
}
```

Things the API docs leave out, found by trial:

- **`config` is a JSON string**, not an object. Inside it, `headers` and `body`
  are JSON strings too.
- **`config` needs `project_name`.** Without it the request fails with
  `missing required field: project_name`.
- **The feedback key goes in `filter`.** The rule has no field for it.
- **The test endpoint** (`POST .../alerts/{project id}/test`) needs the
  `X-Tenant-Id` header. It answered "fired successfully" but nothing reached
  the inbox. A real alert did.

### How it was tested

The thread judge could not score anything yet (see Left), so a fake verdict
was added by hand: a `trajectory_accuracy` score of 0 on a test thread's
latest run.

| Test                                     | Result                                      |
| ---------------------------------------- | ------------------------------------------- |
| Score of 0 added at 12:17:50 UTC         | Alert arrived at 12:19:01                   |
| Watched for 16 more minutes              | No more alerts: one bad score, one alert    |
| Score of 0 under another key at 12:34:10 | No alert: only `trajectory_accuracy` counts |
| Score of 0 added again at 12:37:56       | Alert arrived at 12:39:00                   |

So an alert arrives about a minute after a bad score. The alert's body has the
rule name, `triggered_metric_value`, `triggered_threshold`, and a `runs_url`
link to the scored runs.

The chart on the alert's page puts each score at its run's start time, not at
the time the score was added.

What an alert does not do:

- **It does not say which thread failed.** Its `runs_url` lists every run with
  a `trajectory_accuracy` score, so the bad one has to be found by hand. The
  rule webhook below fixes this.
- **LangSmith keeps no history of fired alerts.** The dashboard shows the rule
  and its metric chart. The only record is the message the alert sent.

### The rule webhook

An automation rule is the same kind of rule that runs an evaluator. Instead of
a judge, this one sends a webhook for every run that matches its filter.

| Setting  | Value                                                                                    |
| -------- | ---------------------------------------------------------------------------------------- |
| Name     | Failed thread webhook                                                                    |
| Project  | `agent-with-mastra`                                                                      |
| Filter   | `and(eq(is_root, true), eq(feedback_key, "trajectory_accuracy"), lt(feedback_score, 1))` |
| Sends to | The same webhook.site test inbox                                                         |
| Find it  | The project's **Evaluators** tab                                                         |

It was made through the API:
`POST https://api.smith.langchain.com/api/v1/runs/rules`.

```json
{
  "display_name": "Failed thread webhook",
  "session_id": "<project id>",
  "sampling_rate": 1,
  "filter": "and(eq(is_root, true), eq(feedback_key, \"trajectory_accuracy\"), lt(feedback_score, 1))",
  "webhooks": [
    {
      "url": "https://webhook.site/<inbox id>",
      "headers": { "Content-Type": "application/json" }
    }
  ]
}
```

The `/api/v1/runs/rules/validate` endpoint only checks rules that have an
evaluator, so the filter was checked by running it as a run query first.

Each message has a `runs` list. For each run it has:

- `trace_url`, a direct link to the trace in LangSmith
- `id` and `trace_id`
- `extra.metadata.session_id`, the thread
- `inputs`, `outputs` and `error`
- `feedback_stats`, with the score and its comment

How it was tested, again with fake scores of 0:

| Test                               | Result                                         |
| ---------------------------------- | ---------------------------------------------- |
| New run, scored at 12:52:51 UTC    | Webhook at 12:54:54, with that run's trace URL |
| Run from 11:18, scored at 12:55:39 | Webhook at 12:57:56, with that run's trace URL |

The second test matters: the real thread judge scores a run at least 10
minutes after it ran, once the thread goes idle. The rule still catches it.

### Test data

Each fake score has a comment saying it is a test.

- `trajectory_accuracy = 0` on runs `01a12fba` (twice), `01a1302b` and
  `01a12fd5`.
- `alert_filter_check = 0` on run `01a12fba`.
- Thread `rule-webhook-check-1791809549`: one agent turn made only to have a
  new run to score. It failed with "Too Many Requests" from Cloudflare.

## Left

- **Check a Studio chat.** Only an API call has been scored since the input
  mapping was fixed.
- **Lower the sampling rate.** It is 100% for testing, and Gemini's free tier
  is small.
- **Score whole conversations.** The judge sees one message and its reply, not
  the earlier messages. LangSmith's thread evaluators need two things our runs
  lack:
  - A `session_id` or `thread_id` metadata key. Ours is `conversationId`.
  - A `messages` key in the top-level input and output. Ours are
    `input` or `contents`, and `text`.
- **Score old runs (backfill).** The UI offers it only when an evaluator is
  created. The API has a `backfill_from` field on an existing rule. Untested.
- **Backtest a new agent version.** Not set up. It needs enough real chats
  first, for example to compare two values of `AGENT_MODEL`.
- **Make the thread judge work.** Every run so far failed with Gemini's
  `429 RESOURCE_EXHAUSTED`: `gemini-3.1-pro-preview` is out of free quota. Until
  its model is changed, the alert and the rule webhook can only fire on
  hand-added scores.
- **Send alerts somewhere real.** The alert and the rule webhook both go to a
  webhook.site test inbox. Slack needs a one-time connection in the alert's
  **Edit Alert** screen. The rule webhook only takes a URL and headers and
  sends LangSmith's own JSON, which Slack does not accept as is. It needs a
  small relay that turns each run into a Slack message.
- **Delete the test data** once it is no longer needed.
- **Keep `yarn eval` runs out.** They read the same `.env`, so they land in the
  same project and get judged too.
- **Try other judge providers.** Only Gemini was tested. OpenRouter and
  Cloudflare are not built in and need the **OpenAI Compatible Endpoint**
  option.

## Sources

- [LangSmith: online evaluations](https://docs.langchain.com/langsmith/online-evaluations)
- [LangSmith: LLM-as-a-judge online evaluators](https://docs.langchain.com/langsmith/online-evaluations-llm-as-judge)
- [LangSmith: multi-turn online evaluators](https://docs.langchain.com/langsmith/online-evaluations-multi-turn)
- [LangSmith: threads](https://docs.langchain.com/langsmith/threads)
- [LangSmith: run backtests on a new version of an agent](https://docs.langchain.com/langsmith/run-backtests-new-agent)
- [LangSmith: alerts](https://docs.langchain.com/langsmith/alerts)
- [LangSmith API: create an alert rule](https://docs.langchain.com/langsmith/smith-api/alert_rules/create-an-alert-rule)
- [LangSmith Terraform provider: alert rule](https://github.com/langchain-ai/terraform-provider-langsmith/blob/main/docs/resources/alert_rule.md)
- [LangSmith: webhooks](https://docs.langchain.com/langsmith/webhooks)
- [Mastra: LangSmith exporter](https://mastra.ai/reference/observability/tracing/exporters/langsmith)
