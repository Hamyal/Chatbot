// Integration test for the Stone Curators chatbot stack.
//
//   node test-integration.mjs
//
// Checks three layers and prints a PASS/FAIL summary:
//   1. The Stone Curators REST API directly (auth + each endpoint)
//   2. The deployed MCP server on Render (tools + real data)
//   3. (optional) the local Next.js chat route, if it is running
//
// Override any of these with environment variables if needed.

const API_BASE =
  process.env.STONE_API_BASE_URL ||
  "https://stonecurators-backend.com:3000/api";
const API_KEY = process.env.AI_DATA_API_KEY || "a7f3e2c1d8b4f6a9e5c3d8b1f0a4e7c2";
const MCP_URL = process.env.MCP_URL || "https://chatbot-6m3s.onrender.com/mcp";
const CHAT_URL = process.env.CHAT_URL || "http://localhost:3000/api/chat";

const TIMEOUT_MS = 90_000;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path, headers = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// The catalog authenticates on x-getdata-key; send x-api-key too for safety.
const authHeaders = { "x-getdata-key": API_KEY, "x-api-key": API_KEY };

function countCatalogNumbers(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter((row) =>
    /Catalog Number:\s*[A-Za-z]?\d+/.test(row?.page_content || "")
  ).length;
}

async function testRestApi() {
  console.log("\n=== 1. Stone Curators REST API ===");

  // 1a. no-auth time endpoint — proves the server is reachable
  try {
    const r = await get("/aiData/getdatetime");
    record(
      "getdatetime (no auth)",
      r.status === 200 && Boolean(r.json?.data),
      r.json?.data ? `data=${r.json.data}` : `HTTP ${r.status}`
    );
  } catch (e) {
    record("getdatetime (no auth)", false, e.message);
  }

  // 1b. materials — proves the API key + header work
  try {
    const r = await get("/aiData/get-material-content-pages", authHeaders);
    const n = countCatalogNumbers(r.json);
    record(
      "get-material-content-pages (auth)",
      r.status === 200 && n > 0,
      r.status === 200 ? `${n} pages with catalog numbers` : `HTTP ${r.status} ${r.text.slice(0, 80)}`
    );
  } catch (e) {
    record("get-material-content-pages (auth)", false, e.message);
  }

  // 1c. search — the endpoint still under investigation on the backend
  try {
    const r = await get(
      "/aiData/getsearch?gray+granite+in+a+cool+tone",
      authHeaders
    );
    const n = countCatalogNumbers(r.json);
    const empty = Array.isArray(r.json) && r.json.length === 0;
    record(
      "getsearch (auth)",
      r.status === 200 && n > 0,
      r.status !== 200
        ? `HTTP ${r.status}`
        : empty
          ? "returns empty [] — backend search issue (ask Tuyen)"
          : `${n} results`
    );
  } catch (e) {
    record("getsearch (auth)", false, e.message);
  }
}

async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  // Streamable HTTP replies as an SSE "data: {...}" line — pull the JSON out.
  const line = text.split("\n").find((l) => l.startsWith("data:")) || text;
  const jsonStr = line.replace(/^data:\s*/, "");
  try {
    return JSON.parse(jsonStr);
  } catch {
    return { raw: text };
  }
}

async function testMcp() {
  console.log("\n=== 2. Deployed MCP server ===");

  try {
    const r = await mcpCall("tools/list", {});
    const names = (r.result?.tools || []).map((t) => t.name);
    record(
      "MCP tools/list",
      names.length > 0,
      names.join(", ") || "no tools"
    );
  } catch (e) {
    record("MCP tools/list", false, e.message);
  }

  try {
    const r = await mcpCall("tools/call", {
      name: "get_material_content_pages",
      arguments: {},
    });
    const text = r.result?.content?.[0]?.text || "";
    const codes = text.match(/Catalog Number:\s*[A-Za-z]?\d+/g) || [];
    record(
      "MCP get_material_content_pages",
      codes.length > 0,
      codes.length ? `${codes.length} catalog numbers` : "no data"
    );
  } catch (e) {
    record("MCP get_material_content_pages", false, e.message);
  }

  try {
    const r = await mcpCall("tools/call", {
      name: "search_stone",
      arguments: { keywords: "gray granite in a cool tone" },
    });
    const text = r.result?.content?.[0]?.text || "";
    const codes = text.match(/Catalog Number:\s*[A-Za-z]?\d+/g) || [];
    // Not a hard failure — records status so the summary reflects the backend.
    console.log(
      `[INFO] MCP search_stone — ${codes.length ? `${codes.length} results` : "empty (backend getsearch issue)"}`
    );
  } catch (e) {
    console.log(`[INFO] MCP search_stone — ${e.message}`);
  }
}

async function testChat() {
  console.log("\n=== 3. Local chat app (optional) ===");
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "What is honed finish?" }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const gotAnswer = text.includes('"t":"answer"');
    const usedKnowledge = text.includes("search_stone_knowledge");
    record(
      "chat route streams an answer",
      res.status === 200 && gotAnswer,
      usedKnowledge ? "used vector store" : `HTTP ${res.status}`
    );
  } catch (e) {
    record(
      "chat route (needs `npm run dev` in stone-ai-chat)",
      false,
      e.message
    );
  }
}

async function main() {
  console.log("Stone Curators integration test");
  console.log(`API_BASE = ${API_BASE}`);
  console.log(`MCP_URL  = ${MCP_URL}`);

  await testRestApi();
  await testMcp();
  await testChat();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== Summary: ${passed}/${results.length} checks passed ===`);
  console.log(
    "Note: getsearch returning empty is a known backend issue on Tuyen's side, not a failure of this integration."
  );
}

main();
