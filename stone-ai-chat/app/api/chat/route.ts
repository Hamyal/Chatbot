import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const runtime = "nodejs";

/**
 * Streaming orchestrator.
 *
 * One agent holds every capability (stone knowledge via the vector store,
 * catalog search via the REST API, product detail, time). It re-decides on
 * every user message, so a follow-up that changes topic is routed correctly
 * while keeping the full conversation context.
 *
 * The route streams NDJSON "step" events as work happens so the UI can show
 * what the AI is thinking/doing: intent -> routing -> retrieval -> API call
 * -> response generation.
 */

type ChatRequestBody = {
  message?: string;
  messages?: { role?: string; content?: string }[];
};

const MAX_HISTORY_MESSAGES = 20;
const BACKEND_FETCH_MS = 25_000;

const TOOL_NAMES = {
  SEARCH_KNOWLEDGE: "search_stone_knowledge",
  SEARCH_PRODUCTS: "search_products",
  GET_PRODUCT_DETAIL: "get_product_detail",
  GET_VIETNAM_TIME: "get_vietnam_time",
  GET_MATERIAL_CONTENT_PAGES: "get_material_content_pages",
} as const;

/** Human-readable labels shown in the activity panel. */
const TOOL_LABELS: Record<string, string> = {
  [TOOL_NAMES.SEARCH_KNOWLEDGE]: "Knowledge retrieval (vector store)",
  [TOOL_NAMES.SEARCH_PRODUCTS]: "Catalog search (Stone Curators API)",
  [TOOL_NAMES.GET_PRODUCT_DETAIL]: "Catalog lookup by code",
  [TOOL_NAMES.GET_VIETNAM_TIME]: "Time lookup (REST API)",
  [TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES]: "Published materials list",
};

const openaiTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_KNOWLEDGE,
      description:
        "Search the natural-stone knowledge base (vector store) for general " +
        "information: what a material is, properties, finishes, care and " +
        "maintenance, installation, comparisons, suitability advice. Use this " +
        "for explanatory questions rather than catalog lookups.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The information need, phrased as a search query.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_PRODUCTS,
      description:
        "Search actual stone products in the catalog. Fill in every criterion " +
        "the visitor mentioned — species, origin, source, color, finish, " +
        "application, shape, lead time, cost, product name, catalog number.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The visitor's request in their own words.",
          },
          material: {
            type: "string",
            description:
              "Stone species/family if named: marble, granite, travertine, limestone, quartz.",
          },
          type: {
            type: "string",
            description:
              "Product form only: slab, tile, or block. Never put paving here.",
          },
          color: {
            type: "string",
            description:
              "Dominant color, color feeling (warm/cool/light/dark) or pattern (speckled, cloudy, streaks).",
          },
          finish: {
            type: "string",
            description:
              "Surface finish: adze, split-face, honed, flamed, polished, tumbled, ...",
          },
          application: {
            type: "string",
            description:
              "Use or suitability: exterior paving, wall cladding, pool deck, steps, landscape, freeze-thaw, not slippery, ...",
          },
          shape: {
            type: "string",
            description: "Shape: planks, cobble, mosaic, flagstone, veneer, ...",
          },
          origin: {
            type: "string",
            description:
              "Where quarried or gathered, and/or source: Maine, Italy, reclaimed, gathered, quarried, ...",
          },
          lead_time: {
            type: "string",
            description:
              "Delivery expectation: available inventory, quick ship, two weeks, 6-8 weeks, ...",
          },
          cost: {
            type: "string",
            description: "Relative cost: cheap, not expensive, $$, ...",
          },
          product_name: {
            type: "string",
            description:
              "Exact product name if given, e.g. 'Strata Mist Cross-Cut Gneiss'.",
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
          code: { type: "string", description: "Catalog code like M608." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES,
      description:
        "List all published material content pages from the catalog. Use when " +
        "the visitor wants to browse what materials are available rather than " +
        "search for something specific.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_VIETNAM_TIME,
      description:
        "Get Vietnam timezone current time, date only, or full date-time.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["time", "date", "datetime"],
            description: "time = clock only, date = YYYY-MM-DD, datetime = both.",
          },
        },
        required: ["kind"],
      },
    },
  },
];

