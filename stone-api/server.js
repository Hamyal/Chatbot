const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { getPool, hasMySqlConfig, getMissingMySqlEnv } = require("./db");
const { products, materialContentPages } = require("./mockData");

dotenv.config();

/** Normalize `applications` JSON from MySQL to string[]. */
function normalizeStoneRow(row) {
  if (!row) return row;
  let apps = row.applications;
  if (Buffer.isBuffer(apps)) {
    try {
      apps = JSON.parse(apps.toString("utf8"));
    } catch {
      apps = [];
    }
  } else if (typeof apps === "string") {
    try {
      apps = JSON.parse(apps);
    } catch {
      apps = [];
    }
  }
  if (!Array.isArray(apps)) {
    apps = [];
  }
  return { ...row, applications: apps };
}

/** DB `type` column values only — not use-cases like paving. */
const ALLOWED_ROW_TYPES = new Set(["slab", "tile", "block"]);
const ALLOWED_MATERIALS = new Set([
  "granite",
  "marble",
  "travertine",
  "limestone",
  "quartz",
]);

const app = express();
const port = Number(process.env.PORT || 3001);
const apiPrefix = "/api";
const aiDataPrefix = `${apiPrefix}/aiData`;
let requestIdCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function nextRequestId() {
  requestIdCounter += 1;
  return `req-${requestIdCounter}`;
}

