# Deployment

Handoff notes for hosting the FCSC MCP server. The service is a stateless Node
process; the only external dependency is outbound HTTPS to the FCSC API.

## Requirements

| | |
|---|---|
| Node | **20 or newer** — the SDK's HTTP transport depends on `@hono/node-server`, which does not support Node 18 |
| Inbound | 443 (and 80 for the ACME challenge) |
| Outbound | HTTPS to `releaseeuaestat.fcsc.gov.ae` |
| DNS | An A record for the chosen hostname, pointing at this host |

Run `node http-server.js`, not `server.js`. The latter is the stdio transport for
local desktop clients — it listens on no port and exits immediately if
backgrounded.

## Install

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Application
sudo useradd --system --no-create-home --shell /usr/sbin/nologin fcsc-mcp
sudo mkdir -p /opt/fcsc-mcp-server
sudo git clone https://github.com/Swetha-Josh/MCP_UAE.git /opt/fcsc-mcp-server/MCP_UAE
cd /opt/fcsc-mcp-server/MCP_UAE
sudo npm ci --omit=dev
sudo chown -R fcsc-mcp:fcsc-mcp /opt/fcsc-mcp-server

# Service
sudo cp deploy/fcsc-mcp.service /etc/systemd/system/
sudo touch /etc/fcsc-mcp.env && sudo chmod 600 /etc/fcsc-mcp.env
sudo systemctl daemon-reload && sudo systemctl enable --now fcsc-mcp
```

Verify before putting a proxy in front of it:

```bash
curl -s localhost:3000/health
# {"status":"ok","datasets":50,"sessions":0,"upstream":"https://releaseeuaestat.fcsc.gov.ae/rest"}
```

## TLS

Install Caddy, set the real hostname in `deploy/Caddyfile`, then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -s https://mcp.example.com/health
```

If you use nginx or an ALB instead, the one setting that matters is **response
buffering must be off** — Streamable HTTP holds an SSE stream open, and a
buffering proxy stalls it. For nginx that is `proxy_buffering off;` plus
`proxy_read_timeout 3600s;`.

## Configuration

Set in `/etc/fcsc-mcp.env` (mode 600, never committed):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `HOST` | 127.0.0.1 | Bind address — keep on loopback behind the proxy |
| `CORS_ORIGIN` | `*` | Restrict to `https://claude.ai` once the client is known |
| `FCSC_BASE_URL` | production API | Override for testing against a stub |
| `FCSC_API_KEY` | unset | Sent as `Ocp-Apim-Subscription-Key` if FCSC issue a key |

## Client registration

The MCP endpoint is `https://<hostname>/mcp` — the path matters. Pointing a
client at the bare domain will fail to attach.

Health check for a load balancer: `GET /health`, expects 200.

## Two things to know before go-live

**The endpoint is unauthenticated.** Anyone who knows the URL can call the tools.
The data served is public government statistics, so the exposure is low, but the
FCSC API quota is not: consider IP allowlisting at the proxy, or rate limiting,
until proper auth is in place.

**Upstream access is not yet working.** FCSC sits behind Cloudflare bot
protection, which returns 403 to non-browser clients. `listDatasets` works
offline from the bundled manifest, but `getDatasetData` and
`getDatasetStructure` will fail until FCSC allowlist this host's egress IP. Give
them the NAT gateway or Elastic IP address, whichever the traffic actually
leaves from.
