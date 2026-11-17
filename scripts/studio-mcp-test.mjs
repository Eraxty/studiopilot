// Fake Roblox Studio connecting to the bridge's built-in-MCP host, checking the
// roblox_* tools get listed, called (studio_id filled in) and announced.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const PORT = 18766, MCP = 18469;
const env = { ...process.env, STUDIOPILOT_PORT: String(PORT), STUDIOPILOT_STUDIO_MCP_PORT: String(MCP) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = spawn(process.execPath, [new URL('../bridge/server.mjs', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const msgs = []; const waiting = new Map(); let nextId = 1;
bridge.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); msgs.push(m); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

await sleep(500);
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
let list = await rpc('tools/list', {});
assert.ok(!list.result.tools.some((t) => t.name.startsWith('roblox_'))); console.log('no roblox tools before Studio connects ok');

// Fake Studio: answers like the real one did in the captured session.
const ws = new WebSocket(`ws://127.0.0.1:${MCP}/studio`);
let lastCallArgs = null;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, _meta: { studioSessionId: 'sess-1' }, serverInfo: { name: 'RobloxStudio', version: '0.1.0' } });
  else if (m.method === 'tools/list') reply({ tools: [
    { name: 'screen_capture', description: 'Capture screen', inputSchema: { type: 'object', required: ['studio_id'], properties: { studio_id: { type: 'string' }, capture_id: { type: 'string' } } } },
    { name: 'submit_feedback', description: 'x', inputSchema: { type: 'object', properties: {} } },
  ] });
  else if (m.method === 'tools/call') { lastCallArgs = m.params; reply({ content: [{ type: 'text', text: 'captured' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }); }
};
await new Promise((r) => (ws.onopen = r));
await sleep(800);
assert.ok(msgs.some((m) => m.method === 'notifications/tools/list_changed')); console.log('list_changed sent ok');
list = await rpc('tools/list', {});
const names = list.result.tools.map((t) => t.name);
assert.ok(names.includes('roblox_screen_capture') && !names.includes('roblox_submit_feedback'));
const sc = list.result.tools.find((t) => t.name === 'roblox_screen_capture');
assert.ok(!('studio_id' in sc.inputSchema.properties) && !sc.inputSchema.required.includes('studio_id')); console.log('tools listed, studio_id hidden, feedback hidden ok');
const r = await rpc('tools/call', { name: 'roblox_screen_capture', arguments: { capture_id: 'a' } });
assert.equal(r.result.content[1].type, 'image'); assert.equal(lastCallArgs.arguments.studio_id, 'sess-1'); console.log('call passthrough with image + studio_id ok');
ws.close(); await sleep(500);
const after = await rpc('tools/call', { name: 'roblox_screen_capture', arguments: {} });
assert.equal(after.result.isError, true); console.log('disconnect -> clear error ok');
bridge.kill(); console.log('STUDIO MCP TESTS PASSED'); process.exit(0);
