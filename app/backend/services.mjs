// Everything around the chats: the StudioPilot hub, setup checks, Rojo,
// skills, MCP servers and Roblox upload credentials.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveBin, execCli, spawnCli } from './proc.mjs';

const run = promisify(execFile);
export const HUB = `http://127.0.0.1:${process.env.STUDIOPILOT_PORT || 8766}`;

export async function which(cmd) {
  return resolveBin(cmd);
}

// ---------------------------------------------------------------- hub

export async function hubHealth() {
  try {
    const r = await fetch(`${HUB}/health`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch { return null; }
}

export async function hubCall(name, args = {}) {
  const r = await fetch(`${HUB}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(130_000),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error);
  const res = body.result;
  return res && typeof res === 'object' && 'message' in res && '__diff' in res ? res.message : res;
}

/** Start a detached hub so Studio stays connected even with no chat open. */
export async function ensureHub(serverPath, nodeBin) {
  if (await hubHealth()) return true;
  const child = spawn(nodeBin.command, [serverPath, '--hub-only'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ...nodeBin.env },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await hubHealth()) return true;
  }
  return false;
}

// ---------------------------------------------------------------- setup checks

export async function setupStatus({ pluginTargets, blenderPath }) {
  const [claude, codex, blender, rojo, hub] = await Promise.all([
    which('claude'), which('codex'), blenderPath ? Promise.resolve(fs.existsSync(blenderPath) ? blenderPath : null) : which('blender'), which('rojo'), hubHealth(),
  ]);
  const version = async (bin) => {
    if (!bin) return null;
    try { return (await execCli(bin, ['--version'], { timeout: 8000 })).stdout.trim().split('\n')[0]; } catch { return null; }
  };
  const pluginFile = pluginTargets.map((d) => path.join(d, 'StudioPilot.lua')).find((f) => fs.existsSync(f)) || null;
  const builtIn = hub?.builtInMcp || [];
  return {
    claude: { path: claude, version: await version(claude) },
    codex: { path: codex, version: await version(codex) },
    blender: { path: blender },
    rojo: { path: rojo, version: await version(rojo) },
    plugin: { installed: !!pluginFile, path: pluginFile },
    hub: { running: !!hub },
    studio: { connected: (hub?.studios || []).some((s) => s.context === 'edit'), studios: hub?.studios || [] },
    builtInMcp: { connected: builtIn.length > 0 },
  };
}

/** Open a terminal running a command (for `claude` /login, `codex login`). */
export function openTerminal(command) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', command], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${command.replace(/"/g, '\\"')}"`], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const terms = [process.env.TERMINAL, 'kitty', 'alacritty', 'foot', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'].filter(Boolean);
  for (const t of terms) {
    try {
      const args = t === 'gnome-terminal' ? ['--', 'sh', '-c', command] : t === 'wezterm' ? ['start', '--', 'sh', '-c', command] : ['-e', 'sh', '-c', command];
      const p = spawn(t, args, { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
      return;
    } catch {}
  }
}

// ---------------------------------------------------------------- Rojo

export class Rojo {
  constructor(onLog) { this.proc = null; this.dir = null; this.onLog = onLog; this.log = []; }

  status() { return { running: !!this.proc, dir: this.dir, log: this.log.slice(-50) }; }

  async start(dir) {
    if (this.proc) this.stop();
    const bin = await which('rojo');
    if (!bin) throw new Error('Rojo is not installed (https://rojo.space). Install it with Aftman/Rokit or Cargo.');
    if (!fs.existsSync(path.join(dir, 'default.project.json'))) throw new Error(`No default.project.json in ${dir}. Run "rojo init" there first.`);
    this.dir = dir;
    this.log = [];
    this.proc = spawnCli(bin, ['serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (d) => {
      for (const line of String(d).split('\n').filter(Boolean)) { this.log.push(line); this.onLog?.(line); }
      this.log = this.log.slice(-500);
    };
    this.proc.stdout.on('data', push);
    this.proc.stderr.on('data', push);
    this.proc.on('exit', (code) => { push(`rojo exited (${code})`); this.proc = null; this.onLog?.(null); });
    return this.status();
  }

  stop() { this.proc?.kill(); this.proc = null; return this.status(); }
}

// ---------------------------------------------------------------- skills

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function skillDescription(dir) {
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = md.match(/^description:\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

export function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .filter((d) => fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => ({ name: d.name, description: skillDescription(path.join(SKILLS_DIR, d.name)) }));
}

/** Install skills from a GitHub repo: a SKILL.md at the root, or skills/<name>/SKILL.md. */
export async function installSkillsFromGit(url) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(url)) throw new Error('Use a https://github.com/<owner>/<repo> URL');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-skill-'));
  try {
    await execCli('git', ['clone', '--depth', '1', url, tmp], { timeout: 120_000 });
    const found = [];
    if (fs.existsSync(path.join(tmp, 'SKILL.md'))) found.push({ src: tmp, name: path.basename(url).replace(/\.git$/, '') });
    for (const base of ['skills', '.']) {
      const dir = path.join(tmp, base);
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) found.push({ src: path.join(dir, d.name), name: d.name });
      }
    }
    if (!found.length) throw new Error('No SKILL.md found in that repo');
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const installed = [];
    for (const f of found) {
      const dest = path.join(SKILLS_DIR, f.name);
      if (fs.existsSync(dest)) continue;
      fs.cpSync(f.src, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
      installed.push(f.name);
    }
    return { installed, skippedExisting: found.map((f) => f.name).filter((n) => !installed.includes(n)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function removeSkill(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('bad skill name');
  fs.rmSync(path.join(SKILLS_DIR, name), { recursive: true, force: true });
}

// ---------------------------------------------------------------- MCP servers (Claude Code, user scope)

export async function listMcpServers() {
  if (!(await which('claude'))) return [];
  try {
    const { stdout } = await execCli('claude', ['mcp', 'list'], { timeout: 60_000 });
    return stdout.split('\n').map((l) => l.match(/^([\w.-]+):\s+(.+?)\s+-\s+(.+)$/)).filter(Boolean)
      .map((m) => ({ name: m[1], command: m[2], status: m[3].replace(/[✔✗⚠]\s*/u, '') }));
  } catch { return []; }
}

export async function addMcpServer({ name, command, args = [], url }) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Names can only use letters, numbers, dots, dashes and underscores');
  const cmd = url ? ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url] : ['mcp', 'add', '--scope', 'user', name, '--', command, ...args];
  await execCli('claude', cmd, { timeout: 30_000 });
}

export async function removeMcpServer(name) {
  await execCli('claude', ['mcp', 'remove', '--scope', 'user', name], { timeout: 30_000 });
}

// ---------------------------------------------------------------- Roblox Open Cloud config

function robloxConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === 'win32' ? process.env.APPDATA : path.join(os.homedir(), '.config'));
  return path.join(base, 'studiopilot', 'config.json');
}

export function robloxConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(robloxConfigPath(), 'utf8'));
    return { hasKey: !!c.robloxApiKey, creator: c.creator || null };
  } catch { return { hasKey: false, creator: null }; }
}

export function saveRobloxConfig({ apiKey, userId, groupId }) {
  const file = robloxConfigPath();
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (apiKey) c.robloxApiKey = apiKey;
  if (groupId) c.creator = { groupId: String(groupId) };
  else if (userId) c.creator = { userId: String(userId) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  return robloxConfig();
}
