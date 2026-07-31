#!/usr/bin/env node
// A static file server for the web clients.
//
// The browser demo imports the engine as plain ES modules straight out of
// src/ — there is no build step, no bundler, and no transpiler between the
// source you read and the world that runs.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = decodeURIComponent(url.pathname);
  // Pandora is the default world, so it is what the root serves.
  if (path === '/') path = '/world.html';
  if (path === '/world') path = '/world.html';
  if (path === '/architecture') path = '/index.html';
  if (path === '/grove' || path === '/demo') path = '/demo.html';
  // The web clients live in web/ but address each other from the site root, so
  // that is where they are mounted. Everything else resolves from the repo root
  // — which is how demo.js imports the engine straight out of src/.
  if (!path.startsWith('/src/') && !path.startsWith('/tools/') && !path.startsWith('/test/')) {
    path = `/web${path}`;
  }

  const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${path.replace(/\/$/, '')}/index.html` }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${path}`);
  }
});

server.listen(PORT, () => {
  console.log(`Latticeborn web clients on http://localhost:${PORT}`);
  console.log(`  pandora       http://localhost:${PORT}/          (ray-traced, remembered)`);
  console.log(`  architecture  http://localhost:${PORT}/architecture`);
  console.log(`  the grove     http://localhost:${PORT}/grove`);
});
