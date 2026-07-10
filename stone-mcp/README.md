# Stone MCP Server

A self-contained [MCP](https://modelcontextprotocol.io) server that exposes the
stone catalog as tools, so a remote agent — such as the **Stone Search** agent in
**OpenAI Agent Builder** — can call real product data.

It carries its own data (`data.js`), so it runs **standalone** with no dependency
on `stone-api` being live.

## Tools

| Tool | What it does |
|------|--------------|
| `search_products` | Search stone by free-text query, plus optional `material` / `type` filters |
| `get_product_detail` | Look up one product by catalog code (e.g. `M608`) |

## Endpoint

- **MCP endpoint:** `POST /mcp` (Streamable HTTP transport)
- **Health check:** `GET /health`

## Run locally

```bash
npm install
npm start          # listens on http://localhost:3002
```

Quick test (initialize handshake is required by MCP before other calls):

```bash
curl -s -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -X POST http://localhost:3002/mcp \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deploy on Render

1. Push this repo to GitHub.
2. In Render → **New → Web Service** → connect the GitHub repo.
3. Settings:
   - **Root Directory:** `stone-mcp`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free is fine to start.
4. Render sets `PORT` automatically — the server already reads `process.env.PORT`.
5. Deploy. Your live MCP URL will be:

   ```
   https://<your-service-name>.onrender.com/mcp
   ```

## Connect in OpenAI Agent Builder

1. Open your workflow (e.g. *Stone Expert*).
2. Add / open the **MCP** tool block on the **Stone Search** agent.
3. Set the server URL to your Render URL ending in **`/mcp`**.
4. The `search_products` and `get_product_detail` tools will appear — enable them.
5. Save. The Stone Search agent now returns real catalog data.

> Note: Render's free tier sleeps after inactivity, so the first request after
> idle can take ~30–60s to wake. Upgrade the instance if you need it always-on.
