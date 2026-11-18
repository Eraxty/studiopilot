// App chat -> Claude Code -> StudioPilot -> real Studio, checking the diff
// reaches the app. Needs Studio open on a blank place and the hub running.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Store } from '../backend/store.mjs';
import { Chats } from '../backend/chats.mjs';

const info = await (await fetch('http://127.0.0.1:8766/call', { method: 'POST', body: JSON.stringify({ name: 'get_studio_info', arguments: {} }) })).json();
if (!info.ok || info.result.placeId !== 0) { console.log('Need Studio open on a new blank place:', info.error || info.result.place); process.exit(1); }

const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-')));
store.saveProjects([{ id: 'p', name: 'E2E', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-work-')) }]);
store.saveSettings({ autoApprove: true });
let chats;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { const ev = JSON.parse(b); if (ev.kind === 'script_change') chats.scriptChange(ev.chatId, ev); res.end('{}'); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
chats = new Chats({ store, bridgeServer: fileURLToPath(new URL('../../bridge/server.mjs', import.meta.url)), appUrl: `http://127.0.0.1:${server.address().port}`, nodeBin: { command: 'node', env: {} } });
const c = chats.create({ projectId: 'p', engine: 'claude' });
await chats.setOptions(c.id, { model: 'claude-haiku-5-5', effort: 'low' });
const done = new Promise((res) => chats.on('chat', (ch) => { const m = ch.messages.at(-1); if (ch.id === c.id && m?.role === 'assistant' && m.done) res(ch); }));
chats.send(c.id, { text: 'In Roblox Studio, use the StudioPilot create_script tool to create a Script named AppE2E in ServerScriptService with source: print("made by the app"). Then use edit_script to change "made by the app" to "edited by the app". Reply "done".' });
const ch = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 240000))]);
const m = ch.messages.at(-1);
for (const b of m.blocks) console.log(` ${b.type}${b.status ? `(${b.status})` : ''}: ${(b.name || b.path || b.text || '').slice(0, 90)}`);
const changes = m.blocks.filter((b) => b.type === 'change');
assert.ok(changes.length >= 2, 'expected a diff for the create and the edit');
assert.ok(changes.some((b) => b.after.includes('edited by the app')));
const check = await (await fetch('http://127.0.0.1:8766/call', { method: 'POST', body: JSON.stringify({ name: 'read_script', arguments: { path: 'ServerScriptService.AppE2E' } }) })).json();
console.log('in Studio:', check.result.split('\n')[1]);
const rw = await chats.rewind(c.id, ch.messages[0].id);
console.log('rewind:', JSON.stringify(rw));
const gone = await (await fetch('http://127.0.0.1:8766/call', { method: 'POST', body: JSON.stringify({ name: 'search_instances', arguments: { query: 'AppE2E' } }) })).json();
console.log('after rewind:', gone.result);
chats.live.get(c.id)?.session?.kill();
console.log('STUDIO E2E PASSED');
process.exit(0);
