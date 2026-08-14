/*
 * Back-office API endpoint for Vercel. All logic lives in lib/admin.js.
 * Any storage failure comes back as readable JSON instead of an opaque
 * platform error, so the panel can show what actually went wrong.
 */

import { handleAdmin } from '../lib/admin.js';

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  try {
    const result = await handleAdmin(body);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    const detail = String((err && err.message) || err).slice(0, 300);
    return new Response(JSON.stringify({ error: 'server_error', detail }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
