#!/usr/bin/env node
// Watch a Mermaid (.mmd) file and serve a live-reloading preview on localhost.
// The page renders the diagram in the browser with mermaid.js, so there is no
// separate render step or headless browser.
//
// Usage: node scripts/watch-mmd.js <file.mmd> [--port 8765] [--no-open]

import { execFile } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mermaidJs = path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');

function parseArgs(argv) {
  const opts = { port: 8765, open: true, input: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--no-open') opts.open = false;
    else if (arg.startsWith('-')) usage(`Unknown option: ${arg}`);
    else opts.input = arg;
  }
  if (!opts.input) usage('Missing .mmd path');
  if (!Number.isInteger(opts.port)) usage('--port must be an integer');
  return opts;
}

function usage(message) {
  console.error(`${message}\nUsage: watch-mmd.js <file.mmd> [--port 8765] [--no-open]`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const input = path.resolve(opts.input);

if (!existsSync(input)) usage(`File not found: ${input}`);
if (!existsSync(mermaidJs)) usage('mermaid not installed. Run `npm install` first.');

const clients = new Set();
const broadcast = () => {
  for (const res of clients) res.write('event: reload\ndata: {}\n\n');
};

// Watch the parent directory: many editors save by replacing the file, which
// would detach a watcher on the file itself.
let debounce;
watch(path.dirname(input), (_event, filename) => {
  if (filename !== path.basename(input)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log(`[${new Date().toLocaleTimeString()}] Changed ${path.relative(process.cwd(), input)}`);
    broadcast();
  }, 100);
});

const page = `<!doctype html>
<meta charset="utf-8">
<title>${path.basename(input)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  #error { display: none; white-space: pre-wrap; background: #fee; color: #900; padding: 1rem; border-radius: 6px; margin-bottom: 1rem; }
</style>
<pre id="error"></pre>
<div id="diagram"></div>
<script src="/mermaid.js"></script>
<script>
  // 'loose' lets Mermaid click links work; the source is your own local file.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
  const diagram = document.getElementById('diagram');
  const error = document.getElementById('error');
  let renderCount = 0;
  async function load() {
    const source = await (await fetch('/diagram.mmd?t=' + Date.now())).text();
    try {
      const { svg, bindFunctions } = await mermaid.render('diagram-' + renderCount++, source);
      diagram.innerHTML = svg;
      bindFunctions?.(diagram);
      error.style.display = 'none';
    } catch (e) {
      error.textContent = e.message || String(e);
      error.style.display = 'block';
      document.querySelectorAll('[id^="ddiagram-"]').forEach((n) => n.remove());
    }
  }
  new EventSource('/events').addEventListener('reload', load);
  load();
</script>
`;

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  } else if (pathname === '/mermaid.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(mermaidJs));
  } else if (pathname === '/diagram.mmd') {
    try {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(await readFile(input));
    } catch {
      res.writeHead(404).end('File not readable');
    }
  } else if (pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(404).end();
  }
});

server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://localhost:${opts.port}`;
  console.log(`Watching ${path.relative(process.cwd(), input)}\nPreview: ${url}`);
  if (opts.open && process.platform === 'darwin') execFile('open', [url]);
});
