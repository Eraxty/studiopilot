// Hosts the endpoint Roblox Studio's built-in MCP connects to
// (ws://localhost:13469/studio) and re-exports its tools as roblox_*.
//
// Studio is the MCP *server* on that socket: once it connects, we send it
// initialize / tools/list / tools/call as JSON-RPC text frames. This replaces
// Roblox's StudioMCP.exe proxy, so no Wine or extra process is needed.
import http from 'node:http';
import { attachWs } from './ws.mjs';

export const STUDIO_MCP_PORT = Number(process.env.STUDIOPILOT_STUDIO_MCP_PORT || 13469);
const PREFIX = 'roblox_';
// Tools that publish or send things outside the place; left out on purpose.
const HIDDEN = new Set(['submit_feedback', 'create_skill', 'edit_skill']);

const log = (...a) => process.stderr.write(`[studiopilot] ${a.join(' ')}\n`);

/** sessionId -> { ws, tools, pending: Map, nextId, info } */
const sessions = new Map();
let onToolsChanged = () => {};
let preferred = null; // studio session id chosen with set_active_studio

function request(sess, method, params, timeoutMs = 120_000) {
  const id = sess.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sess.pending.delete(id);
      reject(new Error(`Studio did not answer ${method} within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    sess.pending.set(id, { resolve, reject, timer });
    sess.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

async function refreshTools(sess) {
  const res = await request(sess, 'tools/list', {});
  sess.tools = (res.tools || []).filter((t) => !HIDDEN.has(t.name));
  onToolsChanged();
}

function onConnection(ws) {
  const sess = { ws, tools: [], pending: new Map(), nextId: 1, id: null, info: null };
  ws.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = sess.pending.get(msg.id);
      if (!p) return;
      sess.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') {
      refreshTools(sess).catch((e) => log('studio tools refresh failed:', e.message));
    } else if (msg.method === 'ping' && msg.id !== undefined) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    }
  });
  ws.on('close', () => {
    for (const p of sess.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Studio disconnected')); }
    if (sess.id) sessions.delete(sess.id);
    log(`studio built-in MCP disconnected (${sess.id})`);
    onToolsChanged();
  });

  (async () => {
    const init = await request(sess, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'studiopilot', version: '0.2.0' },
    });
    sess.id = init?._meta?.studioSessionId || `studio-${Date.now()}`;
    sess.info = init?.serverInfo;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    sessions.set(sess.id, sess);
    await refreshTools(sess);
    log(`studio built-in MCP connected (${sess.id}, ${sess.tools.length} tools)`);
  })().catch((e) => { log('studio MCP handshake failed:', e.message); ws.close(); });
}

/** Start listening for Studio. Returns false if the port is taken. */
export function startStudioMcpHost(toolsChanged) {
  onToolsChanged = toolsChanged || onToolsChanged;
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
    attachWs(server, (req) => req.url.startsWith('/studio'), onConnection);
    server.once('error', (e) => {
      log(`can't host Studio's built-in MCP on ${STUDIO_MCP_PORT} (${e.code}); roblox_* tools disabled. Is Roblox's StudioMCP also running?`);
      resolve(false);
    });
    server.listen(STUDIO_MCP_PORT, '127.0.0.1', () => resolve(true));
  });
}

function pickSession() {
  if (preferred && sessions.has(preferred)) return sessions.get(preferred);
  const all = [...sessions.values()].filter((s) => s.tools.length);
  return all[all.length - 1] || null;
}

export function studioMcpSessions() {
  return [...sessions.values()].map((s) => ({ studioSessionId: s.id, tools: s.tools.length }));
}

export function setPreferredStudioSession(id) { preferred = id || null; }

/** MCP tool definitions to advertise, prefixed and without the studio_id argument. */
export function studioMcpTools() {
  const sess = pickSession();
  if (!sess) return [];
  return sess.tools.map((t) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema || { type: 'object', properties: {} }));
    if (schema.properties) delete schema.properties.studio_id;
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((r) => r !== 'studio_id');
    return {
      name: PREFIX + t.name,
      description: `[Roblox Studio built-in] ${t.description || ''}`,
      inputSchema: schema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    };
  });
}

export function isStudioMcpTool(name) { return name.startsWith(PREFIX); }

/** Call a built-in Studio tool; returns the raw MCP CallToolResult. */
export async function callStudioMcpTool(name, args) {
  const sess = pickSession();
  if (!sess) {
    throw new Error(
      "Studio's built-in MCP isn't connected. In Studio open the Assistant panel > ... > MCP Servers and turn on " +
      '"Enable Studio as MCP server". Studio connects to the bridge within a few seconds.',
    );
  }
  const tool = name.slice(PREFIX.length);
  return request(sess, 'tools/call', { name: tool, arguments: { ...args, studio_id: sess.id } }, 600_000);
}
