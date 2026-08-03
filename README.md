# FCSC MCP Server

An MCP server that exposes official UAE statistics from the Federal Competitiveness
and Statistics Centre (FCSC) as tools an AI assistant can call.

It acts as the bridge between Claude and the FCSC SDMX API: Claude never calls FCSC
directly. It invokes a tool here, this server calls the FCSC endpoint, and the
response is returned as readable, labelled data. FCSC credentials stay in this
server's environment and are never exposed to the model.

## Status

The tool layer is complete and tested against local stubs. **It has not yet returned
live FCSC data** — see [Known blocker](#known-blocker) below.

## Tools

| Tool | Purpose |
|---|---|
| `listDatasets` | Discover available datasets, filtered by topic or free-text search. |
| `getDatasetData` | Fetch observations for one dataset as a labelled table. |
| `getDatasetStructure` | List a dataset's dimensions and codelists, for building filtered keys. |

Rather than defining 50 near-identical tools, the server is driven by
[`datasets.json`](datasets.json) — a manifest of 50 FCSC dataflows spanning Economy,
Social and Environment topics. Claude discovers what exists with `listDatasets`, then
reads it with `getDatasetData`.

## Setup

Requires **Node 20 or newer**. The SDK's HTTP transport depends on
`@hono/node-server`, which does not support Node 18.

```bash
npm install
```

### Local use — stdio transport

The client launches the server as a subprocess and speaks JSON-RPC over
stdin/stdout. Nothing listens on a port.

```bash
npm start
```

```json
{
  "mcpServers": {
    "fcsc-statistics": {
      "command": "node",
      "args": ["/absolute/path/to/my-mcp-server/server.js"]
    }
  }
}
```

### Hosted use — Streamable HTTP transport

One process serving many clients over the network. This is what claude.ai custom
connectors and shared team deployments require.

```bash
npm run start:http          # listens on :3000, endpoint POST /mcp
curl localhost:3000/health  # {"status":"ok","datasets":50,...}
```

`PORT`, `HOST` and `CORS_ORIGIN` are configurable via the environment.

Note that `nohup npm start &` will **not** work for backgrounding — the stdio
server exits immediately when its stdin is closed. Background `start:http`
instead, or run either under a process manager such as systemd or pm2.

To register as a claude.ai custom connector the endpoint must be reachable at a
**public HTTPS URL** — a private EC2 address won't do. Terminate TLS with nginx,
Caddy or an ALB in front of the service, and give Claude the
`https://your-domain/mcp` URL.

### Environment variables

| Variable | Purpose |
|---|---|
| `FCSC_BASE_URL` | Override the API base URL. Useful for pointing at a test stub. |
| `FCSC_API_KEY` | Sent as `Ocp-Apim-Subscription-Key` if FCSC issue an API key. |

## Regenerating the dataset manifest

`datasets.json` is generated from the FCSC deep-links spreadsheet:

```bash
npm run build:manifest -- "/path/to/FCSC- MOBILE APP- Deep links.xlsx"
```

The generator scans the three URL columns for the first `/rest/data/` URL and
normalises it to the flat (`dimensionAtObservation=AllDimensions`) flavour itself,
rather than trusting the spreadsheet's "SDMX flavour (Flat)" column — that column has
known defects, including one row shifted a column right and 19 rows whose
time-series URL duplicates the flat one.

Two rows (Vital Statistics → Birth, Death) carry no URL at all and are reported as
skipped.

## Known blocker

The FCSC hosts sit behind Cloudflare bot protection, which returns **HTTP 403 to every
non-browser client** — the whole domain, not just the API paths. A browser
`User-Agent` does not help.

The API itself is live and serving: an external request reached
`DF_LFUNEMP_ED` and received HTTP 200 with SDMX-ML. So the barrier is Cloudflare
sitting between a program and the API, not the API itself.

**Needed from FCSC:** a machine-usable path to the API — an API key, a service
account, or allowlisting for the server — plus confirmation of which response format
the service will serve.

The server negotiates for SDMX-JSON, falls back to SDMX-CSV, and detects SDMX-ML and
reports it rather than failing silently. If FCSC only ever serve SDMX-ML, an XML
parsing path needs adding.

## Layout

```
server.js                  stdio entry point
http-server.js             Streamable HTTP entry point (hosted / claude.ai)
create-server.js           MCP server factory and tool definitions
fcsc.js                    URL building, HTTP, SDMX parsing, table rendering
datasets.json              Generated manifest of 50 FCSC dataflows
scripts/build-manifest.py  Regenerates datasets.json from the spreadsheet
```
