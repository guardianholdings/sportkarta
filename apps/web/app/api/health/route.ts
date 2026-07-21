import { NextResponse } from 'next/server';

import { checkDbHealth } from '@sportkarta/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await checkDbHealth();
    if (!db.dwithinOk) {
      return NextResponse.json(
        { status: 'error', reason: 'st_dwithin smoke query found no rows' },
        { status: 500 },
      );
    }
    return NextResponse.json({ status: 'ok', postgis: db.postgisVersion });
  } catch (error) {
    // Log the error only — no request/user data (CLAUDE.md: no PII in logs).
    console.error('[health] database check failed', error);
    return NextResponse.json({ status: 'error', reason: 'database unreachable' }, { status: 500 });
  }
}
