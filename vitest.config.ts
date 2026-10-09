import { MastraEvalsReporter } from '@mastra/evals/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['./evals/load-env.ts'],
    // MastraEvalsReporter prints a score table for each eval case after the run.
    reporters: ['default', new MastraEvalsReporter()],
    // An eval case is a full agent run plus a judge call, far slower than Vitest's 5 second default.
    testTimeout: 300_000,
    // Free models are rate limited, so run one file at a time.
    fileParallelism: false,
  },
});
