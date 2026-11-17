// Exercises the Blender tools through the bridge with headless Blender and a
// fake Studio plugin that answers export_parts. No Roblox needed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PORT = 18766, BPORT = 18768;
const env = { ...process.env, STUDIOPILOT_PORT: String(PORT), STUDIOPILOT_BLENDER_PORT: String(BPORT), STUDIOPILOT_STUDIO_MCP_PORT: '18470', STUDIOPILOT_BLENDER_CHECKPOINTS: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ckpt-')) };
const blender = spawn('blender', ['-b', '--factory-startup', '--python', fileURLToPath(new URL('../blender/studiopilot_adapter.py', import.meta.url))], { env, stdio: 'ignore' });
const hub = spawn(process.execPath, [fileURLToPath(new URL('../bridge/server.mjs', import.meta.url)), '--hub-only'], { env, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let alive = true; let saved = null;
(async () => { // fake plugin
  while (alive) {
    const r = await fetch(`http://127.0.0.1:${PORT}/poll`, { method: 'POST', body: JSON.stringify({ place: 'T', context: 'edit' }) }).catch(() => null);
    if (!r) { await sleep(200); continue; }
    for (const c of (await r.json()).commands) {
      const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (c.tool === 'save_animation') saved = c.args;
      const result = c.tool === 'export_rig'
        ? { rig: { name: 'Dummy', path: 'Workspace.Dummy', root: 'HumanoidRootPart',
            parts: [
              { name: 'HumanoidRootPart', shape: 'Block', size: [2, 2, 1], cframe: [0, 3, 0, ...I], color: [1, 1, 1] },
              { name: 'Torso', shape: 'Block', size: [2, 2, 1], cframe: [0, 3, 0, ...I], color: [0.2, 0.4, 1] },
              { name: 'Head', shape: 'Block', size: [1, 1, 1], cframe: [0, 4.5, 0, ...I], color: [1, 0.8, 0.6] },
            ],
            joints: [
              { name: 'RootJoint', part0: 'HumanoidRootPart', part1: 'Torso', c0: [0, 0, 0, ...I], c1: [0, 0, 0, ...I] },
              { name: 'Neck', part0: 'Torso', part1: 'Head', c0: [0, 1, 0, ...I], c1: [0, -0.5, 0, ...I] },
            ] }, skipped: [] }
        : c.tool === 'read_animation'
        ? { name: 'Nod', loop: false, keyframes: [{ time: 0, poses: { Head: [0, 0, 0, ...I] } }, { time: 0.5, poses: { Head: [0, 0, 0, 1, 0, 0, 0, 0.8, -0.6, 0, 0.6, 0.8] } }] }
        : c.tool === 'save_animation' ? { saved: 'ServerStorage.RBX_ANIMSAVES.Dummy.' + c.args.name }
        : c.tool === 'export_parts'
        ? { parts: [{ name: 'Tower', shape: 'Block', size: [2, 8, 2], cframe: [0, 4, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], color: [0.8, 0.2, 0.2], transparency: 0 }], skipped: [] }
        : { echo: c.tool };
      await fetch(`http://127.0.0.1:${PORT}/result`, { method: 'POST', body: JSON.stringify({ id: c.id, ok: true, result }) });
    }
  }
})();
const call = async (name, args = {}) => (await (await fetch(`http://127.0.0.1:${PORT}/call`, { method: 'POST', body: JSON.stringify({ name, arguments: args }) })).json());
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${BPORT}/health`); break; } catch { await sleep(500); } }
  let r = await call('blender_start'); assert.ok(r.ok, r.error); console.log('start', r.result.blender);
  r = await call('blender_run_python', { code: 'for o in list(bpy.data.objects): bpy.data.objects.remove(o)\nbpy.ops.mesh.primitive_cone_add(location=(4,0,1))\nresult=bpy.context.active_object.name' });
  assert.equal(r.result.result, 'Cone'); console.log('run_python ok');
  r = await call('studio_to_blender', {}); assert.deepEqual(r.result.created, ['Tower']); console.log('studio_to_blender ok');
  r = await call('blender_scene'); console.log('scene:', r.result.objects.map((o) => `${o.name}${JSON.stringify(o.dimensions)}`).join(' '));
  r = await call('blender_render', { views: ['iso'], size: 256 }); assert.equal(r.result.__images.length, 1);
  fs.writeFileSync(new URL('../scratch-render.png', import.meta.url), Buffer.from(r.result.__images[0].data, 'base64')); console.log('render ok:', r.result.text);
  r = await call('blender_to_studio', { name: 'Cone' }); assert.match(r.error, /Open Cloud API key/); console.log('upload without key -> clear error ok');
  r = await call('blender_import_rig', { path: 'Workspace.Dummy' }); assert.deepEqual(r.result.bones, ['Torso', 'Head']); console.log('import_rig ok');
  r = await call('blender_import_animation', { armature: 'Dummy', path: 'ServerStorage.Nod' }); assert.ok(r.ok, r.error); console.log('import_animation ok', r.result.frames);
  r = await call('blender_export_animation', { armature: 'Dummy', name: 'Nod2' }); assert.ok(r.ok, r.error);
  assert.equal(saved.rig, 'Workspace.Dummy'); const head = saved.keyframes.at(-1).poses.Head;
  assert.ok(Math.abs(head[7] - 0.8) < 1e-4 && Math.abs(head[8] + 0.6) < 1e-4, JSON.stringify(head)); console.log('export_animation round trip ok ->', r.result.saved);
  r = await call('blender_checkpoints'); const n = r.result.checkpoints.length; assert.ok(n >= 4); console.log('checkpoints:', n);
  r = await call('blender_restore', { id: 'last' }); assert.ok(r.ok, r.error);
  r = await call('blender_run_python', { code: 'a = bpy.data.objects["Dummy"].animation_data\nresult = a.action.name if a and a.action else None', noCheckpoint: true });
  assert.equal(r.result.result, null, 'restoring the last checkpoint should drop the action added after it'); console.log('restore ok');
  console.log('BLENDER TESTS PASSED');
} finally { alive = false; hub.kill(); blender.kill(); }
process.exit(0);
