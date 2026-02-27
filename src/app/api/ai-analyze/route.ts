import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { generateEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function encode(obj: object): Uint8Array {
  return new TextEncoder().encode("data: " + JSON.stringify(obj) + "\n\n");
}

/** Audit queries — each targets a specific vulnerability category */
const AUDIT_QUERIES = [
  "memory leak unclosed resource event listener not removed infinite loop",
  "security vulnerability sql injection xss csrf exposed secret api key hardcoded password",
  "authentication authorization missing check privilege escalation",
  "error handling silent failure unhandled exception promise rejection",
  "unused function dead code unreachable branch orphaned file never imported",
  "performance n+1 query synchronous blocking expensive computation",
  "race condition async await missing await undefined null dereference",
];

export async function POST(request: Request) {
  const { projectId, provider, apiKey, model, customEndpoint, messages: incomingMessages = [] } =
    await request.json();

  if (!projectId || !provider || !apiKey) {
    return NextResponse.json(
      { error: "projectId, provider and apiKey are required" },
      { status: 400 },
    );
  }

  // If the client passes a populated conversation (follow-up chat),
  // skip vector DB build — just route straight to the AI with full history.
  const isFollowUp = Array.isArray(incomingMessages) && incomingMessages.length > 1;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        try {
          controller.enqueue(encode(obj));
        } catch {}
      };

      try {
        // ── Step 1: Fetch project metadata & call graph (lightweight) ─────────
        send({
          type: "status",
          message: "Loading project metadata from Supabase...",
        });

        const { data: project } = await supabase
          .from("projects")
          .select("name, url")
          .eq("id", projectId)
          .single();

        const { data: callEdges } = await supabase
          .from("edges")
          .select("from_node, to_node, call_count")
          .eq("project_id", projectId)
          .eq("relation", "calls")
          .limit(300);

        const { data: importEdges } = await supabase
          .from("edges")
          .select("from_node, to_node")
          .eq("project_id", projectId)
          .eq("relation", "imports")
          .limit(300);

        // ── Step 2: Vector search for each audit category ────────────────────
        send({
          type: "status",
          message: "Running semantic search across vector DB...",
        });

        const embedResults = await generateEmbeddings(
          AUDIT_QUERIES.map((q, i) => ({ id: `q${i}`, text: q })),
        );

        const seenNodeIds = new Set<string>();
        const relevantNodes: any[] = [];

        for (const { embedding } of embedResults) {
          // Try pgvector similarity search first
          const { data: hits, error } = await supabase.rpc("match_nodes", {
            query_embedding: embedding,
            project_id_filter: projectId,
            match_count: 8,
          });

          if (!error && hits) {
            for (const hit of hits) {
              if (!seenNodeIds.has(hit.node_id)) {
                seenNodeIds.add(hit.node_id);
                relevantNodes.push(hit);
              }
            }
          }
        }

        // ── Step 3: Fallback — if pgvector not set up, grab files directly ────
        let codeContext: string;
        if (relevantNodes.length === 0) {
          send({
            type: "status",
            message:
              "Vector search unavailable — fetching top files from DB...",
          });

          const { data: fallbackNodes } = await supabase
            .from("nodes")
            .select("node_id, name, type, path, line, content, signature")
            .eq("project_id", projectId)
            .in("type", ["file", "function", "class"])
            .not("content", "is", null)
            .limit(80)
            .order("type");

          codeContext = buildCodeContext(fallbackNodes || []);
          send({
            type: "status",
            message: `Using ${fallbackNodes?.length || 0} nodes (no vector index)`,
          });
        } else {
          // Enrich with full content for the matched nodes
          const { data: enriched } = await supabase
            .from("nodes")
            .select(
              "node_id, name, type, path, line, content, signature, doc_comment",
            )
            .eq("project_id", projectId)
            .in(
              "node_id",
              relevantNodes.map((n) => n.node_id),
            );

          const enrichedMap = new Map(
            (enriched || []).map((n: any) => [n.node_id, n]),
          );

          // Merge similarity score into enriched
          const merged = relevantNodes
            .map((hit) => ({
              ...enrichedMap.get(hit.node_id),
              similarity: hit.similarity,
            }))
            .filter((n) => n.content);

          codeContext = buildCodeContext(merged, true);
          send({
            type: "status",
            message: `Found ${merged.length} relevant code sections via semantic search`,
          });
        }

        // ── Step 4: Build the AI prompt ───────────────────────────────────────
        const callGraph = buildCallGraph(callEdges || []);
        const importGraph = buildImportGraph(importEdges || []);

        const systemPrompt = [
          "You are a principal application security engineer performing a deep static audit.",
          "",
          "STRICT RULES:",
          "1. Do NOT report CSS, styling, UI layout, or visual/UX issues.",
          "2. Do NOT report missing comments, documentation, or naming style.",
          "3. Every finding MUST target a specific function or class, never a whole file.",
          "4. Every finding MUST include a concrete, compilable code fix in a diff block.",
          "",
          "OUTPUT FORMAT (exact):",
          "## Critical Issues",
          "## High Issues",
          "## Medium Issues",
          "## Low / Dead Code",
          "",
          "For each issue use this template:",
          "### <Issue Title>",
          "- **File**: `relative/path/to/file.ts:LINE`",
          "- **Function**: `functionName`",
          "- **Issue**: one sentence — what is wrong",
          "- **Impact**: what attack or failure this enables",
          "- **Fix**:",
          "```diff",
          "- // vulnerable code",
          "+ // corrected replacement",
          "```",
          "",
          "## Summary",
          "- Total critical: N, high: N, medium: N, low: N",
          "- Top risk area: <area>",
        ].join("\n");

        const projectLabel = project?.name || projectId;
        const repoLine = project?.url ? `Repository: ${project.url}` : "";
        const auditTargets = [
          "AUDIT TARGETS:",
          "1. Memory leaks - unclosed streams/connections, listeners not removed, unbounded caches",
          "2. Security - injection (SQL/cmd/path), exposed secrets, missing auth/authz, unsafe deserialization, IDOR, open redirect, prototype pollution",
          "3. Logic bugs - race conditions, TOCTOU, missing await, off-by-one, null/undefined deref in hot paths",
          "4. Dead code - exported symbols never imported, unreachable branches, functions with 0 callers in the call graph",
          "5. Cryptographic issues - weak algorithms, predictable seeds, IV reuse, timing attacks",
        ].join("\n");

        const userPrompt = [
          `Security Audit: ${projectLabel}`,
          repoLine,
          "",
          "Call Graph (high call_count = high attack surface)",
          callGraph,
          "",
          "Import Graph (dependency chains)",
          importGraph,
          "",
          "Relevant Code (retrieved by semantic similarity)",
          codeContext,
          "",
          "---",
          auditTargets,
        ].join("\n");

        let finalMessages: Array<{ role: string; content: string }>;

        if (isFollowUp) {

          send({ type: "status", message: "Sending to AI..." });
          const { data: followUpProject } = await supabase.from("projects").select("name").eq("id", projectId).single();
          const followUpSystem = `You are a senior software security engineer reviewing the project: ${followUpProject?.name || projectId}. You already performed a full audit. Answer the user's follow-up question concisely and precisely, referencing specific files and code when possible.`;
          finalMessages = [
            { role: "system", content: followUpSystem },
            ...incomingMessages.filter((m: { role: string }) => m.role !== "system"),
          ];
        } else {
          // ── Full audit: vector search + context build ──────────────────────
          finalMessages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ];
        } // end if isFollowUp


        const { apiUrl, headers, body } = buildProviderRequest(
          provider,
          apiKey,
          model,
          customEndpoint,
          finalMessages,
        );

        const aiRes = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!aiRes.ok) {
          const err = await aiRes.text();
          throw new Error(
            `${provider} API error (${aiRes.status}): ${err.slice(0, 400)}`,
          );
        }

        send({ type: "status", message: "Receiving AI analysis..." });

        const streamParser =
          provider === "anthropic"
            ? anthropicStream(aiRes)
            : provider === "gemini"
              ? geminiStream(aiRes)
              : openAIStream(aiRes);

        for await (const chunk of streamParser) {
          send({ type: "chunk", text: chunk });
        }

        send({ type: "done" });
      } catch (err: any) {
        send({ type: "error", message: err.message });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCodeContext(nodes: any[], showSimilarity = false): string {
  const chunks: string[] = [];
  let totalChars = 0;
  const CHAR_LIMIT = 70_000;

  for (const node of nodes) {
    if (!node?.content || totalChars >= CHAR_LIMIT) break;
    const simTag =
      showSimilarity && node.similarity != null
        ? ` [relevance: ${(node.similarity * 100).toFixed(0)}%]`
        : "";
    const sig = node.signature ? `\n// ${node.signature}` : "";
    const doc = node.doc_comment ? `\n/** ${node.doc_comment} */` : "";
    const snippet = `### ${node.type?.toUpperCase()}: ${node.path}:${node.line || 0}${simTag}${doc}${sig}\n\`\`\`typescript\n${node.content.slice(0, 2500)}\n\`\`\`\n`;
    chunks.push(snippet);
    totalChars += snippet.length;
  }

  return chunks.join("\n") || "_No code content available._";
}

function buildCallGraph(edges: any[]): string {
  if (!edges.length) return "_No call graph data._";
  const lines = edges.slice(0, 200).map((e) => {
    const from =
      e.from_node?.split(":fn:")[1] ||
      e.from_node?.split(":").pop() ||
      e.from_node;
    const to =
      e.to_node?.split(":fn:")[1] || e.to_node?.split(":").pop() || e.to_node;
    return `  ${from} → ${to}${e.call_count > 1 ? ` (×${e.call_count})` : ""}`;
  });
  return "```\n" + lines.join("\n") + "\n```";
}

function buildImportGraph(edges: any[]): string {
  if (!edges.length) return "_No import data._";
  const lines = edges.slice(0, 100).map((e) => {
    const from = e.from_node?.split("file:")[1] || e.from_node;
    const to = e.to_node?.split("file:")[1] || e.to_node;
    return `  ${from} → ${to}`;
  });
  return "```\n" + lines.join("\n") + "\n```";
}

function buildProviderRequest(
  provider: string,
  apiKey: string,
  model: string,
  customEndpoint: string | undefined,
  messages: any[],
): { apiUrl: string; headers: Record<string, string>; body: any } {
  const effectiveModel = model || "gpt-4o";

  if (provider === "anthropic") {
    return {
      apiUrl: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: effectiveModel,
        max_tokens: 8000,
        stream: true,
        system: messages.find((m) => m.role === "system")?.content || "",
        messages: messages.filter((m) => m.role !== "system"),
      },
    };
  }

  if (provider === "gemini") {
    const geminiModel = effectiveModel.startsWith("gemini")
      ? effectiveModel
      : "gemini-1.5-pro";
    return {
      apiUrl: `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?key=${apiKey}&alt=sse`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        systemInstruction: {
          parts: [
            { text: messages.find((m) => m.role === "system")?.content || "" },
          ],
        },
        generationConfig: { maxOutputTokens: 8000 },
      },
    };
  }

  // OpenAI or custom
  return {
    apiUrl:
      provider === "custom"
        ? customEndpoint || ""
        : "https://api.openai.com/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: { model: effectiveModel, messages, stream: true, max_tokens: 8000 },
  };
}

// ── Stream parsers ────────────────────────────────────────────────────────────

async function* openAIStream(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const t = JSON.parse(data).choices?.[0]?.delta?.content;
        if (t) yield t;
      } catch {}
    }
  }
}

async function* anthropicStream(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const t = JSON.parse(line.slice(6)).delta?.text;
        if (t) yield t;
      } catch {}
    }
  }
}

async function* geminiStream(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const t = JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts?.[0]
          ?.text;
        if (t) yield t;
      } catch {}
    }
  }
}
