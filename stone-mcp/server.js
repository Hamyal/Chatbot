// Stone MCP server (Streamable HTTP transport).
//
// Exposes the Stone Curators "AI Data Utility API" as MCP tools so a remote
// agent — e.g. the Stone Expert workflow in OpenAI Agent Builder — can reach
// real catalog data. Every tool is a thin, faithful wrapper over one endpoint
// from the REST API Integration Guide.
//
// Deploy on Render (or any Node host); the MCP endpoint is POST /mcp.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3002);

// Base URL differs per deployment environment (see the integration guide).
const API_BASE_URL = (
  process.env.STONE_API_BASE_URL || "https://stonecurators-backend.com:3000/api"
).replace(/\/+$/, "");
const API_KEY = process.env.AI_DATA_API_KEY || "";

// getsearch can be slow — up to ~70s cold — so allow a generous ceiling.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 90_000);

/**
 * Call one AI Data endpoint.
 *
 * The guide documents two response shapes: `{ "data": ... }` for the time
 * endpoints and a bare JSON array for the content-page endpoints. Both are
 * returned to the caller as-is; only errors are normalized.
 */
async function callApi(path, { auth = false } = {}) {
  const url = `${API_BASE_URL}${path}`;
  const headers = { Accept: "application/json" };
  if (auth) {
    if (!API_KEY) {
      throw new Error(
        "AI_DATA_API_KEY is not set — this endpoint requires an API key."
      );
    }
    // The server authenticates on the `x-getdata-key` header (confirmed working
    // in Tuyen's Postman test). The guide originally documented `x-api-key`, so
    // both names are sent with the same value to stay compatible either way.
    headers["x-getdata-key"] = API_KEY;
    headers["x-api-key"] = API_KEY;
  }

  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${url} (${reason})`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${url} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`
    );
  }

  if (!response.ok || parsed?.error) {
    throw new Error(
      parsed?.message || `Request failed with HTTP ${response.status}`
    );
  }
  return parsed;
}

/** Wrap a handler so failures come back as MCP tool errors, not crashes. */
async function toolResult(fn) {
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Build a fresh MCP server instance with the Stone Curators tools registered. */
function buildMcpServer() {
  const server = new McpServer({ name: "stone-mcp", version: "2.0.0" });

  // 3.5 — GET /aiData/getsearch?<keywords>
  server.registerTool(
    "search_stone",
    {
      title: "Search the stone catalog",
      description:
        "Search Stone Curators products and materials by keywords. Include " +
        "every criterion the visitor mentioned — stone species, where it was " +
        "quarried or gathered, source (quarried/gathered/reclaimed), dominant " +
        "color, color feeling (warm/cool/light/dark), color pattern, surface " +
        "finish, application or specific use (pool deck, driveway paving, wall " +
        "cladding), suitability (freeze-thaw, low slipperiness, high traffic), " +
        "shape (planks, cobble, mosaic), lead time, relative cost, product " +
        "name, or catalog number (P226, M1133). Returns markdown content pages " +
        "with a Search Match Score — higher scores are better matches.",
      inputSchema: {
        keywords: z
          .string()
          .describe(
            "Search terms, e.g. 'gray granite in a cool tone for driveway paving'."
          ),
      },
    },
    async ({ keywords }) =>
      toolResult(async () => {
        // Per the guide the keywords go in as a bare query string joined by
        // '+' — /aiData/getsearch?gray+granite+in+a+cool+tone — rather than
        // as a named keyword= parameter.
        const words = String(keywords || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(encodeURIComponent);
        if (!words.length) throw new Error("No search keywords provided.");
        return await callApi(`/aiData/getsearch?${words.join("+")}`, {
          auth: true,
        });
      })
  );

  // 3.4 — GET /aiData/get-material-content-pages
  server.registerTool(
    "get_material_content_pages",
    {
      title: "List published materials",
      description:
        "List all published material content pages from the catalog. Use when " +
        "the visitor wants to browse what is available rather than search for " +
        "something specific. Returns markdown content pages.",
      inputSchema: {},
    },
    async () =>
      toolResult(() =>
        callApi("/aiData/get-material-content-pages", { auth: true })
      )
  );

  // 3.1–3.3 — the Vietnam time endpoints
  server.registerTool(
    "get_vietnam_time",
    {
      title: "Vietnam current time / date",
      description:
        "Get the current Vietnam time, date, or full date-time. Pick the kind " +
        "that matches what the visitor asked for.",
      inputSchema: {
        kind: z
          .enum(["time", "date", "datetime"])
          .describe("time = clock only, date = YYYY-MM-DD, datetime = both."),
      },
    },
    async ({ kind }) =>
      toolResult(() => {
        const path =
          kind === "date"
            ? "/aiData/getdate"
            : kind === "time"
              ? "/aiData/gettime"
              : "/aiData/getdatetime";
        return callApi(path);
      })
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send("Stone MCP server. MCP endpoint: POST /mcp  |  Health: GET /health");
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    apiBaseUrl: API_BASE_URL,
    apiKeyConfigured: Boolean(API_KEY),
  })
);

// Diagnostic: confirms this server can actually reach the catalog API.
// Useful when the deployment's base URL is wrong or the host is unreachable.
app.get("/selftest", async (_req, res) => {
  try {
    const data = await callApi("/aiData/getdatetime");
    res.json({ ok: true, apiBaseUrl: API_BASE_URL, sample: data });
  } catch (err) {
    res.status(502).json({
      ok: false,
      apiBaseUrl: API_BASE_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Stateless Streamable HTTP: a new server+transport per request. This is the
// simplest mode to deploy and works with OpenAI Agent Builder's MCP connector.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Stone MCP server listening on http://localhost:${PORT}`);
  console.log(`  MCP endpoint: POST http://localhost:${PORT}/mcp`);
  console.log(`  Catalog API:  ${API_BASE_URL}`);
  console.log(`  API key:      ${API_KEY ? "configured" : "NOT SET"}`);
});