async function callBackend(path: string, options?: RequestInit) {
  const baseUrl = process.env.STONE_API_BASE_URL || "http://localhost:3001/api";
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
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

/**
 * Catalog text search.
 *
 * Per the integration guide the keyword goes in as a bare query string with
 * `+` between words — e.g. `/aiData/getsearch?gray+granite+in+a+cool+tone` —
 * not as a named `keyword=` parameter.
 */
async function callSearch(keywords: string) {
  const words = keywords
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => encodeURIComponent(w));
  if (!words.length) {
    return { error: true, message: "Empty search keywords" };
  }
  return await callBackend(`/aiData/getsearch?${words.join("+")}`, {
    headers: { "x-api-key": process.env.AI_DATA_API_KEY || "" },
  });
}

/**
 * Search the configured vector store. Kept as an explicit tool (rather than
 * the built-in server-side file_search) so retrieval shows up as its own
 * visible step in the activity panel.
 */
async function searchVectorStore(client: OpenAI, query: string) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID?.trim();
  if (!vectorStoreId) {
    return {
      error: true,
      message:
        "No vector store configured. Set OPENAI_VECTOR_STORE_ID to enable " +
        "general stone knowledge retrieval.",
    };
  }

  const result = await client.vectorStores.search(vectorStoreId, {
    query,
    max_num_results: 5,
  });

  const chunks = (result.data || []).map((item) => ({
    filename: item.filename,
    score: item.score,
    text: (item.content || [])
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n")
      .slice(0, 4000),
  }));

  return { data: chunks, meta: { vectorStoreId, resultCount: chunks.length } };
}

/** Short human summary of a tool result for the activity panel. */
function summarizeResult(name: string, result: unknown): string {
  const payload = result as { data?: unknown; error?: boolean; message?: string };
  if (payload?.error) return `Error: ${payload.message ?? "failed"}`;
  const data = payload?.data;
  if (Array.isArray(data)) {
    if (name === TOOL_NAMES.SEARCH_KNOWLEDGE) {
      return `${data.length} knowledge passage(s) retrieved`;
    }
    // Catalog pages carry their catalog number inside the markdown content;
    // surfacing the codes makes the activity panel genuinely informative.
    const codes = data
      .map((row) => {
        const text = (row as { page_content?: string })?.page_content ?? "";
        return text.match(/Catalog Number:\s*([A-Za-z]?\d+)/)?.[1];
      })
      .filter(Boolean)
      .slice(0, 6);
    return codes.length
      ? `${data.length} result(s): ${codes.join(", ")}${data.length > codes.length ? ", …" : ""}`
      : `${data.length} result(s)`;
  }
  if (data && typeof data === "object") {
    const code = (data as { code?: string }).code;
    return code ? `Found ${code}` : "1 result";
  }
  if (typeof data === "string") return data;
  return "done";
}

