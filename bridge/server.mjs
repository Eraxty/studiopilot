#!/usr/bin/env node
// StudioPilot bridge: an MCP server (stdio) for Claude Code / Codex, plus a
// localhost HTTP endpoint that the Roblox Studio plugin long-polls.
//
// Several agent sessions can run at once. The first process to bind the port
// becomes the "hub" and owns the plugin queue; later processes notice the port
// is taken and forward their tool calls to the hub over HTTP.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { TOOLS } from './tools.mjs';
import { ensureBlender, blenderCall, blenderRender } from './blender.mjs';
import { uploadAsset } from './opencloud.mjs';
import {
  startStudioMcpHost, studioMcpTools, isStudioMcpTool, callStudioMcpTool, studioMcpSessions, setPreferredStudioSession,
} from './studio-mcp.mjs';

const PORT = Number(process.env.STUDIOPILOT_PORT || 8766);
const HOST = '127.0.0.1';
const POLL_HOLD_MS = 20_000;      // how long a plugin poll is held open
const CALL_TIMEOUT_MS = 120_000;  // how long a tool call waits for the plugin
const STUDIO_STALE_MS = 40_000;   // drop a studio we have not heard from

const log = (...a) => process.stderr.write(`[studiopilot] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- hub state

/** studioKey -> { key, place, context, lastSeen, queue: [], waiter } */
const studios = new Map();
/** command id -> { resolve, reject, timer } */
const pending = new Map();
let activePlace = null; // place name the agent picked, or null = auto

function studioKey(place, context) { return `${place}::${context}`; }

function liveStudios() {
  const now = Date.now();
  for (const [k, s] of studios) {
    if (!s.waiter && now - s.lastSeen > STUDIO_STALE_MS) studios.delete(k);
  }
  return [...studios.values()];
}

function pickStudio(context) {
  const live = liveStudios().filter((s) => s.context === context);
  if (activePlace) return live.find((s) => s.place === activePlace) || null;
  // Newest poll wins when nothing was chosen explicitly.
  return live.sort((a, b) => b.lastSeen - a.lastSeen)[0] || null;
}

function deliver(studio) {
  if (!studio.waiter || studio.queue.length === 0) return;
  const { res, timer } = studio.waiter;
  studio.waiter = null;
  clearTimeout(timer);
  sendJson(res, 200, { commands: studio.queue.splice(0) });
}

/** Queue a command for the plugin and wait for its result. */
function dispatch(context, tool, args) {
  const studio = pickStudio(context);
  if (!studio) {
    const ctxHint = context === 'edit'
      ? 'Open Roblox Studio with the StudioPilot plugin enabled and make sure it shows Connected.'
      : `No ${context} session is running. Start a playtest first (start_playtest).`;
    return Promise.reject(new Error(`No Studio connected for context "${context}". ${ctxHint}`));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Studio did not answer "${tool}" within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    studio.queue.push({ id, tool, args });
    deliver(studio);
  });
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    // Plugin: long-poll for commands.
    if (req.method === 'POST' && url.pathname === '/poll') {
      const body = await readBody(req);
      const place = String(body.place || 'Unknown');
      const context = ['edit', 'server', 'client'].includes(body.context) ? body.context : 'edit';
      const key = studioKey(place, context);
      let studio = studios.get(key);
      if (!studio) {
        studio = { key, place, context, lastSeen: 0, queue: [], waiter: null };
        studios.set(key, studio);
        log(`studio connected: ${place} (${context})`);
      }
      studio.lastSeen = Date.now();
      if (studio.waiter) { // a stale poll from the same studio; release it
        clearTimeout(studio.waiter.timer);
        sendJson(studio.waiter.res, 200, { commands: [] });
      }
      const timer = setTimeout(() => {
        if (studio.waiter?.res === res) studio.waiter = null;
        sendJson(res, 200, { commands: [] });
      }, POLL_HOLD_MS);
      studio.waiter = { res, timer };
      req.on('close', () => {
        if (studio.waiter?.res === res && !res.writableEnded) { clearTimeout(timer); studio.waiter = null; }
      });
      deliver(studio);
      return;
    }

    // Plugin: report a command result.
    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await readBody(req);
      const p = pending.get(body.id);
      if (p) {
        pending.delete(body.id);
        clearTimeout(p.timer);
        if (body.ok) p.resolve(body.result);
        else p.reject(new Error(String(body.error || 'plugin error')));
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Plugin: goodbye (studio closing / play session ending).
    if (req.method === 'POST' && url.pathname === '/disconnect') {
      const body = await readBody(req);
      const s = studios.get(studioKey(String(body.place || 'Unknown'), body.context || 'edit'));
      if (s) {
        if (s.waiter) { clearTimeout(s.waiter.timer); sendJson(s.waiter.res, 200, { commands: [] }); }
        studios.delete(s.key);
        log(`studio disconnected: ${s.place} (${s.context})`);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Secondary bridge processes: run a tool call through the hub.
    if (req.method === 'POST' && url.pathname === '/call') {
      const body = await readBody(req);
      try {
        const result = await callTool(body.name, body.arguments || {});
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tools') {
      sendJson(res, 200, { tools: studioMcpTools() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        app: 'studiopilot',
        activePlace,
        studios: liveStudios().map((s) => ({ place: s.place, context: s.context, lastSeen: s.lastSeen })),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e.message });
  }
}

// ---------------------------------------------------------------- tool routing

async function callTool(name, args) {
  if (isStudioMcpTool(name)) return { __raw: await callStudioMcpTool(name, args) };
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}`);

  // Tools handled by the bridge itself.
  if (name === 'list_studios') {
    return {
      activePlace,
      studios: liveStudios().map((s) => ({ place: s.place, context: s.context, secondsSinceSeen: Math.round((Date.now() - s.lastSeen) / 1000) })),
      builtInMcp: studioMcpSessions(),
    };
  }
  if (name === 'set_active_studio') {
    activePlace = args.place || null;
    if (args.studioSessionId !== undefined) setPreferredStudioSession(args.studioSessionId);
    return { activePlace };
  }

  if (def.local) return callLocalTool(name, args);

  const context = def.context === 'dynamic' ? (args.context || 'edit') : (def.context || 'edit');
  const { context: _drop, ...pluginArgs } = args;
  const result = await dispatch(context, def.pluginCommand || name, pluginArgs);

  // The playtest DataModels load the plugin a moment after Play starts; wait
  // for them so the agent can immediately target "server"/"client".
  if (name === 'start_playtest') {
    const want = (args.mode || 'play') === 'run' ? ['server'] : ['server', 'client'];
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const ctxs = new Set(liveStudios().map((s) => s.context));
      if (want.every((c) => ctxs.has(c))) return { ...result, ready: want };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ...result, ready: [...new Set(liveStudios().map((s) => s.context))], warning: 'Playtest started but not every context connected within 45s.' };
  }
  return result;
}

