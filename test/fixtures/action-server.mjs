import { createServer } from 'node:http';
import process from 'node:process';

const host = '127.0.0.1';
const port = 4173;
const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>buttonmash action smoke</title></head>
  <body><main><h1>Action smoke target</h1><button type="button">Safe action</button></main></body>
</html>`;

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}).listen(port, host, () => {
  process.stdout.write(`action smoke server listening on http://${host}:${port}\n`);
});