async function executeToolCall(
  client: OpenAI,
  name: string,
  argsJson: string
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return { error: true, message: "Invalid tool arguments JSON" };
  }

  try {
    switch (name) {
      case TOOL_NAMES.SEARCH_KNOWLEDGE:
        return await searchVectorStore(client, String(args.query ?? ""));

      case TOOL_NAMES.SEARCH_PRODUCTS: {
        // Every criterion the visitor gave is folded into one keyword string —
        // the catalog's text search scores against rich content embeddings that
        // already cover origin, finish, suitability, shape, lead time & price.
        const criteriaKeys = [
          "material",
          "type",
          "color",
          "finish",
          "application",
          "shape",
          "origin",
          "lead_time",
          "cost",
          "product_name",
        ];
        const extras = criteriaKeys
          .map((k) => String(args[k] ?? "").trim())
          .filter(Boolean)
          .join(" ");
        const keywords = [String(args.query ?? "").trim(), extras]
          .filter(Boolean)
          .join(" ");
        return await callSearch(keywords);
      }

      case TOOL_NAMES.GET_PRODUCT_DETAIL: {
        const code = String(args.code ?? "").trim();
        if (!code) return { error: true, message: "Missing product code" };
        // The catalog has no by-code endpoint; the code itself is a strong
        // search keyword because it appears in each page's content.
        return await callSearch(code);
      }

      case TOOL_NAMES.GET_MATERIAL_CONTENT_PAGES:
        return await callBackend("/aiData/get-material-content-pages", {
          headers: { "x-api-key": process.env.AI_DATA_API_KEY || "" },
        });

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

      default:
        return { error: true, message: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return {
      error: true,
      message: e instanceof Error ? e.message : "Tool execution failed",
    };
  }
}

const SYSTEM_PROMPT =
  // Identity — carried over from the original General Info agent.
  "You are a representative of Stone Curators, a company specializing in " +
  "finding and supplying reclaimed and hard-to-find natural stone from around " +
  "the world. Your customers are typically architects, landscape architects, " +
  "interior designers, and construction contractors. ALWAYS treat a question " +
  "as being about Stone Curators or natural stone, and answer as a Stone " +
  "Curators representative.\n\n" +
  "You handle the whole conversation yourself. On EACH new user message, decide " +
  "fresh which of the three intents below it belongs to. Do not stay locked to " +
  "the previous topic — if the user moves between intents, follow them.\n\n" +
  "INTENT 1 — STONE SEARCH (use search_products / get_product_detail).\n" +
  "The visitor is looking for or inquiring about a natural stone product based " +
  "on any combination of:\n" +
  "- stone species (granite, limestone, gneiss, ...)\n" +
  "- where quarried or gathered (Maine, Italy, Asia, ...)\n" +
  "- source of the stone (quarried, gathered, reclaimed, ...)\n" +
  "- dominant color (blue, reddish, dark gray, ...)\n" +
  "- color feeling (warm, cool, light, dark, ...)\n" +
  "- color pattern (speckled, cloudy, streaks, ...)\n" +
  "- surface finish (adze, split-face, honed, flamed, ...)\n" +
  "- surface finish suitability (wall cladding, exterior paving, rustic paving)\n" +
  "- general suitability (freeze-thaw conditions, not slippery, high heels, ...)\n" +
  "- general application (landscape stone, building stone, indoor use, ...)\n" +
  "- product category (building stone, driveway paving, landscape stone, ...)\n" +
  "- specific uses (pool deck, steps, interior wall cladding, ...)\n" +
  "- shapes (planks, cobble, mosaic, flagstone, ...)\n" +
  "- delivery lead time (available inventory, quick ship, two weeks, 6-8 weeks)\n" +
  "- relative cost (not expensive, cheap, $$, ...)\n" +
  "- a Stone Curators URL (stonecurators.com/product/226, /material/1252, ...)\n" +
  "- product name (Lake Champlain Granite - Veneer, Strata Mist Cross-Cut " +
  "Gneiss, Stoughton Pond Soapstone - honed, ...)\n" +
  "- catalog number (p226, P433, m1253, M1133, ...)\n\n" +
  "INTENT 2 — GENERAL INFO (use search_stone_knowledge).\n" +
  "The visitor wants information about Stone Curators, or non-search " +
  "information about natural stone, including:\n" +
  "- location of Stone Curators\n" +
  "- what type of clients Stone Curators serves\n" +
  "- Stone Curators' process for working with designers\n" +
  "- cultural history of natural stone\n" +
  "- natural history of stone\n" +
  "- natural stone type (metamorphic, sedimentary, igneous, ...)\n" +
  "- natural stone species (granite, limestone, gneiss, ...)\n" +
  "- installation\n" +
  "- maintenance and care\n" +
  "- repair\n\n" +
  "INTENT 3 — EVERYTHING ELSE.\n" +
  "The visitor is NOT looking for information about natural stone, Stone " +
  "Curators, or the products Stone Curators sells. Do not call any tool. " +
  "Politely explain that you can only help with Stone Curators and natural " +
  "stone, and offer to help with that instead.\n\n" +
  "Other tools:\n" +
  "- get_vietnam_time: time or date questions.\n\n" +
  "About catalog results:\n" +
  "- Results come back as markdown content pages. Each has a Catalog Number " +
  "(P… = a product, M… = a material), a Product/Material URL, often an Image " +
  "URL, plus origin, colors, patterns, finishes, applications, specific uses, " +
  "suitability, shapes, lead time, relative price and related products.\n" +
  "- Read those pages and answer from them. Quote the catalog number and " +
  "include the Product/Material URL so the visitor can click through.\n" +
  "- Higher 'Search Match Score' means a better match; lead with those.\n\n" +
  "Grounding rules:\n" +
  "- Answer general questions using ONLY the content returned by " +
  "search_stone_knowledge. Do not fill gaps from your own knowledge.\n" +
  "- Never invent catalog codes, product names, or product lists.\n" +
  "- If a tool returns nothing relevant, say so honestly rather than guessing.\n" +
  "- When asked about addresses or locations, include the Google Maps link for " +
  "each location if one is provided in the retrieved content.\n" +
  "- Use the earlier conversation for context (e.g. 'which ones are white?').\n" +
  "- After tools return, reply in clear, concise natural language.";

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

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json(
      { error: true, message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const history =
    Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : body.message
        ? [{ role: "user", content: body.message }]
        : [];

  const lastUser = [...history]
    .reverse()
    .find((m) => m.role !== "assistant" && m.content?.trim());
  if (!lastUser?.content?.trim()) {
    return Response.json(
      { error: true, message: "message is required" },
      { status: 400 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: true, message: "OPENAI_API_KEY is not configured" },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stepId = 0;
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      /** Emit a step and return its id so it can be completed later. */
      const startStep = (kind: string, title: string, detail?: string) => {
        const id = `s${++stepId}`;
        send({ t: "step", id, kind, title, detail, status: "running" });
        return { id, at: Date.now() };
      };
      const endStep = (
        step: { id: string; at: number },
        status: "done" | "error",
        detail?: string
      ) => {
        send({
          t: "step",
          id: step.id,
          status,
          detail,
          ms: Date.now() - step.at,
        });
      };

      try {
        const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000 });
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: SYSTEM_PROMPT },
          ...toOpenAIHistory(history),
        ];

        const maxRounds = 6;
        for (let round = 0; round < maxRounds; round++) {
          const thinking = startStep(
            "intent",
            round === 0
              ? "Understanding the question"
              : "Reviewing tool results",
            round === 0 ? `"${lastUser.content}"` : undefined
          );

          const completion = await client.chat.completions.create({
            model,
            messages,
            tools: openaiTools,
            tool_choice: "auto",
          });

          const assistantMsg = completion.choices[0]?.message;
          if (!assistantMsg) {
            endStep(thinking, "error", "No response from model");
            send({ t: "error", message: "No response from model" });
            break;
          }

          messages.push(assistantMsg);
          const toolCalls = assistantMsg.tool_calls;

          if (!toolCalls?.length) {
            endStep(
              thinking,
              "done",
              round === 0 ? "Answered directly (no tool needed)" : "Ready to answer"
            );
            const gen = startStep("generate", "Generating response");
            const answer = assistantMsg.content?.trim() || "";
            endStep(gen, "done", `${answer.length} characters`);
            send({ t: "answer", answer });
            break;
          }

          endStep(
            thinking,
            "done",
            `Routing to: ${toolCalls
              .map((tc) => (tc.type === "function" ? tc.function.name : tc.type))
              .join(", ")}`
          );

          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;
            const toolName = tc.function.name;
            const label = TOOL_LABELS[toolName] || toolName;

            let argPreview = tc.function.arguments;
            try {
              argPreview = JSON.stringify(JSON.parse(tc.function.arguments));
            } catch {
              /* keep raw string if it is not valid JSON */
            }

            const step = startStep("tool", label, argPreview);
            const result = await executeToolCall(
              client,
              toolName,
              tc.function.arguments
            );
            const failed = (result as { error?: boolean })?.error === true;
            endStep(
              step,
              failed ? "error" : "done",
              summarizeResult(toolName, result)
            );

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected server error";
        console.error("[api/chat] error:", err);
        send({ t: "error", message });
      } finally {
        send({ t: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
