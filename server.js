import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BASE_URL, createMcpServer, datasets } from "./create-server.js";

// stdio transport: the client launches this file as a subprocess and speaks
// JSON-RPC over stdin/stdout. For a network-reachable server (claude.ai custom
// connectors, shared team hosting), run http-server.js instead.

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the JSON-RPC channel under stdio transport — log to stderr only.
console.error(`✅ FCSC MCP server ready — ${datasets.length} datasets from ${BASE_URL}`);
