import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get("path");
  const root = searchParams.get("root") || process.cwd();
  const projectId = searchParams.get("projectId");

  if (!filePath) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  try {
    const rootPath = path.resolve(root);
    const fullPath = path.resolve(rootPath, filePath);
    const relative = path.relative(rootPath, fullPath);

    // Security check
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    try {
      const content = await fs.readFile(fullPath, "utf8");
      return NextResponse.json({ content });
    } catch (diskError) {
      // Fallback to database if projectId is provided
      if (projectId) {
        const { data: node, error: nodeError } = await supabase
          .from("nodes")
          .select("content")
          .eq("project_id", projectId)
          .eq("path", filePath)
          .eq("type", "file")
          .maybeSingle();

        if (node?.content) {
          return NextResponse.json({ content: node.content });
        }
      }
      throw diskError;
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
}
