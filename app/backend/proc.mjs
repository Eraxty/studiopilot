// Cross-platform process helpers. On Windows, npm-installed CLIs are .cmd
// shims, which only run through cmd.exe; everything else spawns directly.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const isWin = process.platform === 'win32';
const execFileP = promisify(execFile);
const cache = new Map();

/** Full path of a command on PATH (prefers .exe over .cmd on Windows), or null. */
export function resolveBin(name) {
  if (cache.has(name)) return cache.get(name);
  let found = null;
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    found = (isWin && (lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.(cmd|bat)$/i.test(l)))) || lines[0] || null;
  } catch {}
  if (found) cache.set(name, found);
  return found;
}

export function clearBinCache() { cache.clear(); }

// Quote one argument for cmd.exe + the MSVC argv parser.
function winQuote(arg) {
  const s = String(arg);
  if (s && !/[\s"&|<>^%(),;=!]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function plan(name, args) {
  const bin = resolveBin(name) || name;
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    return { file: `"${bin}"`, args: args.map(winQuote), shell: true };
  }
  return { file: bin, args, shell: false };
}

/** spawn() a CLI by name. Free text should go over stdin, not argv. */
export function spawnCli(name, args, opts = {}) {
  const p = plan(name, args);
  return spawn(p.file, p.args, { windowsHide: true, ...opts, shell: p.shell });
}

/** execFile() a CLI by name; resolves { stdout, stderr }. */
export function execCli(name, args, opts = {}) {
  const p = plan(name, args);
  return execFileP(p.file, p.args, { windowsHide: true, ...opts, shell: p.shell });
}

/**
 * Apps started from the macOS Dock (or some Linux launchers) get a minimal
 * PATH without Homebrew, npm globals or ~/.local/bin. Borrow the login shell's.
 */
export function adoptLoginShellPath() {
  if (isWin) return;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__SP_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const fromShell = out.split('__SP_PATH__')[1]?.trim();
    if (fromShell) {
      const parts = new Set([...fromShell.split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean));
      process.env.PATH = [...parts].join(':');
    }
  } catch {}
  const home = process.env.HOME;
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', home && `${home}/.local/bin`, home && `${home}/.npm-global/bin`, home && `${home}/.bun/bin`].filter(Boolean);
  const have = new Set((process.env.PATH || '').split(':'));
  for (const e of extra) if (!have.has(e)) process.env.PATH += `:${e}`;
  clearBinCache();
}
