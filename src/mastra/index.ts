import { Mastra } from '@mastra/core/mastra';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { checks } from '@mastra/evals/checks';
import { agent } from './agents/agent';
import { formatSpanForLangsmithThreads } from './observability/langsmith-threads';
import { feedbackRoute } from './routes/feedback-route';
import { correctnessScorer } from './scorers/correctness-scorer';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';

const LANGSMITH_PROJECT = 'agent-with-mastra';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: {
    // POST /feedback records a user's thumbs up or down for an agent reply.
    apiRoutes: [feedbackRoute],
  },
  agents: { agent },
  tools: { startScheduleTool, stopScheduleTool },
  // Scores are only saved for scorers registered here.
  scorers: { correctnessScorer, noToolErrors: checks.noToolErrors() },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(),
          new MastraPlatformExporter(),
          // Reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL from .env.
          new LangfuseExporter(),
          // Reads LANGSMITH_API_KEY from .env. LangSmith's online evaluators judge these traces.
          new LangSmithExporter({
            projectName: LANGSMITH_PROJECT,
            customSpanFormatter: formatSpanForLangsmithThreads,
          }),
        ],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
