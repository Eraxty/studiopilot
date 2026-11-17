// StudioPilot desktop app: Electron main process.
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './backend/store.mjs';
import { Chats, CLAUDE_MODELS } from './backend/chats.mjs';
import * as svc from './backend/services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// In a packaged build the bridge, plugin and Blender adapter ship as extra resources.
const repo = app.isPackaged ? path.join(process.resourcesPath, 'studiopilot') : path.join(here, '..');
const bridgeServer = path.join(repo, 'bridge', 'server.mjs');
const pluginPaths = await import(path.join(repo, 'scripts', 'plugin-paths.mjs'));

app.setName('StudioPilot');
let win = null;

function nodeBinary() {
  try {
    const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p) return { command: p, env: {} };
  } catch {}
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }; // Electron's own Node
}

const store = new Store(app.getPath('userData'));
const nodeBin = nodeBinary();
let chats;

// The bridge reports script edits (diffs) for a chat to this local endpoint.
const appServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/event') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 20e6) req.destroy(); });
  req.on('end', () => {
    try {
      const ev = JSON.parse(body);
      if (ev.kind === 'script_change' && ev.chatId) chats.scriptChange(ev.chatId, ev);
      res.writeHead(200); res.end('{}');
    } catch { res.writeHead(400); res.end(); }
  });
});
await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
const appUrl = `http://127.0.0.1:${appServer.address().port}`;

chats = new Chats({ store, bridgeServer, appUrl, nodeBin });
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
chats.on('chat', (chat) => send('chat', chat));
chats.on('gallery', (g) => send('gallery', g));
chats.on('attention', ({ chatId, kind }) => {
  const chat = chats.get(chatId);
  notify(kind === 'question' ? 'Claude has a question' : kind === 'plan' ? 'Plan ready for review' : 'Approval needed', chat?.title || '');
});
chats.on('turn-done', ({ chatId, isError }) => {
  const chat = chats.get(chatId);
  notify(isError ? 'Turn ended with an error' : 'Done', chat?.title || '');
});

function notify(title, body) {
  if (win?.isFocused()) return;
  win?.flashFrame(true);
  if (Notification.isSupported()) new Notification({ title: `StudioPilot: ${title}`, body }).show();
}

const rojo = new svc.Rojo((line) => send('rojo-log', line));

// ---------------------------------------------------------------- API (renderer -> main)

function defaultProjectDir() {
  const dir = path.join(app.getPath('documents'), 'StudioPilot');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const api = {
  async init() {
    let projects = store.projects();
    if (!projects.length) {
      projects = [{ id: randomUUID(), name: 'My Game', dir: defaultProjectDir() }];
      store.saveProjects(projects);
    }
    return {
      settings: store.settings(),
      projects,
      chats: store.chatList(),
      claudeModels: CLAUDE_MODELS,
      platform: process.platform,
      version: app.getVersion(),
    };
  },
  status: () => svc.setupStatus({ pluginTargets: pluginPaths.pluginFolders(), blenderPath: store.settings().blenderPath }),

  async addProject() {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the folder for this game', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const projects = store.projects();
    const p = { id: randomUUID(), name: path.basename(dir), dir };
    projects.push(p);
    store.saveProjects(projects);
    return p;
  },
  renameProject({ id, name }) {
    const projects = store.projects().map((p) => (p.id === id ? { ...p, name } : p));
    store.saveProjects(projects);
    return projects;
  },
  removeProject({ id }) {
    for (const c of store.chatList().filter((c) => c.projectId === id)) chats.delete(c.id);
    const projects = store.projects().filter((p) => p.id !== id);
    store.saveProjects(projects);
    return projects;
  },

  chatList: () => store.chatList(),
  createChat: (a) => chats.create(a),
  getChat: ({ id }) => chats.get(id),
  send: ({ chatId, text, images }) => chats.send(chatId, { text, images }),
  stop: ({ chatId }) => chats.stop(chatId),
  respond: ({ chatId, requestId, answer }) => chats.respond(chatId, requestId, answer),
  setOptions: ({ chatId, ...opts }) => chats.setOptions(chatId, opts),
  renameChat: ({ chatId, title }) => chats.rename(chatId, title),
  deleteChat: ({ chatId }) => chats.delete(chatId),
  rewind: ({ chatId, messageId }) => chats.rewind(chatId, messageId),

  saveSettings: (patch) => store.saveSettings(patch),

  installPlugin() {
    const target = pluginPaths.pluginTarget();
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(repo, 'plugin', 'StudioPilot.lua'), path.join(target, 'StudioPilot.lua'));
    const agents = path.join(os.homedir(), '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    for (const f of fs.readdirSync(path.join(repo, 'agents'))) fs.copyFileSync(path.join(repo, 'agents', f), path.join(agents, f));
    return { installed: path.join(target, 'StudioPilot.lua') };
  },
  login({ engine }) { svc.openTerminal(engine === 'codex' ? 'codex login' : 'claude'); },
  startHub: () => svc.ensureHub(bridgeServer, nodeBin),
  openBlender: () => svc.hubCall('blender_start', {}),

  rojoStatus: () => rojo.status(),
  rojoStart: ({ dir }) => rojo.start(dir),
  rojoStop: () => rojo.stop(),

  listSkills: () => svc.listSkills(),
  installSkills: ({ url }) => svc.installSkillsFromGit(url),
  removeSkill: ({ name }) => svc.removeSkill(name),

  listMcp: () => svc.listMcpServers(),
  addMcp: (a) => svc.addMcpServer(a),
  removeMcp: ({ name }) => svc.removeMcpServer(name),

  robloxConfig: () => svc.robloxConfig(),
  saveRobloxConfig: (a) => svc.saveRobloxConfig(a),

  openExternal: ({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); },
  openPath: ({ p }) => shell.openPath(p),
  async pickBlender() {
    const r = await dialog.showOpenDialog(win, { title: 'Find Blender', properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  },
};

ipcMain.handle('api', async (_e, method, args) => {
  const fn = api[method];
  if (!fn) throw new Error(`Unknown API ${method}`);
  return fn(args || {});
});

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    title: 'StudioPilot',
    backgroundColor: '#111317',
    icon: path.join(here, 'ui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(here, 'ui', 'index.html'));
  win.on('focus', () => { win.flashFrame(false); send('focus'); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  createWindow();
  svc.ensureHub(bridgeServer, nodeBin).catch(() => {});
  setInterval(async () => send('status', await api.status().catch(() => null)), 4000);
});

app.on('window-all-closed', () => {
  rojo.stop();
  app.quit();
});
