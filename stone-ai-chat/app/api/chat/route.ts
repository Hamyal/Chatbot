import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

type ChatRequestBody = {
  // Legacy single-message form (still supported for backwards compatibility).
  message?: string;
  // Preferred form: full conversation so the agent keeps context and can
  // re-route to the right tool when the user switches topic mid-chat.
  messages?: { role?: string; content?: string }[];
};

// Cap how much history we forward to keep token usage bounded on long chats.
const MAX_HISTORY_MESSAGES = 20;

const TOOL_NAMES = {
  SEARCH_PRODUCTS: "search_products",
  GET_PRODUCT_DETAIL: "get_product_detail",
  GET_VIETNAM_TIME: "get_vietnam_time",
  GET_MATERIAL_CONTENT_PAGES: "get_material_content_pages",
} as const;

const openaiTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_PRODUCTS,
      description:
        "Search natural stone products. Put use-cases (paving, flooring, outdoor) in query. Use material/type filters only for real catalog values.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "User intent: materials, colors, paving, outdoor, etc.",
          },
          material: {
            type: "string",
            description:
              "Only if user names a stone family: marble, granite, travertine, limestone, quartz. Otherwise empty.",
          },
          type: {
            type: "string",
            description:
              "Only product form: slab, tile, or block. Never use paving here — put paving in query.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_PRODUCT_DETAIL,
      description:
        "Get one product by catalog code (e.g. M608, M742). Use when user gives a code or asks for details.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Catalog code like M608.",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_VIETNAM_TIME,
      description:
        "Get Vietnam timezone current time, date only, or full date-time. Pick kind from user intent.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["time", "date", "datetime"],
            description:
              "time = clock only, date = YYYY-MM-DD, datetime = both.",
          },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES,
      description:
        "Fetch published material content pages (markdown text) for RAG-style answers. Requires server API key.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

const BACKEND_FETCH_MS = 25_000;

async function callBackend(path: string, options?: RequestInit) {
  const baseUrl = process.env.STONE_API_BASE_URL || "http://localhost:3001/api";
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(BACKEND_FETCH_MS),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      response.ok
        ? "Backend returned invalid JSON"
        : `Backend error (${response.status})`
    );
  }
  // The integration spec says some endpoints return bare JSON arrays
  // (e.g. /aiData/get-material-content-pages, /aiData/getsearch). Normalize
  // every response to { data, error, message } so the rest of this module
  // can keep using `payload.data` everywhere.
  let payload: { data?: unknown; error?: boolean; message?: string };
  if (Array.isArray(parsed)) {
    payload = { data: parsed };
  } else if (parsed && typeof parsed === "object") {
    payload = parsed as typeof payload;
    if (payload.data === undefined && !("error" in payload)) {
      payload = { data: parsed };
    }
  } else {
    payload = { data: parsed };
  }
  if (!response.ok) {
    throw new Error(payload?.message || "Backend request failed");
  }
  return payload;
}

async function executeToolCall(name: string, argsJson: string) {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return { error: true, message: "Invalid tool arguments JSON" };
  }

  try {
    switch (name) {
      case TOOL_NAMES.SEARCH_PRODUCTS: {
        const body = {
          query: String(args.query ?? ""),
          material: String(args.material ?? ""),
          type: String(args.type ?? ""),
        };
        return await callBackend("/search/products", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      case TOOL_NAMES.GET_PRODUCT_DETAIL: {
        const code = String(args.code ?? "").trim().toUpperCase();
        if (!code) {
          return { error: true, message: "Missing product code" };
        }
        return await callBackend(`/products/${encodeURIComponent(code)}`);
      }
      case TOOL_NAMES.GET_VIETNAM_TIME: {
        const kind = String(args.kind ?? "datetime");
        const path =
          kind === "date"
            ? "/aiData/getdate"
            : kind === "time"
              ? "/aiData/gettime"
              : "/aiData/getdatetime";
        return await callBackend(path);
      }
      case TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES: {
        const apiKey = process.env.AI_DATA_API_KEY || "";
        return await callBackend("/aiData/get-material-content-pages", {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
          },
        });
      }
      default:
        return { error: true, message: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    return { error: true, message: msg };
  }
}

/** Convert incoming UI history into OpenAI chat messages (system prompt added separately). */
function toOpenAIHistory(
  history: { role?: string; content?: string }[]
): ChatCompletionMessageParam[] {
  return history
    .filter((m) => typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) =>
      m.role === "assistant"
        ? { role: "assistant", content: String(m.content) }
        : { role: "user", content: String(m.content) }
    );
}

async function runOpenAIChat(history: { role?: string; content?: string }[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const client = new OpenAI({
    apiKey,
    maxRetries: 1,
    timeout: 60_000,
  });

  // Single orchestrator agent: one brain, all tools. It re-evaluates every
  // turn, so a follow-up that switches topic (general info -> product search)
  // is routed to the right tool automatically, with full conversation context.
  const systemPrompt =
    "You are a helpful assistant for natural stone products. " +
    "You handle everything in one conversation: general information about " +
    "stone materials/finishes/applications, product search, and product " +
    "details. On EACH new user message, decide fresh which tool (if any) is " +
    "needed for that message — do not stay locked to the previous topic. " +
    "Use search_products or get_product_detail for catalog lookups, " +
    "get_material_content_pages for background/how-to content, and " +
    "get_vietnam_time for time questions. " +
    "Use the tools to get real data from the backend. " +
    "Never invent catalog codes or product lists. " +
    "Use the earlier conversation for context (e.g. 'show me more like that'). " +
    "After tools return, answer in clear, concise natural language.";

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...toOpenAIHistory(history),
  ];

  const maxRounds = 6;
  let lastToolName = "";

  for (let round = 0; round < maxRounds; round++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: openaiTools,
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) {
      break;
    }

    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls?.length) {
      const text = assistantMsg.content?.trim() || "";
      return NextResponse.json({
        data: {
          tool: lastToolName || "openai",
          answer: text,
          raw: null,
        },
      });
    }

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      lastToolName = tc.function.name;
      const result = await executeToolCall(
        tc.function.name,
        tc.function.arguments
      );
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return NextResponse.json({
    data: {
      tool: lastToolName || "openai",
      answer: "I could not finish the request. Please try again.",
      raw: null,
    },
  });
}

