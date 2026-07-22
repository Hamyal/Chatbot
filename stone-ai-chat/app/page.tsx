"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

const SPLASH_MS = 2000;

/** One visible unit of work the agent performed. */
type Step = {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: "running" | "done" | "error";
  ms?: number;
};

type ChatMessage = {
  role: "assistant" | "user";
  content: string;
  time: string;
  steps?: Step[];
};

const quickPrompts = [
  "Show black granite for exterior paving",
  "What is the difference between honed and polished?",
  "Which white ones do you have?",
] as const;

const initialMessages: ChatMessage[] = [
  {
    role: "assistant",
    content:
      "Hello! Ask me about stone materials, finishes, colors, and applications.",
    time: "09:41",
  },
];

const getClockTime = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Strip common markdown so `**bold**` and `*italic*` are not shown as raw stars. */
function plainChatText(input: string): string {
  let s = input;
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/\*\*/g, "");
  return s;
}

const STEP_STYLES: Record<Step["status"], string> = {
  running: "bg-amber-400 animate-pulse",
  done: "bg-emerald-500",
  error: "bg-rose-500",
};

const KIND_LABELS: Record<string, string> = {
  intent: "Intent / routing",
  tool: "Tool call",
  generate: "Response",
};

function ActivityPanel({
  steps,
  live,
}: {
  steps: Step[];
  live?: boolean;
}) {
  if (!steps.length) return null;
  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        <span>AI activity</span>
        {live && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        )}
      </p>
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.id} className="flex gap-2.5">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STEP_STYLES[step.status]}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-slate-800">
                <span>{step.title}</span>
                <span className="text-[10px] font-normal uppercase tracking-wide text-slate-400">
                  {KIND_LABELS[step.kind] || step.kind}
                </span>
                {typeof step.ms === "number" && (
                  <span className="text-[10px] font-normal text-slate-400">
                    {step.ms} ms
                  </span>
                )}
              </p>
              {step.detail && (
                <p className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-slate-500">
                  {step.detail}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [liveSteps, setLiveSteps] = useState<Step[]>([]);
  const [showActivity, setShowActivity] = useState(true);

  useEffect(() => {
    const id = window.setTimeout(() => setShowChat(true), SPLASH_MS);
    return () => window.clearTimeout(id);
  }, []);

  const messageCount = useMemo(() => messages.length, [messages]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed, time: getClockTime() },
    ];
    setMessages(nextMessages);
    setInput("");
    setIsThinking(true);
    setLiveSteps([]);

    // Steps accumulate here as the stream arrives, then get attached to the
    // finished assistant message so the trace stays visible in the transcript.
    const collected: Step[] = [];
    let answer = "";
    let failure = "";

    const applyEvent = (event: Record<string, unknown>) => {
      if (event.t === "step") {
        const id = String(event.id);
        const existing = collected.findIndex((s) => s.id === id);
        if (existing === -1) {
          collected.push({
            id,
            kind: String(event.kind ?? ""),
            title: String(event.title ?? ""),
            detail: event.detail ? String(event.detail) : undefined,
            status: (event.status as Step["status"]) ?? "running",
            ms: typeof event.ms === "number" ? event.ms : undefined,
          });
        } else {
          const prev = collected[existing];
          collected[existing] = {
            ...prev,
            status: (event.status as Step["status"]) ?? prev.status,
            detail: event.detail ? String(event.detail) : prev.detail,
            ms: typeof event.ms === "number" ? event.ms : prev.ms,
          };
        }
        setLiveSteps([...collected]);
      } else if (event.t === "answer") {
        answer = String(event.answer ?? "");
      } else if (event.t === "error") {
        failure = String(event.message ?? "Unknown error");
      }
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({
            role,
            content,
          })),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.body) {
        throw new Error("No response stream from server");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // NDJSON: one JSON event per line; the tail may be a partial line.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            applyEvent(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* ignore malformed line */
          }
        }
      }
      if (buffer.trim()) {
        try {
          applyEvent(JSON.parse(buffer) as Record<string, unknown>);
        } catch {
          /* ignore trailing partial */
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            answer ||
            (failure
              ? `Something went wrong: ${failure}`
              : "I could not generate a response."),
          time: getClockTime(),
          steps: collected,
        },
      ]);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "TimeoutError";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: isAbort
            ? "Request timed out. Try a shorter message or check your network and OpenAI API."
            : "Connection failed. Start stone-api (port 3001) and stone-ai-chat, then try again.",
          time: getClockTime(),
          steps: collected,
        },
      ]);
    } finally {
      setIsThinking(false);
      setLiveSteps([]);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!input.trim() || isThinking) return;
    void sendMessage(input);
  };

  return (
    <div className="relative min-h-screen bg-slate-100 p-4 md:p-8">
      <div
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-stone-900 transition-opacity duration-700 ease-out ${
          showChat ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        aria-hidden={showChat}
        aria-busy={!showChat}
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-stone-500/15 via-transparent to-transparent" />
        <div className="relative flex max-w-lg flex-col items-center px-8 text-center">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.35em] text-stone-400">
            Welcome
          </p>
          <h1 className="mb-2 text-4xl font-semibold tracking-tight text-white md:text-5xl">
            Stone AI
          </h1>
          <p className="mb-10 text-lg text-stone-300 md:text-xl">Assistant</p>
          <div className="flex flex-col items-center gap-4">
            <div
              className="h-10 w-10 animate-spin rounded-full border-2 border-stone-600 border-t-amber-400/90"
              role="status"
              aria-label="Loading"
            />
            <p className="text-sm text-stone-500">Opening chat…</p>
          </div>
        </div>
      </div>

      <main
        className={`mx-auto flex h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl transition-all duration-700 ease-out md:h-[calc(100vh-4rem)] ${
          showChat ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
        }`}
      >
        <header className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                Stone AI
              </p>
              <h1 className="text-lg font-semibold text-slate-900">
                Product Assistant
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowActivity((v) => !v)}
                aria-pressed={showActivity}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  showActivity
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {showActivity ? "Hide AI activity" : "Show AI activity"}
              </button>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                {messageCount} messages
              </span>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                Online
              </span>
            </div>
          </div>
        </header>

        <section className="border-b border-slate-100 bg-slate-50 px-5 py-3">
          <p className="mb-2 text-xs font-medium text-slate-600">
            Suggested prompts
          </p>
          <div className="flex flex-wrap gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => void sendMessage(prompt)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </section>

        <section className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-slate-50 px-5 py-5">
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((message, index) => {
              const isUser = message.role === "user";
              return (
                <article
                  key={`${message.time}-${index}`}
                  className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${
                    isUser
                      ? "ml-auto bg-slate-900 text-white"
                      : "bg-white text-slate-800 ring-1 ring-slate-200"
                  }`}
                >
                  <p
                    className={`text-sm leading-relaxed ${!isUser ? "whitespace-pre-wrap" : ""}`}
                  >
                    {isUser ? message.content : plainChatText(message.content)}
                  </p>
                  {!isUser && showActivity && message.steps?.length ? (
                    <ActivityPanel steps={message.steps} />
                  ) : null}
                  <p
                    className={`mt-2 text-right text-[11px] ${
                      isUser ? "text-slate-300" : "text-slate-500"
                    }`}
                  >
                    {message.time}
                  </p>
                </article>
              );
            })}
            {isThinking && (
              <article className="max-w-[85%] rounded-2xl bg-white px-4 py-3 text-slate-600 shadow-sm ring-1 ring-slate-200">
                <p className="text-sm leading-relaxed">Thinking...</p>
                {showActivity && <ActivityPanel steps={liveSteps} live />}
              </article>
            )}
          </div>
        </section>

        <footer className="border-t border-slate-200 bg-white p-4">
          <form
            className="mx-auto flex max-w-3xl items-end gap-3"
            onSubmit={handleSubmit}
          >
            <label htmlFor="message" className="sr-only">
              Type your message
            </label>
            <textarea
              id="message"
              rows={2}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about products… (Enter to send, Shift+Enter for new line)"
              className="min-h-[52px] flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500"
            />
            <button
              type="submit"
              disabled={!input.trim() || isThinking}
              className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              {isThinking ? "..." : "Send"}
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-xs text-slate-500">
            Responses use tool-calling to the Stone REST API and the stone
            knowledge vector store.
          </p>
        </footer>
      </main>
    </div>
  );
}
