import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  LOG_CATEGORIES,
  LOG_CATEGORY_LABELS,
  queryAppLogs,
  type LogCategory,
  type LogLevel,
} from "@/lib/app-log";

const LEVELS = new Set<LogLevel>(["info", "warn", "error"]);

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const sp = req.nextUrl.searchParams;
    const categoryRaw = (sp.get("category") ?? "").trim();
    const category = LOG_CATEGORIES.includes(categoryRaw as LogCategory)
      ? (categoryRaw as LogCategory)
      : "";
    const levelRaw = (sp.get("level") ?? "").trim();
    const level = LEVELS.has(levelRaw as LogLevel)
      ? (levelRaw as LogLevel)
      : "";
    const user = (sp.get("user") ?? "").trim();
    const q = (sp.get("q") ?? "").trim();
    const before = (sp.get("before") ?? "").trim();
    const limitRaw = parseInt(sp.get("limit") ?? "150", 10);

    const result = await queryAppLogs({
      category,
      level,
      user,
      q,
      before,
      limit: Number.isFinite(limitRaw) ? limitRaw : 150,
    });

    return NextResponse.json({
      ...result,
      categories: LOG_CATEGORIES.map((id) => ({
        id,
        label: LOG_CATEGORY_LABELS[id],
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read logs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