// Tools the bridge answers itself (Blender, uploads), sometimes with Studio's help.
async function callLocalTool(name, args) {
  switch (name) {
    case 'blender_start':
      return ensureBlender({ background: args.background, file: args.file });
    case 'blender_scene':
      return blenderCall('scene');
    case 'blender_run_python':
      return blenderCall('run_python', { code: args.code });
    case 'blender_render':
      return blenderRender(args);
    case 'blender_save':
      return blenderCall('save', { path: args.path });
    case 'studio_to_blender': {
      const exported = await dispatch('edit', 'export_parts', { paths: args.paths });
      if (!exported.parts.length) throw new Error('No parts found to copy (select something in Studio or pass paths).');
      const built = await blenderCall('build_from_studio', { parts: exported.parts, collection: args.collection });
      return { ...built, skipped: exported.skipped };
    }
    case 'blender_to_studio': {
      const exported = await blenderCall('export', { objects: args.objects, name: args.name });
      const up = await uploadAsset({ filePath: exported.path, name: args.name });
      const inserted = await dispatch('edit', 'insert_asset', { assetId: up.assetId, parent: args.parent });
      return { ...up, exportedObjects: exported.objects, ...inserted };
    }
    case 'upload_asset': {
      const up = await uploadAsset({ filePath: args.path, name: args.name });
      if (args.insert && up.assetType === 'Model') {
        return { ...up, ...(await dispatch('edit', 'insert_asset', { assetId: up.assetId, parent: args.parent })) };
      }
      return { ...up, contentId: `rbxassetid://${up.assetId}` };
    }
    case 'blender_checkpoints':
      return blenderCall('checkpoints');
    case 'blender_restore': {
      let id = args.id;
      if (id === 'last') {
        const list = (await blenderCall('checkpoints')).checkpoints;
        if (!list.length) throw new Error('No checkpoints yet');
        id = list[list.length - 1].id;
      }
      return blenderCall('restore', { id });
    }
    case 'blender_import_rig': {
      const { rig, skipped } = await dispatch('edit', 'export_rig', { path: args.path });
      const built = await blenderCall('import_rig', { rig });
      return { ...built, studioPath: rig.path, skipped };
    }
    case 'blender_import_animation': {
      if (!args.path && !args.assetId) throw new Error('Pass path or assetId');
      const anim = await dispatch('edit', 'read_animation', { path: args.path, assetId: args.assetId });
      const res = await blenderCall('import_animation', { armature: args.armature, keyframes: anim.keyframes, name: args.name || anim.name });
      return { ...res, keyframes: anim.keyframes.length, loop: anim.loop };
    }
    case 'blender_export_animation': {
      const scene = await blenderCall('run_python', {
        code: `import json\nresult = json.loads(bpy.data.objects[${JSON.stringify(args.armature)}].get("studiopilot_rig") or "{}").get("studioPath")`,
        noCheckpoint: true,
      });
      const anim = await blenderCall('export_animation', { armature: args.armature, keyframes_only: !args.everyFrame, loop: args.loop });
      const rigPath = scene.result || args.armature;
      return dispatch('edit', 'save_animation', {
        rig: rigPath, name: args.name, loop: args.loop, priority: args.priority, keyframes: anim.keyframes,
      });
    }
    case 'vfx_capture': {
      const frames = args.frames || 4;
      const shots = [];
      const prep = await dispatch('edit', 'vfx_prepare', { path: args.path, distance: args.distance, burst: args.burst });
      for (let i = 0; i < frames; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, args.intervalMs || 250));
        const res = await callStudioMcpTool('roblox_screen_capture', {
          capture_id: `VFX_${Date.now()}_${i}`, camera_position: prep.camera, look_at_position: prep.center,
        });
        for (const c of res.content || []) if (c.type === 'image') shots.push({ data: c.data, mimeType: c.mimeType });
      }
      return {
        __images: shots,
        text: `${shots.length} frame(s) of ${args.path}, ${args.intervalMs || 250}ms apart. Emitters fired: ${prep.emitters.join(', ') || 'none found'}.`,
      };
    }
    default:
      throw new Error(`No local handler for ${name}`);
  }
}

