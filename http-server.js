import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import { BASE_URL, createMcpServer, datasets } from "./create-server.js";

// Streamable HTTP transport: one long-lived process serving many clients over the
// network. This is what claude.ai custom connectors and shared team deployments
// need — stdio only works when the client can launch the server as a subprocess.
//
// Requires Node 20+ (the SDK's HTTP transport depends on @hono/node-server).

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.use(express.json({ limit: "4mb" }));

// Browser-based clients preflight these requests, and the session header has to
// be readable by the client or it can't continue the session.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/** Live sessions, keyed by the session id the transport hands out on initialize. */
const sessions = new Map();

const badRequest = (res, message) =>
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing) return badRequest(res, "Unknown or expired session id.");
    return existing.handleRequest(req, res, req.body);
  }

  if (!isInitializeRequest(req.body)) {
    return badRequest(res, "Missing Mcp-Session-Id header on a non-initialize request.");
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
      console.error(`session opened: ${id} (${sessions.size} active)`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) {
      console.error(`session closed: ${transport.sessionId} (${sessions.size} active)`);
    }
  };

  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

/** GET opens the SSE stream for server-to-client messages; DELETE ends a session. */
const bySession = async (req, res) => {
  const transport = sessions.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(404).send("Unknown or expired session id.");
  await transport.handleRequest(req, res);
};

app.get("/mcp", bySession);
app.delete("/mcp", bySession);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", datasets: datasets.length, sessions: sessions.size, upstream: BASE_URL });
});

app.listen(PORT, HOST, () => {
  console.error(
    `✅ FCSC MCP server (Streamable HTTP) on http://${HOST}:${PORT}/mcp — ` +
      `${datasets.length} datasets from ${BASE_URL}`
  );
});
