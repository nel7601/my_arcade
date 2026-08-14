/*
 * Back-office API endpoint for Vercel. All logic lives in lib/admin.js.
 */

import { handleAdmin } from '../lib/admin.js';

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const result = await handleAdmin(body);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' }
  });
}
