"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  X, Sparkles, Key, Loader2, AlertCircle,
  Copy, Check, Settings, ChevronDown, Send,
  Minimize2, RefreshCw,
} from "lucide-react";
import type { AISuggestion } from "./CodeViewer";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  logo: string;
  defaultModel: string;
  models: string[];
  docsUrl: string;
  keyPlaceholder: string;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface Props {
  projectId: string | null;
  projectName?: string;
  isCollapsedDefault: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onVulnerabilitiesChange?: (vulns: Record<string, { severity: string }>) => void;
  onSuggestionsChange?: (suggestions: Record<string, AISuggestion[]>) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const PROVIDERS: Provider[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    logo: "🔷",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-3-flash-preview"],
    docsUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AIza...",
  },
  {
    id: "custom",
    name: "Custom / Other",
    logo: "⚙️",
    defaultModel: "",
    models: [],
    docsUrl: "",
    keyPlaceholder: "Your API key",
  },
];


// ── Component ─────────────────────────────────────────────────────────────────
export default function AIAnalyzePanel({
  projectId,
  projectName,
  isCollapsedDefault,
  onCollapsedChange,
  onVulnerabilitiesChange,
  onSuggestionsChange,
}: Props) {
  // Settings
  const [selectedProvider, setSelectedProvider] = useState<Provider>(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].defaultModel);
  const [customEndpoint, setCustomEndpoint] = useState("https://openai.com/v1/chat/completions");
  const [customModel, setCustomModel] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Panel state – collapse is controlled by parent
  const [isCollapsed, setIsCollapsed] = useState(isCollapsedDefault);
  const [phase, setPhase] = useState<"idle" | "config" | "chatting">("config");

  // Conversation
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingMsg, setStreamingMsg] = useState(""); // current streaming assistant chunk
  const [status, setStatus] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [copied, setCopied] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync collapse state from parent (e.g. toolbar toggle)
  useEffect(() => {
    setIsCollapsed(isCollapsedDefault);
  }, [isCollapsedDefault]);

  // Notify parent when collapse state changes internally
  const handleSetCollapsed = (v: boolean) => {
    setIsCollapsed(v);
    onCollapsedChange(v);
  };

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMsg]);

  // Parse vulnerabilities + suggestions whenever assistant sends a message
  useEffect(() => {
    const fullText = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    if (!fullText) return;

    const vulns: Record<string, { severity: string }> = {};
    const suggestions: Record<string, AISuggestion[]> = {};

    let currentSeverity: "critical" | "high" | "medium" | "low" = "low";
    let currentTitle = "";
    let currentFile = "";
    let currentFn = "";
    let currentIssue = "";
    let currentImpact = "";
    let inDiff = false;
    let diffLines: string[] = [];

    const flush = () => {
      if (!currentFile) return;
      const basePath = currentFile.split(":")[0];
      const lineNo = Number.parseInt(currentFile.split(":")[1] || "0", 10) || undefined;
      const sug: AISuggestion = {
        title: currentTitle,
        severity: currentSeverity,
        functionName: currentFn || undefined,
        issue: currentIssue,
        impact: currentImpact,
        fixCode: diffLines.length ? diffLines.join("\n") : undefined,
        line: lineNo,
      };
      if (!suggestions[basePath]) suggestions[basePath] = [];
      suggestions[basePath].push(sug);
      // Key by bare path so GraphView's vulnerabilities[node.path] lookup works
      if (!vulns[basePath] || currentSeverity === "critical" || (currentSeverity === "high" && vulns[basePath].severity !== "critical")) {
        vulns[basePath] = { severity: currentSeverity };
      }
      currentTitle = ""; currentFile = ""; currentFn = ""; currentIssue = ""; currentImpact = ""; diffLines = [];

    };

    for (const line of fullText.split("\n")) {
      if (line.startsWith("```diff")) { inDiff = true; continue; }
      if (inDiff && line.startsWith("```")) { inDiff = false; continue; }
      if (inDiff) { diffLines.push(line); continue; }

      if (/## (🔴|Critical)/i.test(line)) currentSeverity = "critical";
      else if (/## (🟠|High)/i.test(line)) currentSeverity = "high";
      else if (/## (🟡|Medium)/i.test(line)) currentSeverity = "medium";
      else if (/## (🟢|Low)/i.test(line)) currentSeverity = "low";

      if (line.startsWith("### ")) {
        flush();
        currentTitle = line.replace(/^###\s*/, "").trim();
      }
      const fileM = line.match(/\*\*File\*\*:\s*`?([\w./\-]+(?::[\d]+)?)`?/i);
      if (fileM) currentFile = fileM[1];
      const fnM = line.match(/\*\*Function\*\*:\s*`?([\w.]+)`?/i);
      if (fnM) currentFn = fnM[1];
      const issueM = line.match(/\*\*Issue\*\*:\s*(.+)/i);
      if (issueM) currentIssue = issueM[1];
      const impactM = line.match(/\*\*Impact\*\*:\s*(.+)/i);
      if (impactM) currentImpact = impactM[1];
    }
    flush();

    onVulnerabilitiesChange?.(vulns);
    onSuggestionsChange?.(suggestions);
  }, [messages, onVulnerabilitiesChange, onSuggestionsChange]);

  // ── Streaming helper ──────────────────────────────────────────────────────
  const streamFromAPI = useCallback(async (conversationMessages: Message[]) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    setError("");

    try {
      const res = await fetch("/api/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          provider: selectedProvider.id,
          apiKey: apiKey.trim(),
          model: selectedProvider.id === "custom" ? customModel : model,
          customEndpoint: selectedProvider.id === "custom" ? customEndpoint : undefined,
          messages: conversationMessages, // pass conversation for multi-turn
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json();
        throw new Error(json.error || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "status") {
              setStatus(event.message);
            } else if (event.type === "chunk") {
              accumulated += event.text;
              setStreamingMsg(accumulated);
            } else if (event.type === "done") {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: accumulated },
              ]);
              setStreamingMsg("");
              setStatus("Done");
              setPhase("chatting");
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch (e: any) {
            if (e.message && !e.message.includes("JSON")) throw e;
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Analysis failed");
        setStreamingMsg("");
      }
    } finally {
      setIsStreaming(false);
    }
  }, [projectId, selectedProvider, apiKey, model, customModel, customEndpoint]);

  // ── Start the initial audit ───────────────────────────────────────────────
  const startAudit = useCallback(async () => {
    if (!projectId || !apiKey.trim()) return;
    setMessages([]);
    setStreamingMsg("");
    setStatus("Preparing...");
    setShowSettings(false);
    // The system/user context is built server-side for the audit
    await streamFromAPI([]);
  }, [projectId, apiKey, streamFromAPI]);

  // ── Follow-up chat ────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || isStreaming) return;
    setChatInput("");
    const newMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    await streamFromAPI(newMessages);
  }, [chatInput, isStreaming, messages, streamFromAPI]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  };

  const copyAll = () => {
    const text = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n\n---\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const resetConversation = () => {
    abortRef.current?.abort();
    setMessages([]);
    setStreamingMsg("");
    setStatus("");
    setError("");
    setPhase("config");
    onVulnerabilitiesChange?.({});
  };

  // ── Collapsed strip ───────────────────────────────────────────────────────
  if (isCollapsed) {
    return (
      <div className="w-12 border-l border-zinc-800 flex flex-col items-center bg-zinc-950/95 shadow-2xl shrink-0">
        <button
          type="button"
          onClick={() => handleSetCollapsed(false)}
          className="mt-4 w-9 h-9 flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-blue-600 text-white shadow-lg hover:scale-105 transition-transform"
          title="Expand AI panel"
        >
          <Sparkles className="w-4 h-4" />
        </button>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-[10px] text-zinc-600 font-bold uppercase tracking-widest"
            style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}>
            AI Audit
          </span>
        </div>
        {phase === "chatting" && (
          <div className="mb-3 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" title="Conversation active" />
        )}
      </div>
    );
  }

  return (
    <div className="w-[460px] border-l border-zinc-800 bg-zinc-950/97 backdrop-blur-xl flex flex-col shadow-2xl shrink-0 transition-all duration-300">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 p-4 border-b border-zinc-800 shrink-0">
        <div className="w-8 h-8 bg-gradient-to-br from-violet-600 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shrink-0">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-sm text-white">AI Code Audit</h2>
          <p className="text-[10px] text-zinc-500 truncate">{projectName || "Project"}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Settings */}
          <button type="button" onClick={() => setShowSettings((v) => !v)}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${showSettings ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-white hover:bg-zinc-800"}`}
            title="Settings">
            <Settings className="w-4 h-4" />
          </button>
          {/* Reset */}
          {phase === "chatting" && (
            <button type="button" onClick={resetConversation}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
              title="New audit">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Copy */}
          {messages.some((m) => m.role === "assistant") && (
            <button type="button" onClick={copyAll}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Copy all">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
          {/* Collapse */}
          <button type="button" onClick={() => handleSetCollapsed(true)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Collapse">
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Settings drawer (slides in below header) ── */}
      {showSettings && (
        <div className="border-b border-zinc-800 bg-zinc-900/80 p-4 space-y-4 shrink-0 animate-in slide-in-from-top duration-200">
          <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Provider & Model</p>

          {/* Provider pills */}
          <div className="flex gap-2">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button"
                onClick={() => { setSelectedProvider(p); setModel(p.defaultModel); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${selectedProvider.id === p.id
                  ? "bg-blue-600/20 border-blue-500 text-white"
                  : "bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  }`}>
                <span>{p.logo}</span>{p.name}
              </button>
            ))}
          </div>

          {/* API Key */}
          <div className="relative">
            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input type="password" placeholder={selectedProvider.keyPlaceholder}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>

          {/* Model */}
          {selectedProvider.id === "custom" ? (
            <div className="space-y-2">
              <input type="text" placeholder="API endpoint URL"
                value={customEndpoint} onChange={(e) => setCustomEndpoint(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <input type="text" placeholder="Model name"
                value={customModel} onChange={(e) => setCustomModel(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          ) : (
            <div className="relative">
              <button type="button" onClick={() => setShowModelDropdown((v) => !v)}
                className="w-full flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600">
                <span>{model}</span>
                <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${showModelDropdown ? "rotate-180" : ""}`} />
              </button>
              {showModelDropdown && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-zinc-800 border border-zinc-700 rounded-xl overflow-hidden z-10 shadow-xl">
                  {selectedProvider.models.map((m) => (
                    <button key={m} type="button"
                      onClick={() => { setModel(m); setShowModelDropdown(false); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${m === model ? "bg-blue-600/30 text-blue-300" : "text-zinc-300 hover:bg-zinc-700"}`}>
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Confirm settings / Start / Re-run */}
          <button type="button" onClick={() => { setShowSettings(false); startAudit(); }}
            disabled={!projectId || !apiKey.trim()}
            className="w-full py-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2">
            <Sparkles className="w-3.5 h-3.5" />
            {phase === "chatting" ? "Re-run Audit with New Settings" : "Start Audit"}
          </button>
          <p className="text-[10px] text-zinc-600 text-center">🔒 Key sent directly to {selectedProvider.name} — not stored</p>
        </div>
      )}

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-h-0">

        {/* ── Config / empty state ── */}
        {phase === "config" && !isStreaming && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
            {!projectId && (
              <div className="flex items-start gap-3 p-3 bg-amber-950/40 border border-amber-700/50 rounded-xl w-full">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-300">Analyze a project first before running AI audit.</p>
              </div>
            )}
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-gradient-to-br from-violet-900/40 to-blue-900/40 border border-violet-800/40 rounded-2xl flex items-center justify-center mx-auto">
                <Sparkles className="w-8 h-8 text-violet-400" />
              </div>
              <h3 className="font-bold text-zinc-200">AI Security Audit</h3>
              <p className="text-xs text-zinc-500 max-w-xs">Configure your provider in <span className="text-zinc-300">Settings ⚙️</span> then start the audit.</p>
            </div>
            <div className="w-full p-4 bg-zinc-900/60 rounded-xl border border-zinc-800 space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-zinc-600 font-bold">Scans for</p>
              {[
                ["🔴", "Memory leaks & resource issues"],
                ["🔐", "Security vulnerabilities (OWASP)"],
                ["🔁", "Logic bugs & race conditions"],
                ["🗑️", "Dead code & unused exports"],
                ["⚡", "Performance bottlenecks"],
              ].map(([icon, label]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-sm">{icon}</span>
                  <span className="text-xs text-zinc-400">{label}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setShowSettings(true)}
              className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2">
              <Settings className="w-4 h-4" />Configure & Start
            </button>
          </div>
        )}

        {/* ── Status bar (during streaming) ── */}
        {(isStreaming || status) && !messages.length && !streamingMsg && (
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
            {isStreaming
              ? <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />
              : <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
            <span className="text-xs text-zinc-400 truncate">{status}</span>
          </div>
        )}

        {/* ── Messages ── */}
        {(messages.length > 0 || streamingMsg) && (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
            {/* Status pill at top when actively streaming more */}
            {isStreaming && status && messages.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-zinc-500 px-1">
                <Loader2 className="w-3 h-3 animate-spin" />{status}
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={msg.role === "user" ? "flex justify-end" : "space-y-0"}>
                {msg.role === "user" ? (
                  <div className="max-w-[85%] bg-blue-600/20 border border-blue-500/30 rounded-2xl rounded-tr-sm px-4 py-2.5">
                    <p className="text-xs text-blue-100 whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <div className="w-5 h-5 bg-gradient-to-br from-violet-600 to-blue-600 rounded-full flex items-center justify-center shrink-0">
                        <Sparkles className="w-2.5 h-2.5 text-white" />
                      </div>
                      <span className="text-[10px] text-zinc-500 font-semibold">AI Audit</span>
                    </div>
                    <MarkdownReport text={msg.content} />
                  </div>
                )}
              </div>
            ))}

            {/* Streaming in progress */}
            {streamingMsg && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="w-5 h-5 bg-gradient-to-br from-violet-600 to-blue-600 rounded-full flex items-center justify-center shrink-0">
                    <Sparkles className="w-2.5 h-2.5 text-white" />
                  </div>
                  <span className="text-[10px] text-zinc-500 font-semibold">AI Audit</span>
                  <div className="flex gap-0.5 ml-1">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="w-1 h-1 rounded-full bg-violet-400 animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }} />
                    ))}
                  </div>
                </div>
                <MarkdownReport text={streamingMsg} />
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 p-3 bg-red-950/40 border border-red-700/50 rounded-xl">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-red-400 font-bold mb-1">Failed</p>
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}

        {/* ── Chat input (shown once audit has run at least once) ── */}
        {phase === "chatting" && (
          <div className="border-t border-zinc-800 p-3 shrink-0 bg-zinc-950/80">
            <div className="flex items-end gap-2">
              <div className="flex-1 relative">
                <textarea
                  ref={textareaRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask a follow-up question…"
                  disabled={isStreaming}
                  rows={1}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 pr-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none leading-5 max-h-36 overflow-y-auto disabled:opacity-50"
                  style={{ fieldSizing: "content" } as React.CSSProperties}
                />
              </div>
              <button
                type="button"
                onClick={sendChat}
                disabled={isStreaming || !chatInput.trim()}
                className="w-9 h-9 flex items-center justify-center bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-white transition-colors shrink-0"
              >
                {isStreaming
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Send className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] text-zinc-700 mt-1.5 px-1">↵ Send  ·  Shift+↵ New line  ·  Full conversation context included</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function MarkdownReport({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1 font-sans text-[12.5px] leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith("## 🔴")) return <h2 key={i} className="text-red-400 font-bold text-sm mt-5 mb-2 border-b border-red-900/30 pb-1.5">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("## 🟠")) return <h2 key={i} className="text-orange-400 font-bold text-sm mt-5 mb-2 border-b border-orange-900/30 pb-1.5">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("## 🟡")) return <h2 key={i} className="text-yellow-400 font-bold text-sm mt-5 mb-2 border-b border-yellow-900/30 pb-1.5">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("## 🟢")) return <h2 key={i} className="text-emerald-400 font-bold text-sm mt-5 mb-2 border-b border-emerald-900/30 pb-1.5">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("## 📊")) return <h2 key={i} className="text-blue-400 font-bold text-sm mt-5 mb-2 border-b border-blue-900/30 pb-1.5">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("## ")) return <h2 key={i} className="text-zinc-200 font-bold text-sm mt-4 mb-2">{line.replace(/^##\s*/, "")}</h2>;
        if (line.startsWith("### ")) return <h3 key={i} className="text-zinc-300 font-semibold mt-3 mb-1">{line.replace(/^###\s*/, "")}</h3>;
        if (line.startsWith("```")) return <div key={i} className="font-mono text-[11px] text-zinc-400 bg-zinc-900/80 px-2 py-1 rounded border border-zinc-800 my-1">{line.replace(/```/g, "")}</div>;

        if (line.startsWith("- **")) {
          const match = line.match(/^- \*\*(.+?)\*\*:?\s*(.*)/);
          if (match) return (
            <div key={i} className="flex gap-2.5 ml-1 mt-2">
              <span className="text-zinc-600 shrink-0 mt-0.5">•</span>
              <span className="text-zinc-300">
                <span className="text-blue-300/90 font-semibold bg-blue-950/30 px-1 py-0.5 rounded text-[11px] mr-1">{match[1]}</span>
                {match[2] && <span className="text-zinc-400">{match[2].replace(/`/g, "")}</span>}
              </span>
            </div>
          );
        }

        if (line.match(/^\d+\.\s/)) return (
          <div key={i} className="flex gap-2 ml-1 mt-2 text-zinc-300">
            <span className="text-zinc-500 font-semibold shrink-0">{line.match(/^\d+\./)?.[0]}</span>
            <span>{line.replace(/^\d+\.\s/, "").replace(/\*\*/g, "")}</span>
          </div>
        );

        if (line.startsWith("- ")) return (
          <div key={i} className="flex gap-2.5 ml-3 mt-1 text-zinc-400">
            <span className="text-zinc-600 shrink-0">•</span>
            <span>{line.slice(2).replace(/\*\*/g, "").replace(/`/g, "")}</span>
          </div>
        );

        if (line.trim() === "") return <div key={i} className="h-2" />;
        if (line.startsWith("**") && line.endsWith("**")) return <p key={i} className="text-zinc-200 font-semibold mt-2">{line.replace(/\*\*/g, "")}</p>;
        return <p key={i} className="text-zinc-400 mt-1">{line.replace(/\*\*/g, "").replace(/`/g, "")}</p>;
      })}
    </div>
  );
}
