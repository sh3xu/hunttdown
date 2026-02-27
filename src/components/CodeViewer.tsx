"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertTriangle, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";

/** One AI-suggested fix anchored to a line range in this file */
export interface AISuggestion {
  title: string;
  functionName?: string;
  severity: "critical" | "high" | "medium" | "low";
  issue: string;
  impact: string;
  fixCode?: string; // diff block content
  line?: number;    // jump-to line
}

interface CodeViewerProps {
  path: string;
  root?: string;
  projectId?: string;
  line?: number;
  /** Suggestions that the AI flagged for this file, keyed by line or fn name */
  suggestions?: AISuggestion[];
}

const SEVERITY_COLORS = {
  critical: { bg: "bg-red-950/60", border: "border-red-700/50", badge: "bg-red-700", text: "text-red-300", icon: "text-red-400" },
  high: { bg: "bg-orange-950/60", border: "border-orange-700/50", badge: "bg-orange-700", text: "text-orange-300", icon: "text-orange-400" },
  medium: { bg: "bg-yellow-950/40", border: "border-yellow-700/50", badge: "bg-yellow-700", text: "text-yellow-300", icon: "text-yellow-400" },
  low: { bg: "bg-zinc-900/60", border: "border-zinc-700/50", badge: "bg-zinc-700", text: "text-zinc-400", icon: "text-zinc-500" },
};

export default function CodeViewer({ path, root, projectId, line, suggestions = [] }: CodeViewerProps) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSuggestions, setExpandedSuggestions] = useState<Set<number>>(new Set());
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    const url = `/api/file?path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ""}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`;
    fetch(url)
      .then((res) => res.json())
      .then((data: { content: string }) => {
        setCode(data.content);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [path, root, projectId]);

  // Scroll to highlighted line after render
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [code, line]);

  const toggleSuggestion = (i: number) => {
    setExpandedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (!code) return null;

  const lines = code.split("\n");

  // Build a set of line numbers that have an AI suggestion
  const suggestedLines = new Set<number>();
  for (const s of suggestions) {
    if (s.line) suggestedLines.add(s.line);
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between bg-zinc-900/70 px-4 py-2 border-b border-zinc-800 shrink-0">
        <span className="text-xs font-mono text-zinc-400 truncate max-w-xs">{path}</span>
        <div className="flex items-center gap-2 shrink-0">
          {line && (
            <span className="text-[10px] px-2 py-0.5 bg-blue-900/50 border border-blue-700/40 text-blue-300 rounded-full font-mono">
              :{line}
            </span>
          )}
          {suggestions.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 bg-amber-900/50 border border-amber-700/40 text-amber-300 rounded-full font-semibold">
              {suggestions.length} AI {suggestions.length === 1 ? "fix" : "fixes"}
            </span>
          )}
        </div>
      </div>

      {/* AI Suggestion Panel (if any) */}
      {suggestions.length > 0 && (
        <div className="border-b border-zinc-800 shrink-0 max-h-56 overflow-y-auto">
          {suggestions.map((s, i) => {
            const colors = SEVERITY_COLORS[s.severity] || SEVERITY_COLORS.low;
            const expanded = expandedSuggestions.has(i);
            return (
              <div key={`sug-${s.title}-${i}`} className={`${colors.bg} border-b ${colors.border} last:border-b-0`}>
                <button
                  type="button"
                  onClick={() => toggleSuggestion(i)}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                >
                  <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${colors.icon}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${colors.badge} text-white`}>
                        {s.severity}
                      </span>
                      {s.functionName && (
                        <code className="text-[11px] font-mono text-zinc-300 bg-zinc-800/60 px-1 rounded">
                          {s.functionName}()
                        </code>
                      )}
                      <span className={`text-xs font-semibold ${colors.text}`}>{s.title}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5 pr-4">{s.issue}</p>
                  </div>
                  {expanded ? (
                    <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-1" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-1" />
                  )}
                </button>
                {expanded && (
                  <div className="px-4 pb-4 space-y-3 animate-in slide-in-from-top-1 duration-150">
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase text-zinc-600 font-bold">Impact</p>
                      <p className="text-xs text-zinc-400">{s.impact}</p>
                    </div>
                    {s.fixCode && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <Lightbulb className="w-3 h-3 text-emerald-400" />
                          <p className="text-[10px] uppercase text-zinc-600 font-bold">Suggested Fix</p>
                        </div>
                        <pre className="bg-zinc-900 rounded-lg p-3 text-xs font-mono overflow-x-auto text-zinc-300 border border-zinc-800 leading-5">
                          {s.fixCode.split("\n").map((fixLine, li) => (
                            <div
                              key={`fix-${li}`}
                              className={
                                fixLine.startsWith("+")
                                  ? "text-emerald-400 bg-emerald-950/30"
                                  : fixLine.startsWith("-")
                                  ? "text-red-400 bg-red-950/30 line-through opacity-60"
                                  : "text-zinc-400"
                              }
                            >
                              {fixLine || " "}
                            </div>
                          ))}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Code panel */}
      <div className="flex-1 overflow-auto">
        <pre className="p-4 text-xs font-mono leading-relaxed text-zinc-300 min-w-0">
          <code>
            {lines.map((l, i) => {
              const lineNo = i + 1;
              const isTarget = lineNo === line;
              const hasSuggestion = suggestedLines.has(lineNo);
              return (
                <div
                  key={`ln-${lineNo}`}
                  ref={isTarget ? highlightRef : undefined}
                  className={`flex gap-4 group ${
                    isTarget
                      ? "bg-blue-500/20 -mx-4 px-4 border-l-2 border-blue-500"
                      : hasSuggestion
                      ? "bg-amber-500/10 -mx-4 px-4 border-l-2 border-amber-600/60"
                      : ""
                  }`}
                >
                  <span className="w-8 text-zinc-700 text-right select-none shrink-0 group-hover:text-zinc-500 transition-colors">
                    {lineNo}
                  </span>
                  {hasSuggestion && (
                    <span className="text-amber-500/70 select-none shrink-0">⚠</span>
                  )}
                  <span className={hasSuggestion ? "ml-0" : ""}>{l || " "}</span>
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
