import { supabase } from "@/lib/supabase";

/**
 * Deletes all projects that have passed their expiry time.
 * Called as a non-blocking background task from any API route.
 * This way no client needs to be online for cleanup to happen.
 */
export async function cleanupExpiredProjects(): Promise<void> {
  try {
    // Find expired project IDs
    const { data: expired, error } = await supabase
      .from("projects")
      .select("id")
      .lt("expires_at", new Date().toISOString());

    if (error || !expired || expired.length === 0) return;

    const ids = expired.map((p: any) => p.id);

    // Delete in order: edges → nodes → projects (respects FK constraints)
    await supabase.from("edges").delete().in("project_id", ids);
    await supabase.from("nodes").delete().in("project_id", ids);
    await supabase.from("projects").delete().in("id", ids);

    console.log(`[cleanup] Wiped ${ids.length} expired project(s):`, ids);
  } catch (err) {
    // Non-fatal — log and continue
    console.warn("[cleanup] Error during cleanup:", err);
  }
}
