// Listens where Studio's built-in MCP connects (ws://localhost:13469/studio),
// logs every message, and asks for the tool list using MCP-style JSON-RPC.
import http from 'node:http';
import fs from 'node:fs';
import { attachWs } from '../bridge/ws.mjs';
const out = process.argv[2] || 'studio-mcp-sniff.log';
const log = (...a) => { const l = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(l.slice(0, 400)); fs.appendFileSync(out, l + '\n'); };
const server = http.createServer((req, res) => { log('HTTP', req.method, req.url, JSON.stringify(req.headers)); res.writeHead(404); res.end(); });
attachWs(server, (req) => { log('UPGRADE', req.url, JSON.stringify(req.headers)); return true; }, (ws) => {
  log('CONNECTED');
  ws.on('message', (m) => log('RECV', m));
  ws.on('close', () => log('CLOSED'));
  let n = 1;
  const send = (o) => { const s = JSON.stringify(o); log('SEND', s); ws.send(s); };
  setTimeout(() => send({ jsonrpc: '2.0', id: n++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sniff', version: '0' } } }), 1500);
  setTimeout(() => send({ jsonrpc: '2.0', id: n++, method: 'tools/list', params: {} }), 3000);
});
server.listen(13469, '127.0.0.1', () => log('listening 13469'));
