import { listSessions } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const sessions = listSessions();
  return Response.json({ sessions });
}
