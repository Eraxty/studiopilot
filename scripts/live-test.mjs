// Runs every tool against a real Studio connected to the hub on :8766.
// Use a scratch place: it creates and deletes test objects.
const PORT = process.env.STUDIOPILOT_PORT || 8766;
async function call(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/call`, { method: 'POST', body: JSON.stringify({ name, arguments: args }) });
  return r.json();
}
let fails = 0;
async function step(label, name, args, check = () => true) {
  const res = await call(name, args);
  const out = res.ok ? (typeof res.result === 'string' ? res.result : JSON.stringify(res.result)) : 'ERROR: ' + res.error;
  const pass = label.includes('(expected)') ? !res.ok : res.ok && check(typeof res.result === "object" && res.result?.message ? res.result.message : res.result);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}\n   ${out.slice(0, 400).replace(/\n/g, '\n   ')}`);
  return res.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await step('studio info', 'get_studio_info', {}, (r) => r.context === 'edit');
await step('list workspace', 'list_children', { path: 'Workspace', depth: 2 });
await step('create part', 'create_instance', { className: 'Part', parent: 'Workspace', name: 'SP_TestPart',
  properties: { Anchored: true, Position: [0, 10, 0], Size: [4, 1, 4], Color: '#ff8800', Material: 'Enum.Material.Neon' },
  attributes: { Coins: 5 } }, (r) => !r.errors);
await step('read props', 'get_properties', { path: 'Workspace.SP_TestPart', properties: ['Position', 'Color', 'Material', 'Anchored'] },
  (r) => r.properties.Material === 'Enum.Material.Neon' && r.attributes.Coins === 5);
await step('all props (reflection)', 'get_properties', { path: 'Workspace.SP_TestPart' }, (r) => Object.keys(r.properties).length > 10);
await step('set props', 'set_properties', { paths: ['Workspace.SP_TestPart'], properties: { Transparency: 0.5, BrickColor: { BrickColor: 'Bright blue' } } },
  (r) => r['Workspace.SP_TestPart'] === 'ok');
await step('create script', 'create_script', { parent: 'ServerScriptService', name: 'SP_TestScript', className: 'Script',
  source: 'local part = workspace:WaitForChild("SP_TestPart")\nprint("SP hello from server", part.Name)\n' });
await step('read script', 'read_script', { path: 'ServerScriptService.SP_TestScript' }, (r) => r.includes('SP hello'));
await step('edit script', 'edit_script', { path: 'ServerScriptService.SP_TestScript', old_string: 'SP hello from server', new_string: 'SP edited hello' });
await step('grep scripts', 'grep_scripts', { pattern: 'SP edited' }, (r) => r.includes('SP_TestScript:2'));
await step('search', 'search_instances', { query: 'sp_test' }, (r) => r.includes('SP_TestPart'));
await step('selection', 'set_selection', { paths: ['Workspace.SP_TestPart'] });
await step('get selection', 'get_selection', {}, (r) => r[0]?.path === 'Workspace.SP_TestPart');
await step('run luau', 'run_luau', { code: 'print("hi from edit", 1+1)\nreturn workspace.SP_TestPart.Position, #workspace:GetChildren()' },
  (r) => r.ok && r.output.includes('hi from edit'));
await step("run luau compile error (expected)", "run_luau", { code: "retrun 1" }, () => true).catch(()=>{});
await step('move/clone', 'move_instance', { path: 'Workspace.SP_TestPart', clone: true, newName: 'SP_Clone' }, (r) => r.path === 'Workspace.SP_Clone');
await step('output', 'get_output', { limit: 5 });

await step('start playtest', 'start_playtest', { mode: 'play' }, (r) => r.ready?.includes('server'));
await sleep(3000);
await step('server luau', 'run_luau', { context: 'server', code: 'return game:GetService("RunService"):IsServer(), #game.Players:GetPlayers()' }, (r) => r.ok);
await step('client luau', 'run_luau', { context: 'client', code: 'return game.Players.LocalPlayer and game.Players.LocalPlayer.Name' }, (r) => r.ok);
await step('server output', 'get_output', { context: 'server', contains: 'SP edited' }, (r) => r.includes('SP edited hello'));
await step('stop playtest', 'stop_playtest', {});
await sleep(4000);
await step('studios after stop', 'list_studios', {});

await step('cleanup', 'delete_instances', { paths: ['Workspace.SP_TestPart', 'Workspace.SP_Clone', 'ServerScriptService.SP_TestScript'] });
console.log(fails ? `\n${fails} FAILED` : '\nALL LIVE TESTS PASSED');
