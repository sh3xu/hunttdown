import { NextResponse } from "next/server";
import { cleanupExpiredProjects } from "@/lib/cleanup";

/**
 * GET /api/cleanup
 *
 * Deletes all projects whose expires_at has passed.
 * Call this from a Vercel Cron Job (every 1–5 minutes) for reliable cleanup
 * even when no users are active.
 *
 * vercel.json:
 * {
 *   "crons": [{ "path": "/api/cleanup", "schedule": "* * * * *" }]
 * }
 *
 * For non-Vercel hosts, hit this with an external cron (cron-job.org, etc.)
 */
export const dynamic = "force-dynamic";

export async function GET() {
  await cleanupExpiredProjects();
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
