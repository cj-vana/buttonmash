/** Minimal static server for the example app, used by the e2e test. */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP_HTML = join(here, '..', '..', 'examples', 'buggy-app', 'index.html');

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const html = readFileSync(APP_HTML, 'utf8');
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/?') || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.startsWith('/api/boom')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'intentional 500' }));
      return;
    }
    if (url === '/logout') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Logged out</title><h1>logged out</h1>');
      return;
    }
    if (url === '/live-billing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Live billing</title><p>pk_live_1234567890abcdef</p>');
      return;
    }
    // Same-origin iframe content (for iframe-discovery tests).
    if (url === '/frame.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>frame</title>' +
          '<button id="frame-btn" onclick="parent.location.hash=\'#iframe-clicked\'">Frame Action</button>' +
          '<a href="/frame-sub">frame link</a>',
      );
      return;
    }
    // Cookie-gated auth flow (for scripted-login tests).
    if (url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Sign in</title><h1>Sign in</h1>' +
          '<form>' +
          '<input id="user" name="user" type="text" placeholder="user" />' +
          '<input id="pass" name="pass" type="password" placeholder="password" />' +
          '<button id="go" type="button" onclick="document.cookie=\'bm_session=ok;path=/\';location.href=\'/app\'">Sign in</button>' +
          '</form>',
      );
      return;
    }
    if (url === '/app' || url.startsWith('/app/')) {
      const authed = (req.headers.cookie || '').includes('bm_session=ok');
      if (!authed) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>App</title><h1>App Home</h1>' +
          '<a href="/app/projects">Projects</a> <button>Do thing</button>',
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
