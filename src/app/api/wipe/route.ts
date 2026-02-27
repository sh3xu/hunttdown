import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 },
    );
  }

  try {
    // Delete edges first (no cascade on this table depending on schema setup)
    const { error: edgesError } = await supabase
      .from("edges")
      .delete()
      .eq("project_id", projectId);

    if (edgesError) throw edgesError;

    // Delete nodes
    const { error: nodesError } = await supabase
      .from("nodes")
      .delete()
      .eq("project_id", projectId);

    if (nodesError) throw nodesError;

    // Delete project
    const { error: projectError } = await supabase
      .from("projects")
      .delete()
      .eq("id", projectId);

    if (projectError) throw projectError;

    return NextResponse.json({ success: true, projectId });
  } catch (error: any) {
    console.error("Wipe failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
