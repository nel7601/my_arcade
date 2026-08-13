/*
 * MY ARCADE - server for local play / VPS
 *
 * Serves the portal and every game (public/ folder) over HTTP and
 * accepts WebSockets at /api/ws — the same path the Vercel deployment
 * uses, so the clients can't tell the environments apart. The room
 * relay in lib/rooms.js is game-agnostic and shared by all games.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleConnection } from './lib/rooms.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(PUBLIC_DIR, urlPath);

  // Never serve anything outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Directory URLs (/, /pong/, /pong) serve their index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log(`MY ARCADE listening on http://localhost:${PORT}`);
});
