import { AnalyzerEngine } from "@/lib/analyzer/engine";
import { dir } from "tmp-promise";
import AdmZip from "adm-zip";
import { supabase } from "@/lib/supabase";
import { generateEmbeddings, buildEmbeddingText } from "@/lib/embeddings";
import { cleanupExpiredProjects } from "@/lib/cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

function encode(obj: object): Uint8Array {
  return new TextEncoder().encode("data: " + JSON.stringify(obj) + "\n\n");
}

export async function POST(request: Request) {
  let repoUrl: string | null = null;
  let token: string | null = null;
  let file: File | null = null;

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      repoUrl = formData.get("url") as string | null;
      token = formData.get("token") as string | null;
      file = formData.get("file") as File | null;
    } else {
      const { searchParams } = new URL(request.url);
      repoUrl = searchParams.get("url");
      token = searchParams.get("token");
    }
  } catch (err) {
    // fallback if any read issue
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: object) => {
        try {
          controller.enqueue(encode(payload));
        } catch {}
      };

      let tempDir: { path: string; cleanup: () => Promise<void> } | null = null;

      // Non-blocking: clean up any expired projects from previous sessions
      cleanupExpiredProjects().catch(() => {});

      try {
        let targetPath = process.cwd();

        if (file) {
          send({
            type: "progress",
            pct: 5,
            message: "Saving uploaded ZIP...",
          });
          tempDir = await dir({ unsafeCleanup: true });
          targetPath = tempDir.path;

          send({
            type: "progress",
            pct: 20,
            message: "Extracting ZIP archive...",
          });
          
          const arrayBuffer = await file.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          
          const zip = new AdmZip(buffer);
          zip.extractAllTo(targetPath, true);
          
          const { realpath } = await import("fs/promises");
          targetPath = await realpath(targetPath);
          send({
            type: "progress",
            pct: 30,
            message: "Extraction complete. Starting analysis...",
          });
        } else if (repoUrl) {
          send({ type: "progress", pct: 5, message: "Parsing repository URL..." });
          tempDir = await dir({ unsafeCleanup: true });
          targetPath = tempDir.path;

          // Parse GitHub URL → owner/repo + optional branch
          // Supports: https://github.com/owner/repo  or  https://github.com/owner/repo/tree/branch
          const ghMatch = repoUrl
            .replace(/\.git$/, "")
            .match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/([^\/]+))?/);

          if (!ghMatch) {
            throw new Error(
              "Only GitHub URLs are supported (e.g. https://github.com/owner/repo)"
            );
          }

          const owner = ghMatch[1];
          const repo  = ghMatch[2];
          const branch = ghMatch[3] || "HEAD";

          // GitHub ZIP download endpoint — no git binary required
          const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch === "HEAD" ? "main" : branch}.zip`;
          const fallbackZipUrl = `https://github.com/${owner}/${repo}/archive/${branch}.zip`;

          send({ type: "progress", pct: 10, message: `Downloading ${owner}/${repo}@${branch}...` });

          const headers: Record<string, string> = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "Hunttdown/1.0",
          };
          if (token) headers["Authorization"] = `Bearer ${token}`;

          // Try primary branch URL, fall back to /archive/{branch}.zip
          let dlRes = await fetch(zipUrl, { headers });
          if (!dlRes.ok) {
            dlRes = await fetch(fallbackZipUrl, { headers });
          }
          if (!dlRes.ok) {
            throw new Error(
              `Failed to download repository (HTTP ${dlRes.status}). ` +
              `Check the URL is correct and the repo is public (or provide a PAT token for private repos).`
            );
          }

          send({ type: "progress", pct: 20, message: "Extracting repository archive..." });

          const arrayBuffer = await dlRes.arrayBuffer();
          const zipBuffer  = Buffer.from(arrayBuffer);
          const zip = new AdmZip(zipBuffer);
          zip.extractAllTo(targetPath, true);

          // GitHub ZIP contains a single top-level folder e.g. "repo-main/"
          // Move into it so ts-morph finds source files at the root
          const { readdir, realpath: fsRealpath } = await import("fs/promises");
          const entries = await readdir(targetPath);
          if (entries.length === 1) {
            targetPath = `${targetPath}/${entries[0]}`;
          }
          targetPath = await fsRealpath(targetPath);

          send({ type: "progress", pct: 30, message: "Archive extracted. Starting analysis..." });
        }

        send({
          type: "progress",
          pct: 35,
          message: "Scanning source files...",
        });
        const analyzer = new AnalyzerEngine(targetPath, send);
        const analysis = await analyzer.analyze();

        send({
          type: "progress",
          pct: 75,
          message: `Found ${analysis.nodes.length} nodes and ${analysis.edges.length} edges. Saving to database...`,
        });

        if (analysis.nodes.length === 0) {
          send({
            type: "error",
            message:
              "No source files found. Make sure the repo contains .ts/.tsx/.js/.jsx files.",
          });
          return;
        }

        // Persist to Supabase
        const projectName = file
          ? file.name.replace(".zip", "")
          : repoUrl
            ? repoUrl.split("/").pop()?.replace(".git", "") || "remote-project"
            : "local-project";

        send({
          type: "progress",
          pct: 80,
          message: "Creating project record...",
        });
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min TTL
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .insert({
            name: projectName,
            url: repoUrl || null,
            root_path: analysis.rootPath,
            expires_at: expiresAt,
          })
          .select()
          .single();

        if (projectError) throw projectError;

        send({
          type: "progress",
          pct: 85,
          message: `Saving ${analysis.nodes.length} nodes...`,
        });
        const CHUNK = 500;
        const nodesToInsert = analysis.nodes.map((node) => ({
          project_id: project.id,
          node_id: node.id,
          name: node.name,
          type: node.type,
          path: node.path,
          line: node.line,
          content: node.content,
          signature: (node as any).signature || null,
          doc_comment: (node as any).docComment || null,
        }));

        for (let i = 0; i < nodesToInsert.length; i += CHUNK) {
          const { error } = await supabase
            .from("nodes")
            .insert(nodesToInsert.slice(i, i + CHUNK));
          if (error) throw error;
          const pct =
            85 + Math.round(((i + CHUNK) / nodesToInsert.length) * 10);
          send({
            type: "progress",
            pct: Math.min(pct, 95),
            message: `Saved ${Math.min(i + CHUNK, nodesToInsert.length)}/${nodesToInsert.length} nodes...`,
          });
        }

        send({
          type: "progress",
          pct: 96,
          message: `Saving ${analysis.edges.length} edges...`,
        });
        const edgesToInsert = analysis.edges.map((edge: any) => ({
          project_id: project.id,
          from_node: edge.from,
          to_node: edge.to,
          relation: edge.relation,
          call_count: edge.callCount || 1,
        }));

        for (let i = 0; i < edgesToInsert.length; i += CHUNK) {
          const { error } = await supabase
            .from("edges")
            .insert(edgesToInsert.slice(i, i + CHUNK));
          if (error) throw error;
        }

        // Generate embeddings for functions and classes only
        const embeddableNodes = analysis.nodes.filter(
          (n) => n.type === "function" || n.type === "class",
        );
        if (embeddableNodes.length > 0) {
          send({
            type: "progress",
            pct: 97,
            message: `Generating embeddings for ${embeddableNodes.length} symbols...`,
          });
          try {
            const embedItems = embeddableNodes.map((n) => ({
              id: n.id,
              text: buildEmbeddingText(n as any),
            }));
            const embedResults = await generateEmbeddings(embedItems, (msg) =>
              send({ type: "progress", pct: 97, message: msg }),
            );

            // Get DB node IDs for update
            const { data: dbNodes } = await supabase
              .from("nodes")
              .select("id, node_id")
              .eq("project_id", project.id)
              .in(
                "node_id",
                embeddableNodes.map((n) => n.id),
              );

            if (dbNodes && dbNodes.length > 0) {
              const nodeIdMap = new Map(
                dbNodes.map((n: any) => [n.node_id, n.id]),
              );
              const embUpdates = embedResults
                .map((r) => ({
                  id: nodeIdMap.get(r.id),
                  embedding: JSON.stringify(r.embedding),
                }))
                .filter((u) => u.id);

              // Batch parallel updates — much faster than serial single-row updates
              const UPDATE_BATCH = 50;
              for (let i = 0; i < embUpdates.length; i += UPDATE_BATCH) {
                const batch = embUpdates.slice(i, i + UPDATE_BATCH);
                await Promise.allSettled(
                  batch.map((u) =>
                    supabase
                      .from("nodes")
                      .update({ embedding: u.embedding })
                      .eq("id", u.id as string),
                  ),
                );
                send({
                  type: "progress",
                  pct: 98,
                  message: `Indexed ${Math.min(i + UPDATE_BATCH, embUpdates.length)}/${embUpdates.length} embeddings...`,
                });
              }
              send({
                type: "progress",
                pct: 99,
                message: `✅ ${embUpdates.length} embeddings stored. Ensure pgvector index exists in Supabase for vector search.`,
              });
            }
          } catch (embErr: any) {
            // Non-fatal: embeddings fail silently so the rest of analysis is preserved
            console.warn("[embeddings] Failed:", embErr.message);
            send({
              type: "progress",
              pct: 98,
              message: `⚠️ Embeddings skipped (${embErr.message || "non-fatal"}). Search will use text fallback.`,
            });
          }
        }

        send({ type: "progress", pct: 100, message: "Analysis complete!" });
        send({ type: "done", data: { ...analysis, projectId: project.id } });
      } catch (error: any) {
        console.error("Analysis failed:", error);
        send({ type: "error", message: error.message || "Analysis failed" });
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
