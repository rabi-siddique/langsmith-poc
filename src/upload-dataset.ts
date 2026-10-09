import { readFileSync } from 'node:fs';

import { Client } from 'langsmith';

type ExampleRow = {
  inputs: { request: string };
  // One tool name, or several when more than one first step is reasonable
  outputs: { expected_tool: string | string[] };
};

const parseExamples = (jsonl: string): ExampleRow[] =>
  jsonl
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      const row = JSON.parse(line) as ExampleRow;
      const expected = row.outputs?.expected_tool;
      const hasExpected = Array.isArray(expected)
        ? expected.length > 0
        : Boolean(expected);
      if (!row.inputs?.request || !hasExpected)
        throw new Error(
          `Line ${index + 1} needs inputs.request and outputs.expected_tool`,
        );
      return row;
    });

const uploadDataset = async (
  client: Client,
  datasetName: string,
  rows: ExampleRow[],
) => {
  if (await client.hasDataset({ datasetName }))
    throw new Error(
      `Dataset "${datasetName}" already exists. Delete it in the LangSmith UI ` +
        'or set DATASET_NAME to a new name, then re-run.',
    );

  const dataset = await client.createDataset(datasetName, {
    description: 'User requests and the YMax MCP tool each should trigger',
  });
  await client.createExamples(
    rows.map(row => ({ dataset_id: dataset.id, ...row })),
  );
};

const examplesPath = process.argv[2] ?? 'data/examples.jsonl';
const datasetName = process.env.DATASET_NAME ?? 'ymax-tool-selection';

const rows = parseExamples(readFileSync(examplesPath, 'utf8'));
await uploadDataset(
  new Client({ apiKey: process.env.LANGSMITH_API_KEY }),
  datasetName,
  rows,
);
console.log(`Uploaded ${rows.length} examples to "${datasetName}"`);
