"use client";

import { useEffect, useState, useCallback, useRef } from "react";

import GraphView from "@/components/GraphView";
import CodeViewer from "@/components/CodeViewer";
import type { AISuggestion } from "@/components/CodeViewer";
import {
  Search,
  Activity,
  Files,
  Code2,
  Info,
  Loader2,
  Maximize2,
  X,
  GitBranch,
  Zap,
  UploadCloud,
  Sparkles,
  Trash2,
  AlertTriangle,
  Timer,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import AIAnalyzePanel from "@/components/AIAnalyzePanel";

interface ProgressState {
  pct: number;
  message: string;
}

import { toast } from "react-hot-toast";

export default function Home() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [dependencies, setDependencies] = useState<any>(null);
  const [showCode, setShowCode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(true);
  const [vulnerabilities, setVulnerabilities] = useState<Record<string, { severity: string }>>({});
  const [suggestions, setSuggestions] = useState<Record<string, AISuggestion[]>>({});
  const [countdown, setCountdown] = useState<number | null>(null);
  const [obliterateConfirm, setObliterateConfirm] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const TTL_SECONDS = 10 * 60;

  const wipeProject = useCallback(async (projectId: string, silent = false) => {
    try {
      const res = await fetch(`/api/wipe?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Wipe failed");
      setData(null); setSelectedNode(null); setDependencies(null);
      setCountdown(null); setObliterateConfirm(false);
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (!silent) toast.success("💥 Project obliterated from database");
    } catch (err: any) { toast.error(err.message || "Failed to wipe project"); }
  }, []);

  // When a project finishes loading, auto-expand the AI sidebar
  useEffect(() => {
    if (data?.projectId) {
      setAiPanelCollapsed(false);
    }
  }, [data?.projectId]);

  // Server-side TTL countdown (display only)
  useEffect(() => {
    if (!data?.projectId) return;
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(TTL_SECONDS);
    setObliterateConfirm(false);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          setData(null); setSelectedNode(null); setDependencies(null);
          toast("⏱️ Session expired — server wiped project data.", { icon: "🔥" });
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [data?.projectId]);


  const analyzeProject = useCallback(async (url?: string, pat?: string, zipFile?: File | null) => {
    if (loading) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setProgress({ pct: 2, message: "Connecting..." });
    setData(null); setSelectedNode(null);

    try {
      const formData = new FormData();
      if (url) formData.append("url", url);
      if (pat) formData.append("token", pat);
      if (zipFile) formData.append("file", zipFile);

      const res = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json();
        throw new Error(json.error || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            if (event.type === "progress") setProgress({ pct: event.pct, message: event.message });
            else if (event.type === "done") {
              setData(event.data);
              setProgress({ pct: 100, message: "Analysis complete!" });
              toast.success(`✅ ${event.data.nodes.length} nodes — ${url ? "repo" : "zip"} analyzed`);
            } else if (event.type === "error") throw new Error(event.message);
          } catch (parseErr: any) { if (parseErr.message && parseErr.message !== "Analysis failed") throw parseErr; }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        toast.error(err.message || "Analysis failed");
        setProgress(null);
      }
    } finally {
      setLoading(false);
      setTimeout(() => setProgress(null), 3000);
    }
  }, [loading]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (selectedNode && data?.projectId) {
      fetch(
        `/api/dependencies?id=${encodeURIComponent(selectedNode.id)}&projectId=${data.projectId}`,
      )
        .then((res) => res.json())
        .then((deps) => setDependencies(deps))
        .catch((err) => console.error("Failed to fetch dependencies:", err));
    } else {
      setDependencies(null);
    }
  }, [selectedNode, data?.projectId]);

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-100 overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className="w-80 border-r border-zinc-800 flex flex-col bg-zinc-900/50 backdrop-blur-xl z-20">
        <div className="p-6 border-b border-zinc-800 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20">
            <Activity className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-lg tracking-tight">Hunttdown</h1>
            <p className="text-xs text-zinc-500 font-medium">Core Intelligence Engine</p>
          </div>
          {countdown !== null && (
            <div className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-mono font-bold border ${
              countdown <= 60 ? "bg-red-950/60 border-red-700 text-red-400 animate-pulse"
              : countdown <= 180 ? "bg-orange-950/60 border-orange-700 text-orange-400"
              : "bg-zinc-800 border-zinc-700 text-zinc-400"
            }`} title="Server wipes project data when timer hits 0">
              <Timer className="w-3 h-3" />
              {String(Math.floor(countdown / 60)).padStart(2, "0")}:{String(countdown % 60).padStart(2, "0")}
            </div>
          )}
        </div>

        <div className="flex-1 p-4 space-y-6 overflow-y-auto">
          {/* Repository Input */}
          <section className="space-y-3">
            <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold px-2">
              Repository
            </h3>
            <div className="space-y-2">
              {/* GitHub URL */}
              <div className="relative">
                <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500" />
                <input
                  type="text"
                  placeholder="https://github.com/user/repo"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-7 pr-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={repoUrl}
                  onChange={(e) => { setRepoUrl(e.target.value); if (e.target.value) setFile(null); }}
                  disabled={loading || !!file}
                  onKeyDown={(e) => e.key === "Enter" && !loading && repoUrl && analyzeProject(repoUrl, token, null)}
                />
              </div>
              <input
                type="password"
                placeholder="Personal Access Token (optional)"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={loading || !!file}
              />

              {/* OR divider */}
              <div className="relative flex items-center">
                <div className="flex-grow border-t border-zinc-800" />
                <span className="mx-2 text-[10px] text-zinc-600 font-bold uppercase">or</span>
                <div className="flex-grow border-t border-zinc-800" />
              </div>

              {/* ZIP upload */}
              <label className={`flex flex-col items-center justify-center w-full h-20 border-2 border-dashed rounded-xl cursor-pointer transition-all ${
                file ? "border-blue-500 bg-blue-500/10" : "border-zinc-700 hover:border-zinc-500 bg-zinc-800/40 hover:bg-zinc-800/70"
              } ${loading || repoUrl ? "opacity-40 pointer-events-none" : ""}` }>
                <UploadCloud className={`w-5 h-5 mb-1 ${file ? "text-blue-400" : "text-zinc-500"}`} />
                <p className="text-[11px] text-zinc-400">
                  {file ? <span className="text-blue-400 font-semibold">{file.name}</span> : "Drop or click to upload .zip"}
                </p>
                <input type="file" accept=".zip" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setRepoUrl(""); setToken(""); } }}
                  disabled={loading || repoUrl !== ""}
                />
              </label>
              {file && (
                <button type="button" onClick={() => setFile(null)}
                  className="w-full text-[10px] text-zinc-500 hover:text-red-400 transition-colors">
                  ✕ Clear file
                </button>
              )}

              <button
                type="button"
                onClick={() => analyzeProject(repoUrl, token, file)}
                disabled={loading || (!repoUrl && !file)}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 disabled:cursor-not-allowed"
              >
                {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Analyzing...</> : <><Zap className="w-3.5 h-3.5" />{file ? "Analyze ZIP" : "Analyze Repo"}</>}
              </button>

              {/* Obliterate */}
              {data?.projectId && (
                <div className="pt-1">
                  {!obliterateConfirm ? (
                    <button type="button" onClick={() => setObliterateConfirm(true)}
                      className="w-full py-1.5 border border-red-800/50 hover:border-red-600 hover:bg-red-950/30 text-red-500 hover:text-red-400 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5">
                      <Trash2 className="w-3 h-3" />Obliterate Project
                    </button>
                  ) : (
                    <div className="rounded-lg border border-red-700 bg-red-950/30 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-red-400">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-[10px] font-bold">Permanently delete all project data?</span>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => wipeProject(data.projectId)}
                          className="flex-1 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-[10px] font-bold">Yes, Obliterate</button>
                        <button type="button" onClick={() => setObliterateConfirm(false)}
                          className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] font-bold">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Stats */}
          <section className="space-y-3">
            <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold px-2">
              Project Overview
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
                <Files className="w-4 h-4 text-blue-400 mb-2" />
                <div className="text-xl font-bold">
                  {data?.nodes.filter((n: any) => n.type === "file").length ||
                    0}
                </div>
                <div className="text-[10px] text-zinc-500">Files</div>
              </div>
              <div className="p-3 bg-zinc-800/50 border border-zinc-700/50 rounded-xl">
                <Code2 className="w-4 h-4 text-emerald-400 mb-2" />
                <div className="text-xl font-bold">
                  {data?.nodes.filter((n: any) => n.type === "function")
                    .length || 0}
                </div>
                <div className="text-[10px] text-zinc-500">Functions</div>
              </div>
            </div>
          </section>

          {/* Details */}
          <section className="space-y-3">
            <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold px-2">
              Selection Details
            </h3>
            {selectedNode ? (
              <div className="p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Name</div>
                  <div className="font-mono text-sm text-blue-300 truncate">
                    {selectedNode.name}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Type</div>
                  <div className="inline-flex px-2 py-0.5 rounded-full bg-zinc-700 text-[10px] font-bold uppercase">
                    {selectedNode.type}
                  </div>
                </div>
                {selectedNode.path && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">Path</div>
                    <div className="text-xs text-zinc-400 break-all">
                      {selectedNode.path}
                    </div>
                  </div>
                )}

                {(selectedNode.type === "file" ||
                  selectedNode.type === "function" ||
                  selectedNode.type === "class") && (
                  <button
                    type="button"
                    onClick={() => setShowCode(true)}
                    className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-semibold transition-colors"
                  >
                    <Maximize2 className="w-3 h-3" />
                    View Source Code
                  </button>
                )}

                {/* Database Dependency View */}
                {dependencies && (
                  <div className="mt-4 pt-4 border-t border-zinc-800 space-y-3">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-2">
                      Dependency Analysis
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 bg-zinc-900 rounded-lg text-center">
                        <div className="text-sm font-bold text-blue-400">
                          {dependencies.incoming?.length || 0}
                        </div>
                        <div className="text-[9px] text-zinc-500">Incoming</div>
                      </div>
                      <div className="p-2 bg-zinc-900 rounded-lg text-center">
                        <div className="text-sm font-bold text-emerald-400">
                          {dependencies.outgoing?.length || 0}
                        </div>
                        <div className="text-[9px] text-zinc-500">Outgoing</div>
                      </div>
                    </div>

                    {dependencies.relatedNodes?.length > 0 && (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {dependencies.relatedNodes
                          .slice(0, 10)
                          .map((node: any) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() => {
                                const target = data.nodes.find(
                                  (n: any) => n.id === node.nodeId,
                                );
                                if (target) setSelectedNode(target);
                              }}
                              className="w-full flex items-center justify-between p-1.5 bg-zinc-900/30 hover:bg-zinc-800/50 rounded border border-zinc-800/50 transition-colors text-left"
                            >
                              <span className="text-[10px] text-zinc-300 truncate max-w-[120px]">
                                {node.name}
                              </span>
                              <span className="text-[8px] px-1 bg-zinc-800 text-zinc-500 rounded lowercase">
                                {node.type}
                              </span>
                            </button>
                          ))}
                        {dependencies.relatedNodes.length > 10 && (
                          <div className="text-[9px] text-zinc-600 text-center italic">
                            +{dependencies.relatedNodes.length - 10} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 border-2 border-dashed border-zinc-800 rounded-xl flex flex-col items-center text-center">
                <Info className="w-6 h-6 text-zinc-700 mb-2" />
                <p className="text-xs text-zinc-500">
                  Select a node in the graph to view details
                </p>
              </div>
            )}
          </section>
        </div>

        <div className="p-4 border-t border-zinc-800 bg-zinc-950/50">
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-400">
            <Search className="w-3 h-3" />
            <span>Cmd + K to search</span>
          </div>
        </div>
      </aside>

      {/* Main Graph Area */}
      <main className="flex-1 relative flex flex-col min-w-0">
        {/* Toolbar */}
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/30 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <div className="text-xs font-semibold px-3 py-1 bg-zinc-800 border border-zinc-700 rounded-full text-zinc-400">
              2D Knowledge Graph
            </div>
            {data && (
              <div className="text-xs text-zinc-500">
                {data.nodes.length} nodes · {data.edges?.length || 0} edges
              </div>
            )}
          </div>
          {/* AI sidebar toggle in toolbar */}
          <button
            type="button"
            onClick={() => setAiPanelCollapsed((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
              !aiPanelCollapsed
                ? "bg-violet-600/20 border-violet-500/50 text-violet-300"
                : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }`}
          >
            <Sparkles className="w-3 h-3" />
            AI Audit
          </button>
        </header>

        <div className="flex-1 w-full h-full relative">
          {loading && progress && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
              <div className="w-full max-w-xs px-6 space-y-5">
                <div className="flex justify-center">
                  <div className="relative w-14 h-14">
                    <div className="absolute inset-0 rounded-full border-4 border-blue-500/20" />
                    <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 animate-spin" />
                    <Activity className="absolute inset-0 m-auto w-5 h-5 text-blue-400" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-300">Progress</span>
                    <span className="text-blue-400 font-bold">{progress.pct}%</span>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-500"
                      style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
                <p className="text-center text-xs text-zinc-400 animate-pulse">{progress.message}</p>
              </div>
            </div>
          )}
          {loading && !progress && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            </div>
          )}
          {!loading && data && (
            <GraphView data={data} onNodeClick={setSelectedNode} vulnerabilities={vulnerabilities} />
          )}
          {!loading && !data && (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-8">
              <Activity className="w-12 h-12 text-zinc-700 mb-4" />
              <h2 className="text-lg font-bold text-zinc-400">No project analyzed yet</h2>
              <p className="text-xs text-zinc-600 mt-2 max-w-xs">Enter a GitHub URL or drop a ZIP file in the sidebar, then click Analyze.</p>
            </div>
          )}
        </div>

        {/* Code Overlay */}
        {showCode && selectedNode && (
          <div className="absolute inset-0 z-50 p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="w-full h-full max-w-5xl mx-auto flex flex-col animate-in zoom-in-95 duration-300">
              <div className="flex justify-end mb-4">
                <button
                  type="button"
                  onClick={() => setShowCode(false)}
                  className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-full text-zinc-400 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <CodeViewer
                  path={selectedNode.path}
                  root={data?.rootPath}
                  line={selectedNode.line}
                  suggestions={suggestions[selectedNode.path] || []}
                />
              </div>
            </div>
          </div>
        )}

        {/* Command + K Search Overlay */}
        {searchOpen && (
          <div className="absolute inset-0 z-[60] flex items-start justify-center pt-[15vh] px-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
              <div className="p-4 border-b border-zinc-800 flex items-center gap-3">
                <Search className="w-5 h-5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search files, functions, or classes..."
                  className="bg-transparent border-none outline-none text-zinc-100 text-sm w-full"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {data?.nodes
                  .filter(
                    (n: any) =>
                      n.type !== "folder" &&
                      n.name.toLowerCase().includes(searchQuery.toLowerCase()),
                  )
                  .slice(0, 20)
                  .map((node: any) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => {
                        setSelectedNode(node);
                        setSearchOpen(false);
                        setSearchQuery("");
                      }}
                      className="w-full flex items-center justify-between p-3 hover:bg-zinc-800 rounded-lg transition-colors group text-left"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-zinc-200">
                          {node.name}
                        </span>
                        <span className="text-[10px] text-zinc-500 truncate max-w-sm">
                          {node.path}
                        </span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 bg-zinc-800 group-hover:bg-zinc-700 text-zinc-400 rounded-full lowercase border border-zinc-700">
                        {node.type}
                      </span>
                    </button>
                  ))}
                {(!data ||
                  data.nodes.filter(
                    (n: any) =>
                      n.type !== "folder" &&
                      n.name.toLowerCase().includes(searchQuery.toLowerCase()),
                  ).length === 0) && (
                  <div className="p-8 text-center text-zinc-500 text-xs italic">
                    No results found for "{searchQuery}"
                  </div>
                )}
              </div>
              <div className="p-3 bg-zinc-950/50 border-t border-zinc-800 flex justify-between items-center px-4">
                <div className="flex gap-3">
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-medium">
                    <span className="px-1.5 py-0.5 bg-zinc-800 rounded border border-zinc-700">
                      ↵
                    </span>{" "}
                    Select
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-medium">
                    <span className="px-1.5 py-0.5 bg-zinc-800 rounded border border-zinc-700">
                      ESC
                    </span>{" "}
                    Close
                  </div>
                </div>
                <div className="text-[10px] text-zinc-600">
                  Hunttdown Search Engine
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Persistent AI Audit Sidebar ── */}
      <AIAnalyzePanel
        projectId={data?.projectId ?? null}
        projectName={data?.nodes?.[0]?.path?.split("/")[0] || "Project"}
        isCollapsedDefault={aiPanelCollapsed}
        onCollapsedChange={setAiPanelCollapsed}
        onVulnerabilitiesChange={setVulnerabilities}
        onSuggestionsChange={setSuggestions}
      />
    </div>
  );
}
