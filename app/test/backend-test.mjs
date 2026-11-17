// Drives the app backend without Electron: Codex turn, Claude plan mode +
// approval, and interrupt. Uses real CLIs with cheap models.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Store } from '../backend/store.mjs';
import { Chats } from '../backend/chats.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-app-test-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-app-work-'));
const store = new Store(dir);
store.saveProjects([{ id: 'p1', name: 'Test', dir: work }]);
const chats = new Chats({ store, bridgeServer: fileURLToPath(new URL('../../bridge/server.mjs', import.meta.url)), appUrl: 'http://127.0.0.1:9', nodeBin: { command: 'node', env: {} } });
const waitFor = (pred, ms = 150000) => new Promise((res, rej) => {
  const t = setTimeout(() => { chats.off('chat', on); rej(new Error('timeout')); }, ms);
  const on = (c) => { const v = pred(c); if (v) { clearTimeout(t); chats.off('chat', on); res(v); } };
  chats.on('chat', on);
});
const lastAssistant = (c) => [...c.messages].reverse().find((m) => m.role === 'assistant');
const show = (m) => m.blocks.map((b) => `${b.type}${b.status ? `(${b.status})` : ''}: ${(b.text || b.name || b.toolName || '').slice(0, 80)}`).join('\n  ');

// 1. Codex
if (process.argv.includes('--codex')) {
  const c = chats.create({ projectId: 'p1', engine: 'codex' });
  await chats.setOptions(c.id, { effort: 'low' });
  chats.send(c.id, { text: 'Run the shell command `echo codex-in-app` and then reply with exactly: done' });
  const done = await waitFor((ch) => ch.id === c.id && lastAssistant(ch)?.done && ch);
  const m = lastAssistant(done);
  console.log('CODEX:\n  ' + show(m));
  assert.ok(m.blocks.some((b) => b.type === 'tool' && /echo/.test(JSON.stringify(b.input))));
  assert.ok(m.blocks.some((b) => b.type === 'text' && /done/i.test(b.text)));
}

// 2. Claude plan mode -> plan card -> approve -> builds
{
  const c = chats.create({ projectId: 'p1', engine: 'claude' });
  await chats.setOptions(c.id, { model: 'claude-haiku-5-5', effort: 'low', mode: 'plan' });
  store.saveSettings({ autoApprove: true });
  chats.send(c.id, { text: 'Create a file hello.txt containing "hi". Plan first, then call ExitPlanMode with the plan.' });
  const plan = await waitFor((ch) => ch.id === c.id && lastAssistant(ch)?.blocks.find((b) => b.type === 'plan' && b.status === 'pending'));
  console.log('PLAN CARD:', plan.input.plan.slice(0, 120).replace(/\n/g, ' '));
  chats.respond(c.id, plan.requestId, { approve: true, mode: 'acceptEdits' });
  const done = await waitFor((ch) => ch.id === c.id && lastAssistant(ch)?.done && ch);
  console.log('AFTER APPROVAL:\n  ' + show(lastAssistant(done)));
  assert.equal(done.mode, 'acceptEdits');
  assert.ok(fs.existsSync(path.join(work, 'hello.txt')), 'hello.txt should exist after approving the plan');

  // 3. Interrupt a running turn
  chats.send(c.id, { text: 'Count slowly from 1 to 200, one number per line, no tools.' });
  await waitFor((ch) => ch.id === c.id && lastAssistant(ch)?.blocks.some((b) => b.type === 'text' && b.text.length > 20) && ch);
  await chats.stop(c.id);
  const stopped = await waitFor((ch) => ch.id === c.id && lastAssistant(ch)?.done && ch, 30000);
  console.log('INTERRUPT: done=', lastAssistant(stopped).done, 'interrupted=', !!lastAssistant(stopped).interrupted);

  // 4. Queue: send while busy
  chats.send(c.id, { text: 'Reply with the word one.' });
  const q = await chats.send(c.id, { text: 'Reply with the word two.' });
  assert.equal(q.queued, true);
  await waitFor((ch) => ch.id === c.id && ch.messages.filter((m) => m.role === 'assistant' && m.done).length >= 4 && ch);
  console.log('QUEUE: both turns ran');
  chats.live.get(c.id)?.session?.kill();
}
console.log('BACKEND TESTS PASSED');
process.exit(0);
