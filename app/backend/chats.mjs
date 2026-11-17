// Chat controller: turns engine events into a persisted message list the UI
// renders, and handles permissions, questions, plan approval, queueing,
// script diffs and rewind.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSession } from './claude.mjs';
import { CodexSession } from './codex.mjs';
import { hubCall } from './services.mjs';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];

const BASE_PROMPT = `You are building a Roblox game in Roblox Studio through the StudioPilot tools.
- Inspect before changing: get_studio_info, list_children, read_script, grep_scripts.
- Edit scripts with edit_script (exact find/replace) or create_script; Studio keeps each edit as an undo step and the user sees a diff.
- After changing gameplay, UI or scripts, verify in a playtest (start_playtest, run_luau with context "server"/"client", get_output, roblox_screen_capture), or hand that to the roblox-playtester agent.
- For 3D models use Blender (blender_* tools), check them with blender_render, and send them to Studio with blender_to_studio. Rigs and animations: blender_import_rig, blender_export_animation.
- For effects use vfx_capture to see them. Keep replies short and say what you changed.`;

const now = () => Date.now();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export class Chats extends EventEmitter {
  constructor({ store, bridgeServer, appUrl, nodeBin }) {
    super();
    this.store = store;
    this.bridgeServer = bridgeServer;
    this.appUrl = appUrl;
    this.nodeBin = nodeBin;
    this.live = new Map(); // chatId -> { session, chat, current, drafts, queue, saveTimer }
  }

  // ---------------------------------------------------------- lifecycle

  create({ projectId, engine, title }) {
    const s = this.store.settings();
    const chat = {
      id: randomUUID(),
      projectId,
      title: title || 'New chat',
      engine: engine || s.engine,
      model: (engine || s.engine) === 'codex' ? s.codexModel : s.claudeModel,
      effort: s.effort,
      mode: 'default',
      sessionId: null,
      carryOver: null,
      messages: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.saveChat(chat);
    return chat;
  }

  get(id) {
    return this.live.get(id)?.chat || this.store.chat(id);
  }

  #state(chatId) {
    let st = this.live.get(chatId);
    if (!st) {
      const chat = this.store.chat(chatId);
      if (!chat) throw new Error(`No chat ${chatId}`);
      st = { chat, session: null, current: null, drafts: [], queue: [], saveTimer: null, emitTimer: null };
      this.live.set(chatId, st);
    }
    return st;
  }

  #project(chat) {
    return this.store.projects().find((p) => p.id === chat.projectId) || { dir: os.homedir(), name: 'Home' };
  }

  #mcpConfig(chat) {
    const file = path.join(os.tmpdir(), `studiopilot-mcp-${chat.id}.json`);
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: {
        studiopilot: {
          command: this.nodeBin.command,
          args: [this.bridgeServer],
          env: { ...this.nodeBin.env, STUDIOPILOT_APP_URL: this.appUrl, STUDIOPILOT_CHAT_ID: chat.id },
        },
      },
    }));
    return file;
  }

  #session(st) {
    if (st.session) return st.session;
    const chat = st.chat;
    const s = this.store.settings();
    const systemPrompt = [BASE_PROMPT, s.customPrompt].filter(Boolean).join('\n\n');
    const project = this.#project(chat);
    const env = {
      STUDIOPILOT_APP_URL: this.appUrl,
      STUDIOPILOT_CHAT_ID: chat.id,
      ...(s.blenderPath ? { STUDIOPILOT_BLENDER_PATH: s.blenderPath } : {}),
    };
    if (chat.engine === 'codex') {
      st.session = new CodexSession({
        cwd: project.dir, model: chat.model || undefined, effort: chat.effort, resume: chat.sessionId,
        systemPrompt, env, autoApprove: s.autoApprove, mode: chat.mode,
        extraConfig: { appUrl: this.appUrl, chatId: chat.id },
      });
    } else {
      st.session = new ClaudeSession({
        cwd: project.dir, model: chat.model, effort: chat.effort, mode: chat.mode, resume: chat.sessionId,
        systemPrompt, mcpConfig: this.#mcpConfig(chat), env, autoApprove: s.autoApprove,
      });
    }
    st.session.on('event', (ev) => this.#onEvent(st, ev));
    return st.session;
  }

  // ---------------------------------------------------------- sending

  async send(chatId, { text, images = [] }) {
    const st = this.#state(chatId);
    const chat = st.chat;
    const userMsg = { id: randomUUID(), role: 'user', text, images: images.map((i) => ({ path: this.store.saveImage(i.data, i.mediaType), mediaType: i.mediaType })), ts: now() };
    if (chat.messages.length === 0 && text) chat.title = text.replace(/\s+/g, ' ').slice(0, 48);

    if (this.#busy(st)) {
      userMsg.queued = true;
      chat.messages.push(userMsg);
      st.queue.push({ msg: userMsg, images });
      this.#changed(st);
      return userMsg;
    }
    chat.messages.push(userMsg);
    this.#dispatch(st, userMsg, images);
    return userMsg;
  }

  #busy(st) { return !!st.current && !st.current.done; }

  #dispatch(st, userMsg, images) {
    const chat = st.chat;
    userMsg.queued = false;
    let text = userMsg.text || '';
    if (chat.carryOver) {
      text = `Earlier conversation (restored after a rewind), for context:\n${chat.carryOver}\n\n---\n\n${text}`;
      chat.carryOver = null;
    }
    const content = [];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    content.push({ type: 'text', text: text || '(see image)' });
    st.current = { id: randomUUID(), role: 'assistant', blocks: [], ts: now(), done: false, turnOf: userMsg.id };
    st.drafts = [];
    chat.messages.push(st.current);
    this.#changed(st);
    try {
      this.#session(st).send(content);
    } catch (e) {
      this.#finish(st, { isError: true, text: e.message });
    }
  }

  // ---------------------------------------------------------- engine events

  #block(st, block) {
    st.current.blocks.push(block);
    return block;
  }

  #onEvent(st, ev) {
    const chat = st.chat;
    const cur = st.current;
    switch (ev.kind) {
      case 'init':
        chat.sessionId = ev.sessionId;
        if (ev.model) chat.activeModel = ev.model;
        break;
      case 'message_start':
        st.drafts = [];
        break;
      case 'block_start': {
        if (!cur) break;
        const type = ev.block.type === 'thinking' ? 'thinking' : ev.block.type === 'text' ? 'text' : null;
        if (type) st.drafts[ev.index] = this.#block(st, { type, text: '', draft: true });
        break;
      }
      case 'text_delta':
      case 'thinking_delta': {
        const d = st.drafts[ev.index];
        if (d) d.text += ev.text;
        break;
      }
      case 'assistant': {
        if (!cur) break;
        for (const c of ev.content || []) {
          if (c.type === 'text' || c.type === 'thinking') {
            const kind = c.type;
            const draft = cur.blocks.find((b) => b.draft && b.type === kind);
            const finalText = kind === 'text' ? c.text : (c.thinking || draft?.text || '');
            if (draft) { draft.text = finalText; delete draft.draft; }
            else if (finalText) this.#block(st, { type: kind, text: finalText });
          } else if (c.type === 'tool_use') {
            // questions and plans get their own cards; a tool row would just repeat them
            if (c.name === 'AskUserQuestion' || c.name === 'ExitPlanMode') continue;
            this.#block(st, { type: 'tool', id: c.id, name: c.name, input: c.input, status: 'running' });
          }
        }
        cur.blocks = cur.blocks.filter((b) => !(b.type === 'thinking' && !b.text && !b.draft));
        if (ev.usage) cur.usage = ev.usage;
        break;
      }
      case 'tool_result': {
        const tool = cur?.blocks.find((b) => b.type === 'tool' && b.id === ev.toolUseId);
        if (!tool) break;
        tool.status = ev.isError ? 'error' : 'done';
        tool.result = textOf(ev.content).slice(0, 20000);
        const imgs = Array.isArray(ev.content) ? ev.content.filter((c) => c.type === 'image') : [];
        if (imgs.length) {
          tool.images = imgs.map((c) => this.store.saveImage(c.source?.data || c.data, c.source?.media_type || c.mimeType));
          this.emit('gallery', { chatId: chat.id, images: tool.images.map((p) => ({ path: p, tool: tool.name })) });
        }
        break;
      }
      case 'permission': {
        if (!cur) break;
        const kind = ev.toolName === 'AskUserQuestion' ? 'question' : ev.toolName === 'ExitPlanMode' ? 'plan' : 'permission';
        this.#block(st, { type: kind, requestId: ev.requestId, toolName: ev.toolName, input: ev.input, description: ev.description, suggestions: ev.suggestions, status: 'pending' });
        this.emit('attention', { chatId: chat.id, kind });
        break;
      }
      case 'notice':
        if (cur) this.#block(st, { type: 'notice', text: ev.text });
        break;
      case 'result':
        if (ev.sessionId) chat.sessionId = ev.sessionId;
        this.#finish(st, ev);
        return;
      case 'error':
        this.#finish(st, { isError: true, text: ev.message });
        return;
      case 'exit':
        st.session = null;
        if (ev.wasBusy && cur && !cur.done) {
          this.#finish(st, { isError: true, text: ev.stderr ? `Claude stopped: ${ev.stderr.split('\n').slice(-3).join(' ')}` : 'The agent process stopped.' });
          return;
        }
        break;
      default:
    }
    this.#changed(st, true);
  }

  #finish(st, ev) {
    const cur = st.current;
    if (cur && !cur.done) {
      for (const b of cur.blocks) {
        delete b.draft;
        if (b.type === 'tool' && b.status === 'running') b.status = ev.subtype === 'interrupted' ? 'cancelled' : 'unknown';
        if ((b.type === 'permission' || b.type === 'question' || b.type === 'plan') && b.status === 'pending') b.status = 'expired';
      }
      cur.done = true;
      cur.durationMs = ev.durationMs;
      cur.costUsd = ev.costUsd;
      if (ev.usage) {
        const u = ev.usage;
        cur.usage = u;
        st.chat.context = {
          used: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          window: ev.contextWindow || st.chat.context?.window || 200_000,
        };
      }
      if (ev.isError && ev.text) cur.blocks.push({ type: 'error', text: ev.text });
      if (ev.subtype === 'interrupted' || ev.subtype === 'error_during_execution') cur.interrupted = true;
    }
    st.current = null;
    this.#changed(st);
    this.emit('turn-done', { chatId: st.chat.id, isError: !!ev.isError });
    const next = st.queue.shift();
    if (next) this.#dispatch(st, next.msg, next.images);
  }

  #changed(st, throttle = false) {
    const chat = st.chat;
    chat.updatedAt = now();
    const emit = () => {
      st.emitTimer = null;
      this.emit('chat', chat);
    };
    if (throttle) {
      if (!st.emitTimer) st.emitTimer = setTimeout(emit, 60);
    } else {
      clearTimeout(st.emitTimer);
      emit();
    }
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => this.store.saveChat(chat), throttle ? 1000 : 0);
  }

  // ---------------------------------------------------------- user actions

  respond(chatId, requestId, answer) {
    const st = this.#state(chatId);
    const block = st.current?.blocks.find((b) => b.requestId === requestId);
    if (!block || block.status !== 'pending' || !st.session) throw new Error('That request is no longer waiting');
    let decision;
    if (block.type === 'question') {
      // answer.answers: { [question]: label | label[] }
      const answers = {};
      for (const [q, a] of Object.entries(answer.answers || {})) answers[q] = Array.isArray(a) ? a.join(', ') : a;
      decision = { behavior: 'allow', updatedInput: { ...block.input, answers } };
      block.answers = answers;
      block.status = 'answered';
    } else if (block.type === 'plan') {
      if (answer.approve) {
        decision = { behavior: 'allow', updatedInput: block.input };
        block.status = 'approved';
        st.chat.mode = answer.mode || 'acceptEdits';
        st.session.setMode(st.chat.mode).catch(() => {});
      } else {
        decision = { behavior: 'deny', message: answer.feedback ? `Keep planning. Feedback: ${answer.feedback}` : 'Keep planning; the user did not approve this plan yet.' };
        block.status = 'rejected';
      }
    } else if (answer.allow) {
      decision = { behavior: 'allow', updatedInput: block.input };
      if (answer.always && block.suggestions?.length) decision.updatedPermissions = block.suggestions;
      block.status = answer.always ? 'always' : 'allowed';
    } else {
      decision = { behavior: 'deny', message: answer.message || 'The user denied this.' };
      block.status = 'denied';
    }
    st.session.respondPermission(requestId, decision);
    this.#changed(st);
  }

  async stop(chatId) {
    const st = this.#state(chatId);
    st.queue = [];
    st.chat.messages = st.chat.messages.filter((m) => !m.queued); // drop messages still waiting in the queue
    this.#changed(st);
    await st.session?.interrupt();
  }

  async setOptions(chatId, opts) {
    const st = this.#state(chatId);
    const chat = st.chat;
    if (opts.engine && opts.engine !== chat.engine) {
      if (chat.messages.length) throw new Error('Start a new chat to switch between Claude and Codex.');
      chat.engine = opts.engine;
      const s = this.store.settings();
      chat.model = opts.engine === 'codex' ? s.codexModel : s.claudeModel;
      st.session?.kill();
      st.session = null;
    }
    if (opts.model !== undefined && opts.model !== chat.model) {
      chat.model = opts.model;
      await st.session?.setModel(opts.model).catch(() => { st.session?.kill(); st.session = null; });
    }
    if (opts.effort !== undefined && opts.effort !== chat.effort) {
      chat.effort = opts.effort;
      if (chat.engine === 'claude' && st.session && !this.#busy(st)) { st.session.kill(); st.session = null; } // effort is a launch flag
      else if (st.session) st.session.opts.effort = opts.effort;
    }
    if (opts.mode !== undefined && opts.mode !== chat.mode) {
      chat.mode = opts.mode;
      await st.session?.setMode(opts.mode).catch(() => {});
    }
    this.#changed(st);
    return chat;
  }

  rename(chatId, title) {
    const st = this.#state(chatId);
    st.chat.title = title;
    this.#changed(st);
  }

  delete(chatId) {
    const st = this.live.get(chatId);
    st?.session?.kill();
    this.live.delete(chatId);
    this.store.deleteChat(chatId);
  }

  /** A script edit reported by the bridge for this chat. */
  scriptChange(chatId, change) {
    let st;
    try { st = this.#state(chatId); } catch { return; }
    const target = st.current || [...st.chat.messages].reverse().find((m) => m.role === 'assistant');
    if (!target) return;
    target.blocks.push({ type: 'change', path: change.path, className: change.className, before: change.before, after: change.after, created: !!change.created, reverted: false });
    this.#changed(st);
  }

  /**
   * Rewind to just before a user message: undo the script edits made after it
   * (only where the script still matches what the agent wrote), drop the later
   * messages, and start a fresh session that gets the earlier conversation as context.
   */
  async rewind(chatId, messageId) {
    const st = this.#state(chatId);
    if (this.#busy(st)) await this.stop(chatId);
    const chat = st.chat;
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new Error('Message not found');
    const removed = chat.messages.slice(idx);
    const changes = removed.flatMap((m) => (m.blocks || []).filter((b) => b.type === 'change' && !b.reverted)).reverse();
    const report = { restored: [], skipped: [] };
    for (const ch of changes) {
      try {
        const current = await hubCall('read_script', { path: ch.path }).then((r) => r.replace(/^--.*\n/, '').split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n'));
        if (current !== ch.after) { report.skipped.push(`${ch.path} (changed since)`); continue; }
        if (ch.created) await hubCall('delete_instances', { paths: [ch.path] });
        else await hubCall('write_script', { path: ch.path, source: ch.before });
        report.restored.push(ch.path);
      } catch (e) {
        report.skipped.push(`${ch.path} (${e.message})`);
      }
    }
    chat.messages = chat.messages.slice(0, idx);
    chat.carryOver = chat.messages.length ? transcript(chat.messages) : null;
    chat.sessionId = null;
    st.session?.kill();
    st.session = null;
    st.current = null;
    this.#changed(st);
    return { ...report, text: removed[0]?.role === 'user' ? removed[0].text : '' };
  }
}

function transcript(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`User: ${m.text}`);
    else {
      const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const tools = (m.blocks || []).filter((b) => b.type === 'tool').map((b) => b.name.replace(/^mcp__\w+__/, ''));
      lines.push(`Assistant: ${text}${tools.length ? ` [used: ${[...new Set(tools)].join(', ')}]` : ''}`);
    }
  }
  return lines.join('\n').slice(-12000);
}
