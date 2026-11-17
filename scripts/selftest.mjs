// End-to-end check of the bridge without Roblox: spawns two MCP bridge
// processes (hub + forwarder) and a fake plugin that answers commands.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 18766;
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.mjs');
const env = { ...process.env, STUDIOPILOT_PORT: String(PORT), STUDIOPILOT_STUDIO_MCP_PORT: '18471' };

function startMcp() {
  const p = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 1; const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { p, rpc };
}

let pluginAlive = true;
async function fakePlugin(context) {
  const base = `http://127.0.0.1:${PORT}`;
  while (pluginAlive) {
    const r = await fetch(`${base}/poll`, { method: 'POST', body: JSON.stringify({ place: 'TestPlace', context }) }).catch(() => null);
    if (!r) { await new Promise((s) => setTimeout(s, 100)); continue; }
    const { commands } = await r.json();
    for (const c of commands) {
      const ok = c.tool !== 'boom';
      await fetch(`${base}/result`, { method: 'POST', body: JSON.stringify(
        c.tool === 'list_children' && c.args.path === 'Nope'
          ? { id: c.id, ok: false, error: 'Not found: Nope' }
          : { id: c.id, ok, result: { echo: c.tool, args: c.args, context } }) });
    }
  }
}

const a = startMcp();
await new Promise((r) => setTimeout(r, 300));
const b = startMcp();
await new Promise((r) => setTimeout(r, 300));

const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
assert.equal(init.result.serverInfo.name, 'studiopilot');
const list = await a.rpc('tools/list', {});
console.log('tools:', list.result.tools.map((t) => t.name).join(', '));

// No studio yet -> clean error
let r = await a.rpc('tools/call', { name: 'get_studio_info', arguments: {} });
assert.equal(r.result.isError, true); console.log('no-studio error ok:', r.result.content[0].text.slice(0, 60));

fakePlugin('edit');
await new Promise((s) => setTimeout(s, 200));
r = await a.rpc('tools/call', { name: 'get_studio_info', arguments: {} });
assert.match(r.result.content[0].text, /get_studio_info/); console.log('hub call ok');

r = await b.rpc('tools/call', { name: 'run_luau', arguments: { code: 'return 1', context: 'edit' } });
assert.match(r.result.content[0].text, /"code": "return 1"/);
assert.doesNotMatch(r.result.content[0].text, /"context": "edit",\n\s*}/); console.log('forwarded call ok');

r = await b.rpc('tools/call', { name: 'list_children', arguments: { path: 'Nope' } });
assert.equal(r.result.isError, true); console.log('plugin error propagates ok');

r = await a.rpc('tools/call', { name: 'run_luau', arguments: { code: 'x', context: 'server' } });
assert.equal(r.result.isError, true); console.log('missing server context ok');

fakePlugin('server');
await new Promise((s) => setTimeout(s, 200));
r = await b.rpc('tools/call', { name: 'stop_playtest', arguments: {} });
assert.match(r.result.content[0].text, /"context": "server"/); console.log('server routing ok');

r = await a.rpc('tools/call', { name: 'list_studios', arguments: {} });
console.log(r.result.content[0].text);

// Hub dies -> forwarder takes over
a.p.kill();
await new Promise((s) => setTimeout(s, 500));
r = await b.rpc('tools/call', { name: 'get_selection', arguments: {} });
// plugin re-polls the new hub within its retry loop
if (r.result.isError) { await new Promise((s) => setTimeout(s, 1500)); r = await b.rpc('tools/call', { name: 'get_selection', arguments: {} }); }
assert.match(r.result.content[0].text, /get_selection/); console.log('hub takeover ok');

pluginAlive = false; b.p.kill();
console.log('ALL PASSED'); process.exit(0);