function selectTool(message: string) {
  const lower = message.toLowerCase();

  if (
    lower.includes("time") ||
    lower.includes("date") ||
    lower.includes("datetime")
  ) {
    return TOOL_NAMES.GET_VIETNAM_TIME;
  }
  if (
    lower.includes("content page") ||
    lower.includes("material content") ||
    lower.includes("published material")
  ) {
    return TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES;
  }
  if (
    lower.includes("detail") ||
    lower.includes("catalog") ||
    /\bM\d{3,}\b/i.test(message)
  ) {
    return TOOL_NAMES.GET_PRODUCT_DETAIL;
  }
  return TOOL_NAMES.SEARCH_PRODUCTS;
}

function inferSearchArguments(message: string) {
  const lower = message.toLowerCase();
  const materials = ["granite", "marble", "travertine", "limestone", "quartz"];
  const types = ["slab", "tile", "block"];

  const material = materials.find((m) => lower.includes(m)) || "";
  const type = types.find((t) => lower.includes(t)) || "";
  return { query: message, material, type };
}

function inferProductCode(message: string) {
  const match = message.match(/\bM\d{3,}\b/i);
  return match?.[0]?.toUpperCase() || "";
}

async function runRuleBasedChat(message: string) {
  const selectedTool = selectTool(message);

  if (selectedTool === TOOL_NAMES.GET_VIETNAM_TIME) {
    const lower = message.toLowerCase();
    const endpoint =
      lower.includes("date") && !lower.includes("time")
        ? "/aiData/getdate"
        : lower.includes("datetime")
          ? "/aiData/getdatetime"
          : "/aiData/gettime";
    const data = await callBackend(endpoint);
    return NextResponse.json({
      data: {
        tool: selectedTool,
        answer: `Vietnam response: ${data.data}`,
        raw: data,
      },
    });
  }

  if (selectedTool === TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES) {
    const apiKey = process.env.AI_DATA_API_KEY || "";
    const data = await callBackend("/aiData/get-material-content-pages", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    });
    const pages = Array.isArray(data?.data) ? data.data : [];
    return NextResponse.json({
      data: {
        tool: selectedTool,
        answer: `Found ${pages.length} published material content pages.`,
        raw: data,
      },
    });
  }

  if (selectedTool === TOOL_NAMES.GET_PRODUCT_DETAIL) {
    const code = inferProductCode(message);
    if (!code) {
      return NextResponse.json({
        data: {
          tool: selectedTool,
          answer: "Please provide a catalog code, e.g. M608.",
          raw: null,
        },
      });
    }
    const data = await callBackend(`/products/${code}`);
    const row = data.data as {
      name: string;
      material: string;
      type: string;
      finish: string;
    };
    return NextResponse.json({
      data: {
        tool: selectedTool,
        answer: `Product ${code}: ${row.name} (${row.material}, ${row.type}, ${row.finish}).`,
        raw: data,
      },
    });
  }

  const args = inferSearchArguments(message);
  const data = await callBackend("/search/products", {
    method: "POST",
    body: JSON.stringify(args),
  });

  const items = Array.isArray(data.data)
    ? (data.data as {
        name: string;
        code: string;
        material: string;
        type: string;
      }[])
    : [];
  const top = items.slice(0, 3);
  const preview = top
    .map((item) => `${item.name} (${item.code}, ${item.material}, ${item.type})`)
    .join("; ");

  return NextResponse.json({
    data: {
      tool: selectedTool,
      answer: items.length
        ? `Found ${items.length} products. Top matches: ${preview}`
        : "No products matched your request.",
      raw: data,
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatRequestBody;

    // Accept either the full conversation (preferred) or a single message.
    const history: { role?: string; content?: string }[] =
      Array.isArray(body.messages) && body.messages.length
        ? body.messages
        : body.message
          ? [{ role: "user", content: body.message }]
          : [];

    // The latest user turn — used for the rule-based fallback.
    const lastUser = [...history]
      .reverse()
      .find((m) => m.role !== "assistant" && m.content?.trim());
    const message = lastUser?.content?.trim();

    if (!message) {
      return NextResponse.json(
        { error: true, message: "message is required" },
        { status: 400 }
      );
    }

    if (process.env.OPENAI_API_KEY?.trim()) {
      try {
        const openaiResult = await runOpenAIChat(history);
        if (openaiResult) {
          return openaiResult;
        }
      } catch (openaiErr) {
        console.error("[api/chat] OpenAI error, falling back:", openaiErr);
      }
    }

    return await runRuleBasedChat(message);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: true, message: msg }, { status: 500 });
  }
}
