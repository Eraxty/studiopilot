// Drives Codex with `codex exec --json`, one process per turn, resuming the
// same thread each time. Events are normalized to the shapes ClaudeSession emits.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CodexSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // { bin, cwd, model, effort, resume, systemPrompt, env, autoApprove, mode }
    this.threadId = opts.resume || null;
    this.proc = null;
    this.busy = false;
    this.first = !opts.resume;
  }

  get sessionId() { return this.threadId; }
  get alive() { return true; }
  start() {}

  send(content) {
    const o = this.opts;
    let text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n');
    if (this.first && o.systemPrompt) text = `${o.systemPrompt}\n\n---\n\n${text}`;
    if (o.mode === 'plan') text = `Plan only: explore and propose a step-by-step plan, but do not change any files or call tools that modify Studio or Blender.\n\n${text}`;
    const images = [];
    for (const c of content) {
      if (c.type === 'image' && c.source?.type === 'base64') {
        const ext = (c.source.media_type || 'image/png').split('/')[1];
        const file = path.join(os.tmpdir(), `sp-codex-${Date.now()}-${images.length}.${ext}`);
        fs.writeFileSync(file, Buffer.from(c.source.data, 'base64'));
        images.push(file);
      }
    }
    const args = ['exec'];
    if (this.threadId) args.push('resume', this.threadId);
    args.push('--json', '--skip-git-repo-check');
    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort === 'max' || o.effort === 'xhigh' ? 'high' : o.effort}"`);
    if (o.autoApprove) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', 'workspace-write');
    if (o.extraConfig) {
      // tag StudioPilot calls with this chat so diffs reach the app
      args.push('-c', `mcp_servers.studiopilot.env={STUDIOPILOT_APP_URL="${o.extraConfig.appUrl}",STUDIOPILOT_CHAT_ID="${o.extraConfig.chatId}"}`);
    }
    for (const img of images) args.push('-i', img);
    args.push('--', text);

    this.busy = true;
    this.first = false;
    this.emit('event', { kind: 'message_start' });
    const proc = spawn(o.bin || 'codex', args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    let err = '';
    let blockIndex = 0;
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'thread.started') {
          this.threadId = m.thread_id;
          this.emit('event', { kind: 'init', sessionId: m.thread_id, model: o.model || 'codex default' });
        } else if (m.type === 'item.started' || m.type === 'item.completed') {
          const it = m.item;
          const done = m.type === 'item.completed';
          if (it.type === 'agent_message' && done) {
            this.emit('event', { kind: 'assistant', content: [{ type: 'text', text: it.text }] });
          } else if (it.type === 'reasoning' && done) {
            this.emit('event', { kind: 'assistant', content: [{ type: 'thinking', thinking: it.text || '' }] });
          } else if (it.type === 'command_execution') {
            if (!done) this.emit('event', { kind: 'assistant', content: [{ type: 'tool_use', id: it.id, name: 'Shell', input: { command: it.command } }] });
            else this.emit('event', { kind: 'tool_result', toolUseId: it.id, content: it.aggregated_output, isError: it.exit_code !== 0 });
          } else if (it.type === 'mcp_tool_call') {
            const name = `mcp__${it.server}__${it.tool}`;
            if (!done) this.emit('event', { kind: 'assistant', content: [{ type: 'tool_use', id: it.id, name, input: it.arguments || {} }] });
            else this.emit('event', { kind: 'tool_result', toolUseId: it.id, content: it.result?.content ?? it.error?.message ?? '', isError: it.status === 'failed' || !!it.error });
          } else if (it.type === 'file_change' && done) {
            this.emit('event', { kind: 'assistant', content: [{ type: 'tool_use', id: it.id, name: 'Edit', input: { changes: it.changes } }] });
            this.emit('event', { kind: 'tool_result', toolUseId: it.id, content: 'applied', isError: it.status === 'failed' });
          } else if (it.type === 'web_search' && !done) {
            this.emit('event', { kind: 'assistant', content: [{ type: 'tool_use', id: it.id, name: 'WebSearch', input: { query: it.query } }] });
          } else if (it.type === 'error') {
            this.emit('event', { kind: 'notice', text: it.message });
          }
          blockIndex++;
        } else if (m.type === 'turn.completed') {
          this.lastUsage = m.usage;
        } else if (m.type === 'turn.failed' || m.type === 'error') {
          this.emit('event', { kind: 'notice', text: m.error?.message || m.message || 'Codex error' });
        }
      }
    });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.busy = false;
      for (const img of images) fs.rm(img, () => {});
      const u = this.lastUsage || {};
      this.emit('event', {
        kind: 'result',
        isError: code !== 0 && !signal,
        subtype: signal ? 'interrupted' : code === 0 ? 'success' : 'error',
        text: code !== 0 && !signal ? err.trim().split('\n').slice(-3).join('\n') : undefined,
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens },
        sessionId: this.threadId,
      });
    });
    proc.on('error', (e) => this.emit('event', { kind: 'error', message: `Couldn't start Codex: ${e.message}` }));
  }

  respondPermission() {} // Codex exec runs with its sandbox policy; no interactive prompts
  async interrupt() { this.proc?.kill('SIGINT'); }
  async setMode(mode) { this.opts.mode = mode; }
  async setModel(model) { this.opts.model = model; }
  kill() { this.proc?.kill(); }
}
