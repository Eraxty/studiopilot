#!/usr/bin/env node
// One-shot setup: Studio plugin, playtester agent, and MCP registration for
// Claude Code and Codex (whichever are installed). Safe to re-run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'bridge', 'server.mjs');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const has = (cmd) => { try { run(process.platform === 'win32' ? 'where' : 'which', [cmd]); return true; } catch { return false; } };

execFileSync(process.execPath, [path.join(root, 'scripts', 'install-plugin.mjs')], { stdio: 'inherit' });

const agentsDir = path.join(os.homedir(), '.claude', 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'agents'))) {
  fs.copyFileSync(path.join(root, 'agents', f), path.join(agentsDir, f));
  console.log(`Installed Claude Code agent -> ${path.join(agentsDir, f)}`);
}

if (has('claude')) {
  const listed = (() => { try { return run('claude', ['mcp', 'list']); } catch { return ''; } })();
  if (/^studiopilot:/m.test(listed)) console.log('Claude Code: studiopilot already registered');
  else { run('claude', ['mcp', 'add', '--scope', 'user', 'studiopilot', '--', process.execPath, server]); console.log('Claude Code: registered studiopilot'); }
}
if (has('codex')) {
  const listed = (() => { try { return run('codex', ['mcp', 'list']); } catch { return ''; } })();
  if (/\bstudiopilot\b/.test(listed)) console.log('Codex: studiopilot already registered');
  else { run('codex', ['mcp', 'add', 'studiopilot', '--', process.execPath, server]); console.log('Codex: registered studiopilot'); }
}
console.log('\nIn Studio: Assistant panel > ... > MCP Servers > turn on "Enable Studio as MCP server" for the roblox_* tools.');
