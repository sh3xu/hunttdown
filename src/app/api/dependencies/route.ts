import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeId = searchParams.get("id");
  const projectId = searchParams.get("projectId");

  if (!nodeId || !projectId) {
    return NextResponse.json(
      { error: "Node ID and Project ID are required" },
      { status: 400 },
    );
  }

  try {
    // Find all edges where this node is the target (Incoming dependencies)
    const { data: incoming, error: incomingError } = await supabase
      .from("edges")
      .select("*")
      .eq("project_id", projectId)
      .eq("to_node", nodeId);

    if (incomingError) throw incomingError;

    // Find all edges where this node is the source (Outgoing dependencies)
    const { data: outgoing, error: outgoingError } = await supabase
      .from("edges")
      .select("*")
      .eq("project_id", projectId)
      .eq("from_node", nodeId);

    if (outgoingError) throw outgoingError;

    // Fetch node details for all related IDs
    const relatedIds = Array.from(
      new Set([
        ...(incoming || []).map((e: any) => e.from_node),
        ...(outgoing || []).map((e: any) => e.to_node),
      ]),
    );

    const { data: relatedNodes, error: nodesError } = await supabase
      .from("nodes")
      .select("*")
      .eq("project_id", projectId)
      .in("node_id", relatedIds);

    if (nodesError) throw nodesError;

    return NextResponse.json({
      incoming,
      outgoing,
      relatedNodes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
