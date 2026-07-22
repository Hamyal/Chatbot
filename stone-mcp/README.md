# Stone MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the Stone Curators
**AI Data Utility API** as tools, so a remote agent — such as the Stone Expert
workflow in **OpenAI Agent Builder** — can reach real catalog data.

Every tool is a thin wrapper over one endpoint from the REST API Integration
Guide. The server holds no data of its own; it proxies the live API.

## Tools

| Tool | Endpoint | Auth |
|------|----------|------|
| `search_stone` | `GET /aiData/getsearch?<keywords>` | API key |
| `get_material_content_pages` | `GET /aiData/get-material-content-pages` | API key |
| `get_vietnam_time` | `GET /aiData/gettime` · `/getdate` · `/getdatetime` | none |

`search_stone` is the main one — the catalog's text search scores against rich
content pages covering species, origin, colors, patterns, finishes,
applications, specific uses, suitability, shapes, lead time, relative price and
related products. Catalog numbers are `P…` for products and `M…` for materials.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `STONE_API_BASE_URL` | yes | Catalog API base URL, e.g. `https://stonecurators-backend.com:3000/api`. **Differs per deployment environment** — confirm the correct one. |
| `AI_DATA_API_KEY` | yes | Sent as the `x-api-key` header. |
| `PORT` | no | Set automatically by Render. |

## Endpoints

- **MCP endpoint:** `POST /mcp` (Streamable HTTP transport)
- **Health:** `GET /health` — shows the configured base URL and whether a key is set
- **Self-test:** `GET /selftest` — actually calls the catalog API and reports success or the exact error

> `GET /mcp` in a browser returns "Cannot GET /mcp". That is expected — the MCP
> protocol uses POST. Use `/health` or `/selftest` to check the server by eye.

## Run locally

```bash
npm install
STONE_API_BASE_URL="https://stonecurators-backend.com:3000/api" \
AI_DATA_API_KEY="<key>" \
npm start          # listens on http://localhost:3002
```

Verify it can reach the catalog:

```bash
curl http://localhost:3002/selftest
```

## Deploy on Render

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Settings:
   - **Root Directory:** `stone-mcp`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add the **environment variables** `STONE_API_BASE_URL` and `AI_DATA_API_KEY`.
5. Deploy, then check `https://<service>.onrender.com/selftest` before wiring
   anything up — it tells you immediately whether the catalog API is reachable.

Your live MCP URL is `https://<service>.onrender.com/mcp`.

## Connect in OpenAI Agent Builder

1. Open the workflow and select the agent that should search stone.
2. Add the **MCP** tool block; set the server URL to your Render URL ending in
   **`/mcp`**; authentication **None**.
3. Enable the tools that appear, then save.

> Render's free tier sleeps after inactivity, so the first request after idle
> can take ~30–60s. Upgrade the instance if it needs to be always-on.
