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

// claude.ai opens a session per conversation and rarely sends DELETE, so
// sessions that go quiet are closed here or they accumulate for the life of the
// process.
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 30 * 60_000);

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
const lastSeen = new Map();

const touch = (id) => {
  if (sessions.has(id)) lastSeen.set(id, Date.now());
};

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, seen] of lastSeen) {
    if (seen < cutoff) {
      lastSeen.delete(id);
      sessions.get(id)?.close();
    }
  }
}, Math.min(SESSION_IDLE_MS, 60_000)).unref();

const badRequest = (res, message, status = 400) =>
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    const existing = sessions.get(sessionId);
    // 404, not 400: the spec tells clients to re-initialize on 404, so sessions
    // lost to a restart or the idle sweep recover instead of failing every call.
    if (!existing) return badRequest(res, "Unknown or expired session id.", 404);
    touch(sessionId);
    return existing.handleRequest(req, res, req.body);
  }

  if (!isInitializeRequest(req.body)) {
    return badRequest(res, "Missing Mcp-Session-Id header on a non-initialize request.");
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
      touch(id);
      console.error(`session opened: ${id} (${sessions.size} active)`);
    },
  });

  transport.onclose = () => {
    lastSeen.delete(transport.sessionId);
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
  touch(req.headers["mcp-session-id"]);
  await transport.handleRequest(req, res);
};

app.get("/mcp", bySession);
app.delete("/mcp", bySession);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", datasets: datasets.length, sessions: sessions.size, upstream: BASE_URL });
});

// Internet scanners POST junk bodies (e.g. "0x[]=…") at any open port. Without
// this, express.json's parse failure is logged as a full SyntaxError stack and
// answered with an HTML page instead of a JSON-RPC error.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    console.error(`rejected unparseable body from ${req.ip} on ${req.method} ${req.path}`);
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: request body is not valid JSON." },
      id: null,
    });
  }
  next(err);
});

app.listen(PORT, HOST, () => {
  console.error(
    `✅ FCSC MCP server (Streamable HTTP) on http://${HOST}:${PORT}/mcp — ` +
      `${datasets.length} datasets from ${BASE_URL}`
  );
});
