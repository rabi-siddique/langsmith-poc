import { MCPClient } from '@mastra/mcp';

// The MCP project's demo server, started locally over stdio. It is here to check how
// MCP tool calls show up in traces, before connecting a real MCP server.
const testMcpClient = new MCPClient({
  id: 'test-mcp-client',
  servers: {
    everything: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything@2026.8.31'],
    },
  },
});

// Only these reach the agent. Others on this server return environment variables or
// read files, and whatever a tool returns is sent on to Langfuse and LangSmith.
const ALLOWED_MCP_TOOLS = ['everything_echo', 'everything_get-sum'];

const allMcpTools = await testMcpClient.listTools();

export const mcpTools = Object.fromEntries(
  Object.entries(allMcpTools).filter(([name]) =>
    ALLOWED_MCP_TOOLS.includes(name),
  ),
);
