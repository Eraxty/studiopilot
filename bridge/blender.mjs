// Talks to the StudioPilot adapter running inside Blender, launching Blender
// with the adapter when nothing answers.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.STUDIOPILOT_BLENDER_PORT || 8767);
const BASE = `http://127.0.0.1:${PORT}`;
const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blender', 'studiopilot_adapter.py');

function findBlender() {
  if (process.env.STUDIOPILOT_BLENDER_PATH) return process.env.STUDIOPILOT_BLENDER_PATH;
  let candidates = [];
  if (process.platform === 'darwin') {
    candidates = ['/Applications/Blender.app/Contents/MacOS/Blender'];
  } else if (process.platform === 'win32') {
    // default installer location: C:\Program Files\Blender Foundation\Blender 4.x\blender.exe (newest first)
    const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
    try {
      candidates = fs.readdirSync(base).sort().reverse().map((d) => path.join(base, d, 'blender.exe'));
    } catch {}
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, ['blender'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    const b = await r.json();
    return b.app === 'studiopilot-blender' ? b : null;
  } catch { return null; }
}

let launching = null;

/** Make sure a Blender with the adapter is reachable; start one if needed. */
export async function ensureBlender({ background = false, file } = {}) {
  const h = await health();
  if (h) return { started: false, ...h };
  if (!launching) {
    launching = (async () => {
      const exe = findBlender();
      if (!exe) throw new Error('Blender not found. Install Blender 4.2+ or set STUDIOPILOT_BLENDER_PATH.');
      const launch = (headless, waitMs) => {
        const args = [];
        if (headless) args.push('-b');
        if (file) args.push(file);
        args.push('--python', ADAPTER);
        const child = spawn(exe, args, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, STUDIOPILOT_BLENDER_PORT: String(PORT) },
        });
        child.unref();
        return (async () => {
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            const ok = await health();
            if (ok) return { started: true, headless, ...ok };
            if (child.exitCode !== null) return null;
            await new Promise((r) => setTimeout(r, 500));
          }
          try { process.kill(child.pid); } catch {}
          return null;
        })();
      };
      // A Blender window is nicer to watch, but on some GPU setups it hangs
      // before running scripts. Give it 25s, then fall back to headless.
      if (!background) {
        const gui = await launch(false, 25_000);
        if (gui) return gui;
      }
      const headless = await launch(true, 60_000);
      if (headless) return { ...headless, note: background ? undefined : "Blender's window didn't start, so it is running headless. Use blender_render to see the scene." };
      throw new Error(`Blender started but the StudioPilot adapter did not answer on port ${PORT}.`);
    })().finally(() => { launching = null; });
  }
  return launching;
}

const MUTATING = new Set(['run_python', 'build_from_studio', 'import_rig', 'import_animation']);

export async function blenderCall(command, args = {}, timeoutMs = 300_000) {
  await ensureBlender();
  if (MUTATING.has(command) && !args.noCheckpoint) {
    await rawCall('checkpoint', { label: command }, 120_000).catch(() => {});
  }
  return rawCall(command, args, timeoutMs);
}

async function rawCall(command, args, timeoutMs) {
  const r = await fetch(`${BASE}/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...args, timeout: timeoutMs / 1000 }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error + (body.traceback ? `\n${body.traceback}` : ''));
  return body.result;
}

/** Render and return MCP image content plus a caption. */
export async function blenderRender(args) {
  const res = await blenderCall('render', args);
  const images = res.images.map((img) => ({
    data: fs.readFileSync(img.path).toString('base64'),
    mimeType: 'image/png',
    label: img.view,
  }));
  for (const img of res.images) fs.rmSync(path.dirname(img.path), { recursive: true, force: true });
  return {
    __images: images,
    text: `Rendered ${res.objects.length} object(s): ${res.objects.join(', ')}. Views in order: ${res.images.map((i) => i.view).join(', ')}.`,
  };
}
