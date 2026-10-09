import { existsSync } from 'node:fs';

// Vitest only loads .env values that start with VITE_. This runs before each eval file,
// so the keys and AGENT_MODEL are set by the time the agent module is imported.
// CI has no .env file; there the values come from the job's environment.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
