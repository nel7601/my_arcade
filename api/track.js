/*
 * Page-view counter endpoint for Vercel. Fire-and-forget from clients.
 */

import { trackVisit } from '../lib/admin.js';

export async function POST(request) {
  try {
    const body = await request.json();
    await trackVisit(body.page);
  } catch { /* malformed beacons are ignored */ }
  return new Response(null, { status: 204 });
}
