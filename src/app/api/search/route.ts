import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { generateEmbeddings } from "@/lib/embeddings";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const projectId = searchParams.get("projectId");
  const limit = Number(searchParams.get("limit") || "10");

  if (!query || !projectId) {
    return NextResponse.json(
      { error: "q and projectId are required" },
      { status: 400 },
    );
  }

  try {
    // Generate embedding for the query text
    const [{ embedding }] = await generateEmbeddings([
      { id: "query", text: query },
    ]);

    // Use Supabase match_nodes RPC (requires pgvector + the SQL function below)
    const { data, error } = await supabase.rpc("match_nodes", {
      query_embedding: embedding,
      project_id_filter: projectId,
      match_count: limit,
    });

    if (error) {
      // Fallback: plain text search if pgvector not set up yet
      const { data: textData, error: textError } = await supabase
        .from("nodes")
        .select("*")
        .eq("project_id", projectId)
        .or(`name.ilike.%${query}%,content.ilike.%${query}%`)
        .neq("type", "folder")
        .limit(limit);

      if (textError) throw textError;
      return NextResponse.json({ results: textData, mode: "text_fallback" });
    }

    return NextResponse.json({ results: data, mode: "vector" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
