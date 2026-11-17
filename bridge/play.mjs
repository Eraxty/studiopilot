// Playtest-side commands (context "server" / "client") run through Studio's
// built-in execute_luau instead of our plugin. The plugin stays out of
// playtest DataModels: having it make HTTP requests there crashed Studio when
// the playtest stopped.
import { callStudioMcpTool, studioMcpTools } from './studio-mcp.mjs';

export const PLAY_ROUTED = new Set(['run_luau', 'get_output', 'list_children', 'get_properties']);

export function builtInAvailable() {
  return studioMcpTools().some((t) => t.name === 'roblox_execute_luau');
}

const luaString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

// Shared Luau helpers: resolve a dot path from game, and JSON-safe values.
const PRELUDE = `
local HttpService = game:GetService("HttpService")
local function __resolve(path)
	if path == nil or path == "" or path == "game" then return game end
	local cur = game
	for part in string.gmatch(path, "[^%.]+") do
		if part ~= "game" or cur ~= game then
			local nxt = cur:FindFirstChild(part)
			if not nxt and cur == game then
				local ok, svc = pcall(function() return game:GetService(part) end)
				if ok then nxt = svc end
			end
			if not nxt then error("Not found: " .. path .. " (no child " .. part .. " under " .. cur:GetFullName() .. ")", 0) end
			cur = nxt
		end
	end
	return cur
end
local function __val(v)
	local t = typeof(v)
	if t == "nil" or t == "boolean" or t == "string" then return v end
	if t == "number" then return (v ~= v or v == math.huge or v == -math.huge) and tostring(v) or v end
	if t == "Instance" then return { Instance = v:GetFullName(), ClassName = v.ClassName } end
	if t == "Vector3" then return { v.X, v.Y, v.Z } end
	if t == "Vector2" then return { v.X, v.Y } end
	if t == "Color3" then return { Color3 = { v.R, v.G, v.B }, hex = "#" .. v:ToHex() } end
	if t == "CFrame" then return { CFrame = { v:GetComponents() } } end
	if t == "EnumItem" then return tostring(v) end
	return tostring(v)
end
`;

async function execLuau(context, body) {
  const code = `${PRELUDE}\nlocal __r = (function()\n${body}\nend)()\nreturn __r`;
  const res = await callStudioMcpTool('roblox_execute_luau', {
    datamodel_type: context === 'client' ? 'Client' : 'Server',
    code,
  });
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (res.isError) throw new Error(text || 'execute_luau failed');
  return text;
}

function parseJsonFrom(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch { return null; }
}

export async function playCall(name, args, context) {
  if (name === 'run_luau') {
    const body = `
local __out = {}
local function __cap(prefix)
	return function(...)
		local t = table.pack(...)
		for i = 1, t.n do t[i] = tostring(t[i]) end
		table.insert(__out, prefix .. table.concat(t, "\\t", 1, t.n))
	end
end
local print, warn = __cap(""), __cap("[warn] ")
local __res = table.pack(pcall(function()
${args.code}
end))
local returned = {}
for i = 2, __res.n do returned[i - 1] = __val(__res[i]) end
return HttpService:JSONEncode({ ok = __res[1], error = (not __res[1]) and tostring(__res[2]) or nil,
	output = table.concat(__out, "\\n"), returned = (__res[1] and __res.n > 1) and returned or nil, context = ${luaString(context)} })`;
    const text = await execLuau(context, body);
    return parseJsonFrom(text) || { ok: true, output: text, context };
  }

  if (name === 'get_output') {
    const res = await callStudioMcpTool('roblox_get_console_output', {});
    let lines = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').split('\n');
    if (args.contains) lines = lines.filter((l) => l.includes(args.contains));
    if (args.errorsOnly) lines = lines.filter((l) => /error|warn|exception|stack/i.test(l));
    lines = lines.slice(-(args.limit || 100));
    return lines.join('\n') || '(no output)';
  }

  if (name === 'list_children') {
    const body = `
local root = __resolve(${luaString(args.path || '')})
local maxDepth, limit, count, lines = ${Number(args.depth) || 1}, ${Number(args.limit) || 300}, 0, {}
local function walk(inst, depth)
	for _, child in inst:GetChildren() do
		if count >= limit then return end
		count += 1
		local n = #child:GetChildren()
		table.insert(lines, string.rep("  ", depth - 1) .. child.Name .. " (" .. child.ClassName .. ")" .. (n > 0 and (" [" .. n .. " children]") or ""))
		if depth < maxDepth then walk(child, depth + 1) end
	end
end
pcall(walk, root, 1)
return root:GetFullName() .. " (" .. root.ClassName .. ")\\n" .. table.concat(lines, "\\n")`;
    return execLuau(context, body);
  }

  if (name === 'get_properties') {
    const names = args.properties?.length ? args.properties
      : ['Name', 'ClassName', 'Parent', 'Position', 'Size', 'CFrame', 'Anchored', 'CanCollide', 'Transparency', 'Color', 'Material',
        'Value', 'Text', 'Visible', 'Enabled', 'Health', 'MaxHealth', 'WalkSpeed', 'JumpPower', 'PrimaryPart'];
    const body = `
local inst = __resolve(${luaString(args.path)})
local props = {}
for _, n in { ${names.map(luaString).join(', ')} } do
	local ok, v = pcall(function() return inst[n] end)
	if ok and typeof(v) ~= "RBXScriptSignal" and typeof(v) ~= "function" then props[n] = __val(v) end
end
local attrs = {}
for k, v in inst:GetAttributes() do attrs[k] = __val(v) end
return HttpService:JSONEncode({ path = inst:GetFullName(), className = inst.ClassName, properties = props, attributes = attrs, tags = inst:GetTags() })`;
    const text = await execLuau(context, body);
    return parseJsonFrom(text) || text;
  }
  throw new Error(`no playtest route for ${name}`);
}

/** Wait for Studio to report the playtest DataModels. */
export async function waitForPlay(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await callStudioMcpTool('roblox_get_studio_state', {}).catch(() => null);
    const text = (res?.content || []).map((c) => c.text || '').join(' ');
    if (/Available DataModels:[^\n]*Server/i.test(text)) {
      return /Client/.test(text.split('Available DataModels:')[1] || '') ? ['server', 'client'] : ['server'];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}