function log(level, requestId, message, extra = {}) {
  const entry = {
    ts: nowIso(),
    level,
    requestId,
    message,
    ...extra,
  };
  // Single-line JSON logs are easier to parse in production.
  console.log(JSON.stringify(entry));
}

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const requestId = nextRequestId();
  const startedAt = Date.now();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  log("info", requestId, "request.start", {
    method: req.method,
    path: req.path,
  });

  res.on("finish", () => {
    log("info", requestId, "request.finish", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

app.get("/question", (_req, res) => {
  res.json({
    data: "Stone API is running.",
  });
});

app.get(`${apiPrefix}/health`, (_req, res) => {
  res.json({
    data: {
      ok: true,
      mysqlConfigured: hasMySqlConfig(),
    },
  });
});

app.post(`${apiPrefix}/search/products`, async (req, res) => {
  const { query = "", material = "", type = "" } = req.body || {};
  let searchQuery = String(query);
  let materialFilter = String(material).toLowerCase().trim();
  let typeFilter = String(type).toLowerCase().trim();

  if (typeFilter && !ALLOWED_ROW_TYPES.has(typeFilter)) {
    searchQuery += ` ${typeFilter}`;
    typeFilter = "";
  }
  if (materialFilter && !ALLOWED_MATERIALS.has(materialFilter)) {
    searchQuery += ` ${materialFilter}`;
    materialFilter = "";
  }

  const tokens = String(searchQuery)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .map((token) => (token.endsWith("s") ? token.slice(0, -1) : token))
    .filter(
      (token) =>
        !["find", "show", "get", "for", "with", "the", "and", "stone"].includes(
          token
        )
    )
    .filter((token) => token.length > 1);

  try {
    const pool = getPool();
    if (pool) {
      let sql = `
        SELECT code, name, material, type, color, finish, applications
        FROM stone
        WHERE 1=1
      `;
      const params = [];

      for (const token of tokens) {
        sql += ` AND (
          LOWER(name) LIKE ? OR LOWER(color) LIKE ? OR LOWER(material) LIKE ?
          OR LOWER(type) LIKE ? OR LOWER(finish) LIKE ?
          OR applications LIKE ?
        )`;
        const q = `%${token}%`;
        params.push(q, q, q, q, q, q);
      }
      if (materialFilter) {
        sql += " AND material = ?";
        params.push(materialFilter);
      }
      if (typeFilter) {
        sql += " AND type = ?";
        params.push(typeFilter);
      }

      sql += " LIMIT 50";
      const [rows] = await pool.execute(sql, params);
      const normalized = rows.map((r) => normalizeStoneRow(r));
      log("info", req.requestId, "search_products.mysql", {
        tokens,
        material: materialFilter,
        type: typeFilter,
        rowCount: normalized.length,
      });
      return res.json({ data: normalized });
    }

    const filtered = products.filter((item) => {
      const apps = Array.isArray(item.applications)
        ? item.applications.join(" ")
        : "";
      const haystack =
        `${item.name} ${item.color} ${item.material} ${item.type} ${item.finish} ${apps}`.toLowerCase();
      const queryMatch =
        !tokens.length || tokens.every((token) => haystack.includes(token));
      const materialMatch =
        !materialFilter || item.material === materialFilter;
      const typeMatch = !typeFilter || item.type === typeFilter;
      return queryMatch && materialMatch && typeMatch;
    });

    return res.json({
      data: filtered,
      meta: {
        source: "mock",
        note: "Configure DB_* env vars to use MySQL.",
      },
    });
  } catch (error) {
    log("error", req.requestId, "search_products.error", {
      error: error.message,
    });
    return res.status(500).json({
      error: true,
      message: "Failed to search products",
      details: error.message,
    });
  }
});

app.get(`${apiPrefix}/products/:code`, async (req, res) => {
  const { code } = req.params;

  try {
    const pool = getPool();
    if (pool) {
      const [rows] = await pool.execute(
        `
          SELECT code, name, material, type, color, finish, applications
          FROM stone
          WHERE code = ?
          LIMIT 1
        `,
        [code]
      );
      if (!rows.length) {
        return res.status(404).json({
          error: true,
          message: `Product ${code} not found`,
        });
      }
      log("info", req.requestId, "get_product_detail.mysql", {
        code,
        found: true,
      });
      return res.json({ data: normalizeStoneRow(rows[0]) });
    }

    const item = products.find((product) => product.code === code);
    if (!item) {
      return res.status(404).json({
        error: true,
        message: `Product ${code} not found`,
      });
    }
    return res.json({
      data: item,
      meta: { source: "mock" },
    });
  } catch (error) {
    log("error", req.requestId, "get_product_detail.error", {
      code,
      error: error.message,
    });
    return res.status(500).json({
      error: true,
      message: "Failed to retrieve product detail",
      details: error.message,
    });
  }
});

function getVietnamDateObject() {
  const now = new Date();
  const vietnam = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );
  return vietnam;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

app.get(`${aiDataPrefix}/gettime`, (_req, res) => {
  const now = getVietnamDateObject();
  return res.json({ data: formatTime(now) });
});

app.get(`${aiDataPrefix}/getdate`, (_req, res) => {
  const now = getVietnamDateObject();
  return res.json({ data: formatDate(now) });
});

app.get(`${aiDataPrefix}/getdatetime`, (_req, res) => {
  const now = getVietnamDateObject();
  return res.json({ data: `${formatDate(now)} ${formatTime(now)}` });
});

function validateApiKey(req, res, next) {
  const expectedKey = process.env.AI_DATA_API_KEY;
  if (!expectedKey) {
    return res.status(500).json({
      error: true,
      message: "Server API key is not configured",
    });
  }

  // Production server uses `x-getdata-key`; integration spec text uses
  // `x-api-key`. Accept both for backward compatibility.
  const key = req.header("x-api-key") || req.header("x-getdata-key");
  if (!key || key !== expectedKey) {
    log("warn", req.requestId, "auth.invalid_api_key", {
      path: req.path,
    });
    return res.status(401).json({
      error: true,
      message: "Invalid API key",
    });
  }
  next();
}

app.get(
  `${aiDataPrefix}/get-material-content-pages`,
  validateApiKey,
  async (req, res) => {
    try {
      const pool = getPool();
      if (pool) {
        const [rows] = await pool.execute(
          `
          SELECT page_content
          FROM material_content_pages
          WHERE published = true
          LIMIT 100
        `
        );
        log("info", req.requestId, "get_material_content_pages.mysql", {
          rowCount: rows.length,
        });
        // Production server returns a bare JSON array (see integration guide
        // example response). Match that shape exactly.
        return res.json(rows);
      }

      log("info", req.requestId, "get_material_content_pages.mock", {
        rowCount: materialContentPages.length,
      });
      return res.json(materialContentPages);
    } catch (error) {
      log("error", req.requestId, "get_material_content_pages.error", {
        error: error.message,
      });
      return res.status(500).json({
        error: true,
        message: "Failed to retrieve content pages from published materials",
        details: error.message,
      });
    }
  }
);

// Text search over published material content pages.
// Spec: GET /aiData/getsearch?keyword=...  (requires x-getdata-key | x-api-key)
//
// The published example also uses the keys-only style:
//   /aiData/getsearch?gray+granite+in+a+cool+tone
// We accept both shapes and return a bare JSON array.
function extractKeyword(req) {
  const direct = req.query.keyword ?? req.query.q;
  if (direct != null && String(direct).trim() !== "") {
    return String(direct).trim();
  }
  const keys = Object.keys(req.query || {});
  if (keys.length === 1 && (req.query[keys[0]] === "" || req.query[keys[0]] == null)) {
    return keys[0].trim();
  }
  if (keys.length > 1) {
    const allEmpty = keys.every(
      (k) => req.query[k] === "" || req.query[k] == null
    );
    if (allEmpty) return keys.join(" ").trim();
  }
  return "";
}

function scoreMatch(content, tokens) {
  if (!tokens.length) return 0;
  const lower = String(content || "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const matches = lower.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

app.get(`${aiDataPrefix}/getsearch`, validateApiKey, async (req, res) => {
  const keyword = extractKeyword(req);
  if (!keyword) {
    return res.status(400).json({
      error: true,
      message: "Missing required query parameter: keyword",
    });
  }

  const tokens = keyword
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1);

  try {
    const pool = getPool();
    if (pool) {
      const conditions = tokens.length
        ? tokens.map(() => "LOWER(page_content) LIKE ?").join(" OR ")
        : "1=1";
      const params = tokens.map((t) => `%${t}%`);
      const sql = `
        SELECT page_content
        FROM material_content_pages
        WHERE published = true
          ${tokens.length ? `AND (${conditions})` : ""}
        LIMIT 200
      `;
      const [rows] = await pool.execute(sql, params);
      const ranked = rows
        .map((r) => ({ ...r, _score: scoreMatch(r.page_content, tokens) }))
        .filter((r) => r._score > 0 || tokens.length === 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 50)
        .map(({ _score, ...rest }) => rest);
      log("info", req.requestId, "getsearch.mysql", {
        keyword,
        tokens,
        rowCount: ranked.length,
      });
      return res.json(ranked);
    }

    const ranked = materialContentPages
      .map((page) => ({
        ...page,
        _score: scoreMatch(page.page_content, tokens),
      }))
      .filter((p) => p._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 50)
      .map(({ _score, ...rest }) => rest);
    log("info", req.requestId, "getsearch.mock", {
      keyword,
      tokens,
      rowCount: ranked.length,
    });
    return res.json(ranked);
  } catch (error) {
    log("error", req.requestId, "getsearch.error", {
      error: error.message,
    });
    return res.status(500).json({
      error: true,
      message: "Failed to search content pages",
      details: error.message,
    });
  }
});

function logStartupChecks() {
  const missingDb = getMissingMySqlEnv();
  if (missingDb.length) {
    log("warn", "startup", "mysql.config.missing", {
      missingEnv: missingDb,
      mode: "mock-fallback",
    });
  } else {
    log("info", "startup", "mysql.config.present");
  }

  if (!process.env.AI_DATA_API_KEY) {
    log("warn", "startup", "ai_data_api_key.missing", {
      endpoint: "/api/aiData/get-material-content-pages",
    });
  }
}

app.listen(port, () => {
  logStartupChecks();
  log("info", "startup", "server.listening", {
    url: `http://localhost:${port}`,
  });
});