// When this process is not the hub, forward calls to it.
async function forwardToHub(name, args) {
  const res = await fetch(`http://${HOST}:${PORT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS + 5_000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body.result;
}

let isHub = false;
let hubServer = null;

function tryBecomeHub() {
  return new Promise((resolve) => {
    const server = http.createServer(handleHttp);
    server.keepAliveTimeout = POLL_HOLD_MS + 5_000;
    server.requestTimeout = 0;
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else { log('http error:', err.message); resolve(false); }
    });
    server.listen(PORT, HOST, () => {
      hubServer = server;
      startStudioMcpHost(notifyToolsChanged);
      resolve(true);
    });
  });
}

async function isOtherHubAlive() {
  try {
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await r.json();
    return body.app === 'studiopilot';
  } catch { return false; }
}

// Script edits come back with their before/after source. That goes to the
// desktop app (diff view and rewind), not into the model's context.
const APP_URL = process.env.STUDIOPILOT_APP_URL;
const CHAT_ID = process.env.STUDIOPILOT_CHAT_ID;
function reportToApp(event) {
  if (!APP_URL) return;
  fetch(`${APP_URL}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT_ID, ...event }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

async function runTool(name, args) {
  const result = await runToolRaw(name, args);
  if (result && typeof result === 'object' && result.__diff) {
    reportToApp({ kind: 'script_change', tool: name, ...result.__diff });
    return result.message;
  }
  return result;
}

async function runToolRaw(name, args) {
  if (!isHub) {
    // The hub may have exited (its agent session closed); take over if so.
    if (!(await isOtherHubAlive())) {
      isHub = await tryBecomeHub();
      if (isHub) log(`took over as hub on ${HOST}:${PORT}`);
    }
    if (!isHub) return forwardToHub(name, args);
  }
  return callTool(name, args);
}

// ---------------------------------------------------------------- MCP (stdio JSON-RPC)

const SERVER_INFO = { name: 'studiopilot', version: '0.2.0' };

// Studio's built-in tools come and go as Studio connects; tell the client.
let lastToolNames = '';
async function builtInTools() {
  if (isHub) return studioMcpTools();
  try {
    const r = await fetch(`http://${HOST}:${PORT}/tools`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()).tools || [];
  } catch { return []; }
}
function notifyToolsChanged() {
  if (!stdioActive) return;
  const names = studioMcpTools().map((t) => t.name).join(',');
  if (names === lastToolNames) return;
  lastToolNames = names;
  send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}
let stdioActive = false;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function toContent(result) {
  if (result && typeof result === 'object' && result.__raw) return result.__raw.content || [];
  // A screenshot or other image comes back as { __image: base64, mimeType }.
  if (result && typeof result === 'object' && result.__image) {
    return [{ type: 'image', data: result.__image, mimeType: result.mimeType || 'image/png' }];
  }
  if (result && typeof result === 'object' && Array.isArray(result.__images)) {
    return [
      { type: 'text', text: result.text || '' },
      ...result.__images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' })),
    ];
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return [{ type: 'text', text: text ?? 'null' }];
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
        instructions:
          'Tools for controlling Roblox Studio through the StudioPilot plugin. Instance paths are dot paths from game, ' +
          'e.g. "Workspace.Map.Door" or "ServerScriptService.Main". Read a script before editing it, and prefer ' +
          'edit_script (exact find/replace) over write_script for small changes. All edits are undoable in Studio.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [
          ...TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          ...(await builtInTools()),
        ],
      });
    case 'tools/call': {
      try {
        const result = await runTool(params.name, params.arguments || {});
        if (result && result.__raw) return reply({ content: result.__raw.content || [], isError: !!result.__raw.isError });
        return reply({ content: toContent(result) });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

async function main() {
  isHub = await tryBecomeHub();
  log(isHub ? `hub listening on http://${HOST}:${PORT}` : `port ${PORT} busy; forwarding to existing hub`);

  if (process.argv.includes('--hub-only')) return; // run the hub without stdio MCP

  stdioActive = true;
  // Non-hub processes can't see Studio connect; poll the hub's tool list.
  setInterval(async () => {
    if (isHub) return;
    const names = (await builtInTools()).map((t) => t.name).join(',');
    if (names !== lastToolNames) { lastToolNames = names; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
  }, 10_000).unref();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    handleRpc(msg).catch((e) => log('rpc error:', e.stack || e.message));
  });
  rl.on('close', () => { hubServer?.close(); process.exit(0); });
}

main();
