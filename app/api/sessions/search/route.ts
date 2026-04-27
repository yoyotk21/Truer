import { NextRequest } from "next/server";
import { listSessions, searchSessions } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const sessions = q ? searchSessions(q) : listSessions();
  return Response.json({ sessions });
}
