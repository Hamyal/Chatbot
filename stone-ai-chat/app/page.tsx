"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

const SPLASH_MS = 2000;

type ChatMessage = {
  role: "assistant" | "user";
  content: string;
  time: string;
};

const quickPrompts = [
  "Show black granite for exterior paving",
  "Find low-slippery stone for high traffic",
  "What is the current Vietnam time?",
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

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [showChat, setShowChat] = useState(false);

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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the whole conversation so the agent keeps context and can
        // re-route to the right tool when the topic changes mid-chat.
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({
            role,
            content,
          })),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      const raw = await response.text();
      let payload: {
        data?: { answer?: string };
        message?: string;
        error?: boolean;
      };
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              "The server returned an invalid response. Check that stone-api is running on port 3001 and restart Next.js.",
            time: getClockTime(),
          },
        ]);
        return;
      }

      const assistantText =
        payload?.data?.answer ||
        payload?.message ||
        "I could not generate a response.";

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: assistantText, time: getClockTime() },
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
        },
      ]);
    } finally {
      setIsThinking(false);
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
          showChat
            ? "translate-y-0 opacity-100"
            : "translate-y-4 opacity-0"
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
            Responses are generated using tool-calling to your REST API.
          </p>
        </footer>
      </main>
    </div>
  );
}
