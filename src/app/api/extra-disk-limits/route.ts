import { NextResponse } from "next/server";
import {
  provisioningExtraDiskLimits,
  EXTRA_DISK_TIER_SIZES_GB,
} from "@/lib/extra-disks";

/** Public sizing limits for dashboard / order UX (derived from env; no secrets). */
export async function GET() {
  try {
    return NextResponse.json({
      ...provisioningExtraDiskLimits(),
      tierSizesGb: [...EXTRA_DISK_TIER_SIZES_GB],
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load limits" }, { status: 500 });
  }
}
