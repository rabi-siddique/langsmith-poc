# langsmith-poc

LangSmith eval POC: given a user request, does a model pick the right YMax MCP
tool?

The model sees the MCP server's real instructions and tool descriptions, read
live from `../ymax-mcp-infra/services/mcp-server/src/instructions/`. It only
**chooses** a tool; nothing is executed, so no request reaches the signer or
the chain.

## Setup

Needs Node 24+ (runs the `.ts` files directly, no build step).

```sh
yarn install
cp .env.example .env   # then fill in the two API keys
```

## Run

1. Put your prompts in `data/examples.jsonl`, one JSON object per line. See
   `data/examples.example.jsonl` for the shape.

   **`expected_tool` is the first tool a correct model calls**, not the tool
   that finishes the job. The eval is a single turn and runs no tool loop. For
   example, "move 30% into Aave" starts with `get_portfolio_status`, because
   `submit_target_allocation` needs the portfolio's current state first. Give
   a list when several first steps are fine, and `"none"` when no tool should
   be called.
2. Upload them as a LangSmith dataset (once):
   ```sh
   yarn upload
   ```
3. Run the eval:
   ```sh
   yarn eval
   ```
4. Open smith.langchain.com, then **Datasets & Experiments** →
   `ymax-tool-selection` → **Experiments**. Each row is one request, the tool
   the model picked (`allTools` lists every call if it made several), and its
   `correct_tool` score (1 or 0).

To compare models, change `OPENROUTER_MODEL` and run `yarn eval` again; the
experiments sit side by side under the same dataset.

## Things to know

- **Use fake data only.** LangSmith and OpenRouter store what you send:
  placeholder addresses and IDs, never real wallets, portfolios or grants.
- **Free models are rate limited**: 20 requests/minute and 50/day unless the
  OpenRouter account has bought at least 10 credits. One eval run costs one
  request per example.
- **Arguments are not checked.** Tool input schemas are Zod schemas inside
  `mcp.ts` and are not exported, so every tool is offered with an empty schema.
  The eval scores the tool name only.
