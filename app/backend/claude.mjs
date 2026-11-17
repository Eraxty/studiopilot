// Drives one Claude Code process per chat over its stream-json protocol:
// user messages in on stdin, events out on stdout, and permission prompts /
// AskUserQuestion delivered to us as control requests (--permission-prompt-tool stdio).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class ClaudeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // { bin, cwd, model, effort, mode, resume, systemPrompt, mcpConfig, env, autoApprove }
    this.proc = null;
    this.sessionId = opts.resume || null;
    this.busy = false;
    this.pendingControl = new Map();
  }

  start() {
    const o = this.opts;
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    ];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.mode) args.push('--permission-mode', o.mode);
    if (o.resume) args.push('--resume', o.resume);
    if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
    if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig);
    this.proc = spawn(o.bin || 'claude', args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.#handle(msg);
      }
    });
    let err = '';
    this.proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    this.proc.on('exit', (code) => {
      this.proc = null;
      const wasBusy = this.busy;
      this.busy = false;
      this.emit('event', { kind: 'exit', code, stderr: err.trim(), wasBusy });
    });
    this.proc.on('error', (e) => this.emit('event', { kind: 'error', message: `Couldn't start Claude Code: ${e.message}` }));
    this.#control({ subtype: 'initialize' }).catch(() => {});
  }

  get alive() { return !!this.proc; }

  #write(obj) {
    if (!this.proc) throw new Error('Claude is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  #control(request) {
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingControl.set(request_id, { resolve, reject });
      try { this.#write({ type: 'control_request', request_id, request }); } catch (e) { this.pendingControl.delete(request_id); reject(e); }
      setTimeout(() => { if (this.pendingControl.delete(request_id)) reject(new Error(`${request.subtype} timed out`)); }, 15_000);
    });
  }

  #handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.emit('event', { kind: 'init', sessionId: msg.session_id, model: msg.model, mode: msg.permissionMode, tools: msg.tools, mcpServers: msg.mcp_servers });
        } else if (msg.subtype === 'compact_boundary') {
          this.emit('event', { kind: 'notice', text: 'Conversation compacted to free up context.' });
        }
        return;
      case 'stream_event': {
        const ev = msg.event;
        if (msg.parent_tool_use_id) return; // sub-agent internals; their final result arrives as a tool result
        if (ev.type === 'content_block_start') {
          this.emit('event', { kind: 'block_start', index: ev.index, block: ev.content_block });
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta;
          if (d.type === 'text_delta') this.emit('event', { kind: 'text_delta', index: ev.index, text: d.text });
          else if (d.type === 'thinking_delta') this.emit('event', { kind: 'thinking_delta', index: ev.index, text: d.thinking });
          else if (d.type === 'input_json_delta') this.emit('event', { kind: 'input_delta', index: ev.index, json: d.partial_json });
        } else if (ev.type === 'message_start') {
          this.emit('event', { kind: 'message_start' });
        }
        return;
      }
      case 'assistant':
        if (msg.parent_tool_use_id) return;
        this.emit('event', { kind: 'assistant', content: msg.message.content, usage: msg.message.usage });
        return;
      case 'user': {
        if (msg.parent_tool_use_id) return;
        const content = Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const c of content) {
          if (c.type === 'tool_result') {
            this.emit('event', { kind: 'tool_result', toolUseId: c.tool_use_id, content: c.content, isError: !!c.is_error });
          }
        }
        return;
      }
      case 'result':
        this.busy = false;
        this.emit('event', {
          kind: 'result',
          subtype: msg.subtype,
          isError: msg.is_error,
          text: msg.result,
          usage: msg.usage,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          sessionId: msg.session_id,
          contextWindow: Object.values(msg.modelUsage || {})[0]?.contextWindow,
        });
        return;
      case 'control_request':
        if (msg.request?.subtype === 'can_use_tool') {
          const r = msg.request;
          if (this.opts.autoApprove && r.tool_name !== 'AskUserQuestion' && r.tool_name !== 'ExitPlanMode') {
            this.respondPermission(msg.request_id, { behavior: 'allow', updatedInput: r.input });
            return;
          }
          this.emit('event', {
            kind: 'permission',
            requestId: msg.request_id,
            toolName: r.tool_name,
            input: r.input,
            description: r.description,
            toolUseId: r.tool_use_id,
            suggestions: r.permission_suggestions,
          });
        } else {
          this.#write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unsupported ${msg.request?.subtype}` } });
        }
        return;
      case 'control_response': {
        const r = msg.response || {};
        const p = this.pendingControl.get(r.request_id);
        if (!p) return;
        this.pendingControl.delete(r.request_id);
        if (r.subtype === 'error') p.reject(new Error(r.error)); else p.resolve(r.response);
        return;
      }
      default:
    }
  }

  /** content: array of Anthropic content blocks (text / image). */
  send(content) {
    if (!this.proc) this.start();
    this.busy = true;
    this.#write({ type: 'user', message: { role: 'user', content } });
  }

  respondPermission(requestId, decision) {
    // decision: { behavior: 'allow', updatedInput, updatedPermissions? } | { behavior: 'deny', message }
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision } });
  }

  async interrupt() {
    if (!this.proc) return;
    try { await this.#control({ subtype: 'interrupt' }); } catch { this.kill(); }
  }

  async setMode(mode) {
    this.opts.mode = mode;
    if (this.proc) await this.#control({ subtype: 'set_permission_mode', mode });
  }

  async setModel(model) {
    this.opts.model = model;
    if (this.proc) await this.#control({ subtype: 'set_model', model });
  }

  kill() {
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }
}
