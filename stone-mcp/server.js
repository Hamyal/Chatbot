// Stone MCP server (Streamable HTTP transport).
//
// Exposes the stone catalog as MCP tools so a remote agent — e.g. the
// "Stone Search" agent in OpenAI Agent Builder — can call real data.
// Deploy this on Render (or any Node host); the MCP endpoint is POST /mcp.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { searchProducts, getProductByCode } from "./data.js";

const PORT = Number(process.env.PORT || 3002);

/** Build a fresh MCP server instance with the stone tools registered. */
function buildMcpServer() {
  const server = new McpServer({
    name: "stone-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_products",
    {
      title: "Search stone products",
      description:
        "Search natural stone products. Put use-cases (paving, flooring, " +
        "outdoor) in `query`. Use `material`/`type` only for real catalog " +
        "values (material: marble, granite, travertine, limestone, quartz; " +
        "type: slab, tile, block). Never put paving in `type` — put it in query.",
      inputSchema: {
        query: z.string().describe("User intent: materials, colors, paving, outdoor, etc."),
        material: z
          .string()
          .optional()
          .describe("Only if the user names a stone family. Otherwise omit."),
        type: z
          .string()
          .optional()
          .describe("Only a product form: slab, tile, or block. Otherwise omit."),
      },
    },
    async ({ query, material, type }) => {
      const results = searchProducts({ query, material, type });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_product_detail",
    {
      title: "Get product detail",
      description:
        "Get one product by catalog code (e.g. M608, M742). Use when the " +
        "user gives a code or asks for details about a specific product.",
      inputSchema: {
        code: z.string().describe("Catalog code like M608."),
      },
    },
    async ({ code }) => {
      const item = getProductByCode(code);
      if (!item) {
        return {
          content: [
            { type: "text", text: `No product found with code ${code}.` },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Friendly landing + health check (Render pings this).
app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send("Stone MCP server. MCP endpoint: POST /mcp  |  Health: GET /health");
});
app.get("/health", (_req, res) => res.json({ ok: true }));

// Stateless Streamable HTTP: a new server+transport per request. This is the
// simplest mode to deploy and works with OpenAI Agent Builder's MCP connector.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id, so each request is self-contained. This is
      // the simplest mode to deploy and is compatible with remote MCP clients
      // like OpenAI Agent Builder.
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
});
