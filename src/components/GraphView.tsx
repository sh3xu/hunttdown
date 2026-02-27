"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import type { ProjectGraph } from "@/lib/analyzer/types";
import { ZoomIn, ZoomOut, Maximize2, LocateFixed } from "lucide-react";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface GraphNode {
  id: string;
  name: string;
  type: string;
  path?: string;
  color: string;
  val: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  relation: string;
  call_count?: number;
}

interface GraphViewProps {
  data: ProjectGraph | null;
  onNodeClick?: (node: GraphNode) => void;
  vulnerabilities?: Record<string, { severity: string }>;
}

const NODE_COLORS: Record<string, string> = {
  file: "#3b82f6",
  folder: "#eab308",
  function: "#10b981",
  class: "#a855f7",
  component: "#ec4899",
};
const NODE_SIZES: Record<string, number> = {
  file: 4,
  folder: 7,
  function: 2.5,
  class: 4,
  component: 3.5,
};
const LINK_COLORS: Record<string, string> = {
  imports: "rgba(59,130,246,0.4)",
  calls: "rgba(16,185,129,0.5)",
  contains: "rgba(255,255,255,0.06)",
  extends: "rgba(168,85,247,0.5)",
};

export default function GraphView({
  data,
  onNodeClick,
  vulnerabilities = {},
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const hoverLabelRef = useRef<HTMLDivElement>(null); // Direct DOM — no state update
  const highlightNodesRef = useRef(new Set<string>());
  const highlightLinksRef = useRef(new Set<any>());

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [filterType, setFilterType] = useState("all");
  // graphData is the single React-state-controlled source of truth
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });

  // ─── Build graph data from prop ───────────────────────────────────────────
  useEffect(() => {
    if (!data) return;
    const nodes: GraphNode[] = data.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      path: n.path,
      color: NODE_COLORS[n.type] || "#94a3b8",
      val: NODE_SIZES[n.type] || 2,
    }));
    const links: GraphLink[] = data.edges.map((e: any) => ({
      source: e.from,
      target: e.to,
      relation: e.relation,
      call_count: e.callCount || e.call_count || 1,
    }));
    setGraphData({ nodes, links });
    // Remove any frozen positions from a previous analysis
    highlightNodesRef.current.clear();
    highlightLinksRef.current.clear();
    setTimeout(() => fgRef.current?.zoomToFit(600, 60), 800);
  }, [data]);

  // ─── Freeze nodes after simulation cools — prevents ANY future movement ──
  const handleEngineStop = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // Pin every node in place via fx/fy
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => ({ ...n, fx: n.x, fy: n.y })),
    }));
  }, []);

  // ─── Filtered graph — memoized so reference only changes on actual filter change ──
  const displayData = useMemo(() => {
    if (filterType === "all") return graphData;
    const ids = new Set(
      graphData.nodes.filter((n) => n.type === filterType).map((n) => n.id),
    );
    return {
      nodes: graphData.nodes.filter((n) => ids.has(n.id)),
      links: graphData.links.filter((l) => {
        const s =
          typeof l.source === "string" ? l.source : (l.source as any).id;
        const t =
          typeof l.target === "string" ? l.target : (l.target as any).id;
        return ids.has(s) && ids.has(t);
      }),
    };
  }, [graphData, filterType]);

  // ─── Hover: update refs + repaint. NO setState → no re-render ────────────
  const handleNodeHover = useCallback(
    (node: any) => {
      highlightNodesRef.current.clear();
      highlightLinksRef.current.clear();

      if (node) {
        highlightNodesRef.current.add(node.id);
        // After the simulation runs, ForceGraph2D mutates link.source/target from string → object in-place
        displayData.links.forEach((link: any) => {
          const s = link.source?.id ?? link.source;
          const t = link.target?.id ?? link.target;
          if (s === node.id || t === node.id) {
            highlightLinksRef.current.add(link);
            highlightNodesRef.current.add(s);
            highlightNodesRef.current.add(t);
          }
        });
      }

      // Update hover label via direct DOM reference — zero React re-render
      if (hoverLabelRef.current) {
        hoverLabelRef.current.textContent = node ? node.name : "";
        hoverLabelRef.current.style.display = node ? "block" : "none";
      }

      fgRef.current?.refresh?.();
    },
    [displayData.links],
  );

  // ─── Node painter ─────────────────────────────────────────────────────────
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const hn = highlightNodesRef.current;
      const isHighlighted = hn.size === 0 || hn.has(node.id);
      const radius = node.val;

      ctx.globalAlpha = isHighlighted ? 1 : 0.07;

      if (isHighlighted && hn.size > 0) {
        ctx.shadowColor = node.color;
        ctx.shadowBlur = 14 / globalScale;
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (hn.has(node.id) && hn.size > 0) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 2.5 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      if (globalScale > 1.2 && isHighlighted) {
        const fontSize = Math.max(8, 11 / globalScale);
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        const labelText =
          node.name.length > 22 ? `${node.name.slice(0, 20)}…` : node.name;
        ctx.fillText(labelText, node.x, node.y + radius + 2);
      }

      // Vulnerability badge — fuzzy path match (AI may return shorter paths than node.path)
      const vuln = node.path
        ? (vulnerabilities[node.path] ??
           Object.entries(vulnerabilities).find(
             ([k]) => node.path.endsWith(`/${k}`) || node.path.endsWith(k) || k.endsWith(`/${node.path}`) || k.endsWith(node.path)
           )?.[1] ??
           null)
        : null;

      if (vuln) {
        ctx.font = `${Math.max(10, 14 / globalScale)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const badgeColor =
          vuln.severity === "critical"
            ? "#ef4444"
            : vuln.severity === "high"
              ? "#f97316"
              : vuln.severity === "medium"
                ? "#eab308"
                : "#10b981";

        // Draw badge background
        ctx.beginPath();
        ctx.arc(
          node.x + radius + 2 / globalScale,
          node.y - radius - 2 / globalScale,
          Math.max(4, 6 / globalScale),
          0,
          2 * Math.PI,
        );
        ctx.fillStyle = badgeColor;
        ctx.fill();

        // Add small icon inside badge
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.max(6, 8 / globalScale)}px sans-serif`;
        ctx.fillText(
          "!",
          node.x + radius + 2 / globalScale,
          node.y - radius - 2 / globalScale,
        );
      }

      ctx.globalAlpha = 1;
    },
    [vulnerabilities],
  );

  // ─── Resize observer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ─── Stable link color / width getters (no inline arrow fns in JSX) ───────
  const getLinkColor = useCallback((link: any) => {
    const hl = highlightLinksRef.current;
    if (hl.size === 0)
      return LINK_COLORS[link.relation] || "rgba(255,255,255,0.08)";
    return hl.has(link)
      ? LINK_COLORS[link.relation] || "rgba(255,255,255,0.3)"
      : "rgba(255,255,255,0.015)";
  }, []);

  const getLinkWidth = useCallback((link: any) => {
    const hl = highlightLinksRef.current;
    return hl.size > 0 && hl.has(link) ? 2.5 : 1;
  }, []);

  const getLinkCurvature = useCallback(
    (link: any) => (link.relation === "contains" ? 0 : 0.15),
    [],
  );

  const getNodeCanvasMode = useCallback(() => "replace" as const, []);
  const getNodeLabel = useCallback(
    (node: any) => `${node.name} (${node.type})`,
    [],
  );

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-zinc-950 relative"
      style={{ cursor: "grab" }}
    >
      {/* Stats bar */}
      <div className="absolute top-4 left-4 z-10 flex gap-2 flex-wrap pointer-events-none">
        <div className="px-3 py-1 bg-zinc-900/90 backdrop-blur-md rounded-full border border-zinc-800 text-[10px] text-zinc-400 font-medium">
          {displayData.nodes.length} Nodes
        </div>
        <div className="px-3 py-1 bg-zinc-900/90 backdrop-blur-md rounded-full border border-zinc-800 text-[10px] text-zinc-400 font-medium">
          {displayData.links.length} Edges
        </div>
        {/* Direct DOM element — updated without React state */}
        <div
          ref={hoverLabelRef}
          style={{ display: "none" }}
          className="px-3 py-1 bg-blue-900/80 backdrop-blur-md rounded-full border border-blue-700 text-[10px] text-blue-200 font-medium"
        />
      </div>

      {/* Type filter pills */}
      <div className="absolute top-4 right-4 z-10 flex gap-1.5">
        {["all", "file", "function", "class", "folder"].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setFilterType(t)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold capitalize border transition-all ${
              filterType === t
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-zinc-900/80 border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-6 right-4 z-10 flex flex-col gap-1.5">
        {[
          {
            icon: ZoomIn,
            title: "Zoom in",
            action: () => fgRef.current?.zoom(fgRef.current.zoom() * 1.4, 300),
          },
          {
            icon: ZoomOut,
            title: "Zoom out",
            action: () => fgRef.current?.zoom(fgRef.current.zoom() * 0.7, 300),
          },
          {
            icon: Maximize2,
            title: "Fit to screen",
            action: () => fgRef.current?.zoomToFit(400, 60),
          },
          {
            icon: LocateFixed,
            title: "Center",
            action: () => fgRef.current?.centerAt(0, 0, 400),
          },
        ].map(({ icon: Icon, title, action }) => (
          <button
            key={title}
            type="button"
            title={title}
            onClick={action}
            className="w-8 h-8 flex items-center justify-center bg-zinc-900/90 border border-zinc-700 rounded-lg text-zinc-400 hover:text-white hover:border-zinc-500 transition-all"
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="absolute bottom-6 left-4 z-10 bg-zinc-900/80 backdrop-blur-md rounded-xl border border-zinc-800 p-3 space-y-1.5">
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: color }}
            />
            <span className="text-[10px] text-zinc-400 capitalize">{type}</span>
          </div>
        ))}
        <div className="border-t border-zinc-800 pt-1.5 mt-1.5 space-y-1">
          {Object.entries(LINK_COLORS)
            .filter(([k]) => k !== "contains")
            .map(([rel, color]) => (
              <div key={rel} className="flex items-center gap-2">
                <div
                  className="w-4 h-px"
                  style={{ background: color.replace(/,[\d.]+\)/, ",1)") }}
                />
                <span className="text-[10px] text-zinc-500 capitalize">
                  {rel}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="px-3 py-1 bg-zinc-900/70 rounded-full border border-zinc-800 text-[10px] text-zinc-600">
          Scroll to zoom · Drag to pan · Click node to inspect
        </div>
      </div>

      <ForceGraph2D
        ref={fgRef}
        graphData={displayData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="#09090b"
        nodeLabel={getNodeLabel}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={getNodeCanvasMode}
        onNodeHover={handleNodeHover}
        onEngineStop={handleEngineStop}
        linkColor={getLinkColor}
        linkWidth={getLinkWidth}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={getLinkCurvature}
        onNodeClick={(node: any) => {
          onNodeClick?.(node);
          fgRef.current?.centerAt(node.x, node.y, 400);
          fgRef.current?.zoom(3, 400);
        }}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        enableNodeDrag={true}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.4}
        warmupTicks={150}
        cooldownTicks={80}
        minZoom={0.05}
        maxZoom={20}
      />
    </div>
  );
}
