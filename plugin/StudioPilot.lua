--!nonstrict
-- StudioPilot: connects Roblox Studio to the local StudioPilot bridge so an
-- AI agent (Claude Code, Codex, ...) can inspect and edit the place.
--
-- The plugin long-polls http://127.0.0.1:<port>/poll for commands, runs them,
-- and POSTs results to /result. It loads in every DataModel: the editor
-- ("edit") and, during a playtest, the server and client ("server"/"client").

local RunService = game:GetService("RunService")

-- Only the editor DataModel runs StudioPilot. Studio also loads plugins into
-- playtest servers and clients; doing anything there (even reading plugin
-- settings) crashed Studio on the next Play under Wine. Playtest commands go
-- through Studio's built-in MCP instead.
if not RunService:IsEdit() then
	return
end

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

-- Editor-only services are fetched on first use, never at load: touching them
-- while Studio is still building a playtest DataModel crashed Studio.
local function lazyService(name: string)
	local svc
	return setmetatable({}, {
		__index = function(_, key)
			svc = svc or game:GetService(name)
			local v = (svc :: any)[key]
			if type(v) == "function" then
				return function(_, ...)
					return v(svc, ...)
				end
			end
			return v
		end,
	})
end
local ChangeHistoryService = lazyService("ChangeHistoryService")
local Selection = lazyService("Selection")
local ScriptEditorService = lazyService("ScriptEditorService")

local PORT = plugin:GetSetting("StudioPilot_Port") or 8766
local BASE = "http://127.0.0.1:" .. tostring(PORT)
local VERSION = "0.1.0"

---------------------------------------------------------------- context

local function detectContext(): string
	if RunService:IsEdit() then
		return "edit"
	elseif RunService:IsClient() and not RunService:IsServer() then
		return "client"
	else
		return "server"
	end
end

local CONTEXT = detectContext()

local function placeName(): string
	if game.PlaceId ~= 0 then
		return game.Name .. " #" .. tostring(game.PlaceId)
	end
	return game.Name
end

---------------------------------------------------------------- output capture

local logBuffer = {}
local LOG_MAX = 2000

local function pushLog(message: string, messageType: Enum.MessageType)
	table.insert(logBuffer, {
		t = os.clock(),
		kind = messageType.Name:gsub("^Message", ""),
		text = message,
	})
	if #logBuffer > LOG_MAX then
		table.remove(logBuffer, 1)
	end
end

local function startLogCapture()
	pcall(function()
		for _, entry in LogService:GetLogHistory() do
			pushLog(entry.message, entry.messageType)
		end
	end)
	LogService.MessageOut:Connect(pushLog)
end

---------------------------------------------------------------- paths

local function pathOf(inst: Instance?): string
	if inst == nil then
		return "nil"
	end
	if inst == game then
		return "game"
	end
	local parts = {}
	local cur = inst
	while cur and cur ~= game do
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	if cur == nil then
		return "<detached>." .. table.concat(parts, ".")
	end
	return table.concat(parts, ".")
end

-- Resolve "Workspace.Map.Door". Names containing dots can be written with
-- brackets: Workspace["My.Part"].Child
local function splitPath(path: string): { string }
	local parts = {}
	local i = 1
	local n = #path
	local buf = ""
	while i <= n do
		local c = path:sub(i, i)
		if c == "." then
			if buf ~= "" then
				table.insert(parts, buf)
			end
			buf = ""
			i += 1
		elseif c == "[" then
			if buf ~= "" then
				table.insert(parts, buf)
			end
			buf = ""
			local quote = path:sub(i + 1, i + 1)
			local close = path:find(quote .. "]", i + 2, true)
			if (quote == '"' or quote == "'") and close then
				table.insert(parts, path:sub(i + 2, close - 1))
				i = close + 2
			else
				error("Bad bracket in path: " .. path)
			end
		else
			buf ..= c
			i += 1
		end
	end
	if buf ~= "" then
		table.insert(parts, buf)
	end
	return parts
end

local function resolve(path: string?): Instance
	if path == nil or path == "" or path == "game" then
		return game
	end
	local parts = splitPath(path)
	local cur: Instance = game
	local start = 1
	if parts[1] == "game" then
		start = 2
	end
	for i = start, #parts do
		local name = parts[i]
		local nextInst = cur:FindFirstChild(name)
		if nextInst == nil and cur == game then
			local ok, svc = pcall(function()
				return game:GetService(name)
			end)
			if ok then
				nextInst = svc
			end
		end
		if nextInst == nil then
			error(("Not found: %s (no child %q under %s)"):format(path, name, pathOf(cur)), 0)
		end
		cur = nextInst
	end
	return cur
end

---------------------------------------------------------------- value (de)serialization

local function encode(v: any, depth: number?): any
	depth = depth or 0
	local t = typeof(v)
	if t == "nil" or t == "boolean" or t == "string" then
		return v
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return tostring(v)
		end
		return v
	elseif t == "Instance" then
		return { Instance = pathOf(v), ClassName = v.ClassName }
	elseif t == "Vector3" then
		return { v.X, v.Y, v.Z }
	elseif t == "Vector2" then
		return { v.X, v.Y }
	elseif t == "Color3" then
		return { Color3 = { v.R, v.G, v.B }, hex = "#" .. v:ToHex() }
	elseif t == "CFrame" then
		return { CFrame = { v:GetComponents() } }
	elseif t == "UDim2" then
		return { UDim2 = { v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset } }
	elseif t == "UDim" then
		return { UDim = { v.Scale, v.Offset } }
	elseif t == "BrickColor" then
		return { BrickColor = v.Name }
	elseif t == "EnumItem" then
		return tostring(v)
	elseif t == "table" then
		if depth > 6 then
			return "<table: too deep>"
		end
		local out = {}
		for k, val in v do
			out[tostring(k)] = encode(val, depth + 1)
		end
		-- keep arrays as arrays
		if #v > 0 then
			local arr = {}
			for i, val in ipairs(v) do
				arr[i] = encode(val, depth + 1)
			end
			return arr
		end
		return out
	else
		return tostring(v)
	end
end

local function decode(v: any, current: any?): any
	local t = typeof(v)
	if t == "string" then
		if v:sub(1, 5) == "Enum." then
			local _, enumName, itemName = table.unpack(v:split("."))
			return (Enum :: any)[enumName][itemName]
		end
		if typeof(current) == "Color3" and v:sub(1, 1) == "#" then
			return Color3.fromHex(v)
		end
		if typeof(current) == "BrickColor" then
			return BrickColor.new(v)
		end
		if typeof(current) == "EnumItem" then
			return (current :: EnumItem).EnumType[v]
		end
		return v
	elseif t == "table" then
		if v["nil"] then
			return nil
		elseif v.Instance then
			return resolve(v.Instance)
		elseif v.Color3 then
			return Color3.new(v.Color3[1], v.Color3[2], v.Color3[3])
		elseif v.UDim2 then
			return UDim2.new(v.UDim2[1], v.UDim2[2], v.UDim2[3], v.UDim2[4])
		elseif v.UDim then
			return UDim.new(v.UDim[1], v.UDim[2])
		elseif v.BrickColor then
			return BrickColor.new(v.BrickColor)
		elseif v.CFrame then
			return CFrame.new(table.unpack(v.CFrame))
		elseif v.Vector3 then
			return Vector3.new(v.Vector3[1], v.Vector3[2], v.Vector3[3])
		elseif #v == 3 then
			if typeof(current) == "Color3" then
				return Color3.new(v[1], v[2], v[3])
			end
			return Vector3.new(v[1], v[2], v[3])
		elseif #v == 2 then
			return Vector2.new(v[1], v[2])
		elseif #v == 12 then
			return CFrame.new(table.unpack(v))
		elseif #v == 4 and typeof(current) == "UDim2" then
			return UDim2.new(v[1], v[2], v[3], v[4])
		end
	end
	return v
end

local function applyProps(inst: Instance, props: { [string]: any }?, attrs: { [string]: any }?)
	local errors = {}
	for key, raw in props or {} do
		local ok, err = pcall(function()
			local current = (inst :: any)[key]
			;(inst :: any)[key] = decode(raw, current)
		end)
		if not ok then
			table.insert(errors, ("%s: %s"):format(key, tostring(err)))
		end
	end
	for key, raw in attrs or {} do
		local ok, err = pcall(function()
			inst:SetAttribute(key, decode(raw, inst:GetAttribute(key)))
		end)
		if not ok then
			table.insert(errors, ("attribute %s: %s"):format(key, tostring(err)))
		end
	end
	return errors
end

---------------------------------------------------------------- undo helper

local function recorded<T>(name: string, fn: () -> T): T
	if CONTEXT ~= "edit" then
		return fn()
	end
	local id = ChangeHistoryService:TryBeginRecording("StudioPilot: " .. name)
	local ok, result = pcall(fn)
	if id then
		ChangeHistoryService:FinishRecording(
			id,
			if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then
		error(result, 0)
	end
	return result
end

---------------------------------------------------------------- script helpers

local function isScript(inst: Instance): boolean
	return inst:IsA("LuaSourceContainer")
end

local function getSource(s: Instance): string
	-- Prefer unsaved editor text, but only when the script is open in a tab.
	local ok, src = pcall(function()
		if ScriptEditorService:FindScriptDocument(s) then
			return ScriptEditorService:GetEditorSource(s)
		end
		return nil
	end)
	if ok and type(src) == "string" then
		return src
	end
	return (s :: any).Source
end

local function setSource(s: Instance, source: string)
	-- UpdateSourceAsync is for scripts open in an editor tab. Using it on every
	-- write (even unopened or new scripts) left Studio in a state that crashed
	-- the next Play. Only go through the editor when a tab is actually open.
	local doc
	pcall(function()
		doc = ScriptEditorService:FindScriptDocument(s)
	end)
	if doc then
		local ok = pcall(function()
			ScriptEditorService:UpdateSourceAsync(s, function()
				return source
			end)
		end)
		if ok then
			return
		end
	end
	(s :: any).Source = source
end

local function numbered(source: string, startLine: number?, endLine: number?): (string, number)
	local lines = source:split("\n")
	local first = math.max(1, startLine or 1)
	local last = math.min(#lines, endLine or #lines)
	local out = table.create(math.max(0, last - first + 1))
	for i = first, last do
		table.insert(out, ("%5d\t%s"):format(i, lines[i]))
	end
	return table.concat(out, "\n"), #lines
end

local function countPlain(haystack: string, needle: string): number
	local count, init = 0, 1
	while true do
		local s, e = haystack:find(needle, init, true)
		if not s then
			break
		end
		count += 1
		init = e + 1
	end
	return count
end

local function replacePlain(haystack: string, needle: string, repl: string, all: boolean): string
	local out, init = {}, 1
	while true do
		local s, e = haystack:find(needle, init, true)
		if not s then
			break
		end
		table.insert(out, haystack:sub(init, s - 1))
		table.insert(out, repl)
		init = e + 1
		if not all then
			break
		end
	end
	table.insert(out, haystack:sub(init))
	return table.concat(out)
end

---------------------------------------------------------------- property listing

local FALLBACK_PROPS = {
	"Name", "ClassName", "Parent", "Archivable",
	"Position", "Size", "CFrame", "Orientation", "Anchored", "CanCollide", "CanTouch", "CanQuery",
	"Transparency", "Color", "BrickColor", "Material", "Reflectance", "Shape", "Massless",
	"Enabled", "Disabled", "RunContext", "Value", "Text", "TextColor3", "TextSize", "Font",
	"BackgroundColor3", "BackgroundTransparency", "Visible", "ZIndex", "AnchorPoint", "LayoutOrder",
	"Image", "MeshId", "TextureID", "SoundId", "Volume", "Looped", "Playing",
	"Health", "MaxHealth", "WalkSpeed", "JumpPower", "PrimaryPart", "WorldPivot",
	"Brightness", "Range", "Angle", "Shadows", "Rate", "Lifetime", "Speed",
}

local function propertyNames(inst: Instance): { string }
	local ok, list = pcall(function()
		local ReflectionService = game:GetService("ReflectionService")
		local names = {}
		for _, p in ReflectionService:GetPropertiesOfClass(inst.ClassName) do
			local name = p.Name or p.name
			if name then
				table.insert(names, name)
			end
		end
		return names
	end)
	if ok and #list > 0 then
		return list
	end
	return FALLBACK_PROPS
end

---------------------------------------------------------------- commands

local Commands = {}

function Commands.get_studio_info()
	local services = {}
	for _, svc in game:GetChildren() do
		local ok, count = pcall(function()
			return #svc:GetChildren()
		end)
		if ok and count > 0 then
			table.insert(services, { name = svc.Name, class = svc.ClassName, children = count })
		end
	end
	local selection = {}
	for _, inst in Selection:Get() do
		table.insert(selection, { path = pathOf(inst), class = inst.ClassName })
	end
	return {
		place = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
		context = CONTEXT,
		isRunning = RunService:IsRunning(),
		selection = selection,
		services = services,
		pluginVersion = VERSION,
	}
end

function Commands.list_children(args)
	local root = resolve(args.path)
	local maxDepth = args.depth or 1
	local limit = args.limit or 300
	local count = 0
	local truncated = false
	local lines = {}

	local function walk(inst: Instance, depth: number)
		for _, child in inst:GetChildren() do
			if count >= limit then
				truncated = true
				return
			end
			count += 1
			local n = #child:GetChildren()
			local extra = if n > 0 then (" [%d children]"):format(n) else ""
			table.insert(lines, ("%s%s (%s)%s"):format(string.rep("  ", depth - 1), child.Name, child.ClassName, extra))
			if depth < maxDepth then
				walk(child, depth + 1)
			end
		end
	end

	local ok = pcall(walk, root, 1)
	if not ok then
		table.insert(lines, "<some children not readable>")
	end
	local header = ("%s (%s)"):format(pathOf(root), root.ClassName)
	if truncated then
		table.insert(lines, ("... truncated at %d nodes"):format(limit))
	end
	return header .. "\n" .. table.concat(lines, "\n")
end

function Commands.get_properties(args)
	local inst = resolve(args.path)
	local names = args.properties or propertyNames(inst)
	local props = {}
	for _, name in names do
		local ok, value = pcall(function()
			return (inst :: any)[name]
		end)
		if ok and typeof(value) ~= "RBXScriptSignal" and typeof(value) ~= "function" then
			props[name] = encode(value)
		end
	end
	if isScript(inst) then
		props.Source = nil
		props.LineCount = #getSource(inst):split("\n")
	end
	local attributes = {}
	for k, v in inst:GetAttributes() do
		attributes[k] = encode(v)
	end
	local tags = inst:GetTags()
	return {
		path = pathOf(inst),
		className = inst.ClassName,
		properties = props,
		attributes = attributes,
		tags = tags,
	}
end

function Commands.search_instances(args)
	local root = resolve(args.root)
	local query = args.query and args.query:lower()
	local className = args.className
	local limit = args.limit or 100
	local results = {}
	local ok, descendants = pcall(function()
		return root:GetDescendants()
	end)
	if not ok then
		descendants = {}
		for _, svc in root:GetChildren() do
			pcall(function()
				for _, d in svc:GetDescendants() do
					table.insert(descendants, d)
				end
			end)
		end
	end
	for _, inst in descendants do
		local match = true
		if query and not inst.Name:lower():find(query, 1, true) then
			match = false
		end
		if match and className and not inst:IsA(className) then
			match = false
		end
		if match then
			table.insert(results, ("%s (%s)"):format(pathOf(inst), inst.ClassName))
			if #results >= limit then
				table.insert(results, ("... stopped at %d results"):format(limit))
				break
			end
		end
	end
	if #results == 0 then
		return "No matches."
	end
	return table.concat(results, "\n")
end

function Commands.get_selection()
	local out = {}
	for _, inst in Selection:Get() do
		table.insert(out, { path = pathOf(inst), class = inst.ClassName })
	end
	return out
end

function Commands.set_selection(args)
	local list = {}
	for _, p in args.paths do
		table.insert(list, resolve(p))
	end
	Selection:Set(list)
	return { selected = #list }
end

function Commands.read_script(args)
	local s = resolve(args.path)
	if not isScript(s) then
		error(pathOf(s) .. " is a " .. s.ClassName .. ", not a script", 0)
	end
	local body, total = numbered(getSource(s), args.startLine, args.endLine)
	return ("-- %s (%s, %d lines)\n%s"):format(pathOf(s), s.ClassName, total, body)
end

function Commands.edit_script(args)
	local s = resolve(args.path)
	if not isScript(s) then
		error(pathOf(s) .. " is not a script", 0)
	end
	local src = getSource(s)
	local n = countPlain(src, args.old_string)
	if n == 0 then
		error("old_string not found in " .. pathOf(s) .. ". Re-read the script; it may have changed.", 0)
	end
	if n > 1 and not args.replace_all then
		error(("old_string matches %d times in %s; add more context or set replace_all"):format(n, pathOf(s)), 0)
	end
	local newSrc = replacePlain(src, args.old_string, args.new_string, args.replace_all == true)
	recorded("edit " .. s.Name, function()
		setSource(s, newSrc)
	end)
	return {
		message = ("Edited %s (%d replacement%s)"):format(pathOf(s), if args.replace_all then n else 1, if n == 1 then "" else "s"),
		__diff = { path = pathOf(s), className = s.ClassName, before = src, after = newSrc },
	}
end

function Commands.write_script(args)
	local s = resolve(args.path)
	if not isScript(s) then
		error(pathOf(s) .. " is not a script", 0)
	end
	local before = getSource(s)
	recorded("write " .. s.Name, function()
		setSource(s, args.source)
	end)
	return {
		message = ("Wrote %d lines to %s"):format(#args.source:split("\n"), pathOf(s)),
		__diff = { path = pathOf(s), className = s.ClassName, before = before, after = args.source },
	}
end

function Commands.create_script(args)
	local parent = resolve(args.parent)
	local existing = parent:FindFirstChild(args.name)
	if existing and not args.overwrite then
		error(("%s already has a child named %q; set overwrite or use write_script"):format(pathOf(parent), args.name), 0)
	end
	local before = if existing and isScript(existing) then getSource(existing) else ""
	return recorded("create " .. args.name, function()
		if existing then
			existing:Destroy()
		end
		local s = Instance.new(args.className)
		s.Name = args.name
		if args.runContext and s:IsA("Script") then
			(s :: any).RunContext = (Enum.RunContext :: any)[args.runContext]
		end
		s.Parent = parent
		setSource(s, args.source)
		return {
			message = "Created " .. pathOf(s),
			__diff = { path = pathOf(s), className = s.ClassName, before = before, after = args.source, created = before == "" },
		}
	end)
end

function Commands.grep_scripts(args)
	local root = resolve(args.root)
	local plain = args.plain ~= false
	local caseSensitive = args.caseSensitive == true
	local pattern = if caseSensitive then args.pattern else args.pattern:lower()
	local limit = args.limit or 200
	local out = {}
	local scanned = 0

	local list = {}
	pcall(function()
		for _, d in root:GetDescendants() do
			if isScript(d) then
				table.insert(list, d)
			end
		end
	end)

	for _, s in list do
		scanned += 1
		local ok, src = pcall(getSource, s)
		if ok then
			for lineNo, line in src:split("\n") do
				local hay = if caseSensitive then line else line:lower()
				if hay:find(pattern, 1, plain) then
					table.insert(out, ("%s:%d: %s"):format(pathOf(s), lineNo, line:sub(1, 240)))
					if #out >= limit then
						table.insert(out, ("... stopped at %d matches"):format(limit))
						return table.concat(out, "\n")
					end
				end
			end
		end
	end
	if #out == 0 then
		return ("No matches in %d scripts."):format(scanned)
	end
	return table.concat(out, "\n")
end

function Commands.create_instance(args)
	local parent = resolve(args.parent)
	return recorded("create " .. args.className, function()
		local inst = Instance.new(args.className)
		if args.name then
			inst.Name = args.name
		end
		local errors = applyProps(inst, args.properties, args.attributes)
		inst.Parent = parent
		return { created = pathOf(inst), errors = if #errors > 0 then errors else nil }
	end)
end

function Commands.set_properties(args)
	local targets = {}
	for _, p in args.paths do
		table.insert(targets, resolve(p))
	end
	return recorded("set properties", function()
		local report = {}
		for _, inst in targets do
			local errors = applyProps(inst, args.properties, args.attributes)
			report[pathOf(inst)] = if #errors > 0 then errors else "ok"
		end
		return report
	end)
end

function Commands.delete_instances(args)
	local targets = {}
	for _, p in args.paths do
		table.insert(targets, resolve(p))
	end
	return recorded("delete", function()
		local names = {}
		for _, inst in targets do
			table.insert(names, pathOf(inst))
			inst.Parent = nil -- keeps it restorable by undo, unlike Destroy
		end
		return { deleted = names }
	end)
end

function Commands.move_instance(args)
	local inst = resolve(args.path)
	local newParent = if args.newParent then resolve(args.newParent) else inst.Parent
	return recorded(if args.clone then "clone" else "move", function()
		local target = if args.clone then inst:Clone() else inst
		if args.newName then
			target.Name = args.newName
		end
		target.Parent = newParent
		return { path = pathOf(target) }
	end)
end

-- Read a MeshPart's triangles through EditableMesh, scaled to the part's Size.
-- Only works for meshes this account may access; returns nil otherwise.
local function readMesh(part: MeshPart)
	local AssetService = game:GetService("AssetService")
	local ok, em = pcall(function()
		return AssetService:CreateEditableMeshAsync(Content.fromUri(part.MeshId))
	end)
	if not ok or not em then
		ok, em = pcall(function()
			return (AssetService :: any):CreateEditableMeshAsync(part.MeshId)
		end)
	end
	if not ok or not em then
		return nil
	end
	local index, raw = {}, {}
	local lo = Vector3.new(math.huge, math.huge, math.huge)
	local hi = -lo
	for i, vid in em:GetVertices() do
		local p = em:GetPosition(vid)
		index[vid] = i - 1
		raw[i] = p
		lo = lo:Min(p)
		hi = hi:Max(p)
	end
	local extent = hi - lo
	local center = (hi + lo) / 2
	local scale = Vector3.new(
		if extent.X > 0 then part.Size.X / extent.X else 1,
		if extent.Y > 0 then part.Size.Y / extent.Y else 1,
		if extent.Z > 0 then part.Size.Z / extent.Z else 1
	)
	local verts = table.create(#raw)
	for i, p in raw do
		local v = (p - center) * scale
		verts[i] = { v.X, v.Y, v.Z }
	end
	local faces = {}
	for _, fid in em:GetFaces() do
		local fv = em:GetFaceVertices(fid)
		table.insert(faces, { index[fv[1]], index[fv[2]], index[fv[3]] })
	end
	em:Destroy()
	return { verts = verts, faces = faces }
end

function Commands.export_parts(args)
	local roots = {}
	if args.paths and #args.paths > 0 then
		for _, p in args.paths do
			table.insert(roots, resolve(p))
		end
	else
		roots = Selection:Get()
	end
	local parts, skipped = {}, {}
	local seen = {}

	local function add(part: BasePart)
		if seen[part] or part:IsA("Terrain") or #parts >= 2000 then
			return
		end
		seen[part] = true
		local c = part.Color
		local entry = {
			name = part.Name,
			size = { part.Size.X, part.Size.Y, part.Size.Z },
			cframe = { part.CFrame:GetComponents() },
			color = { c.R, c.G, c.B },
			transparency = part.Transparency,
			shape = "Block",
		}
		if part:IsA("Part") then
			entry.shape = (part :: Part).Shape.Name
		elseif part:IsA("WedgePart") then
			entry.shape = "Wedge"
		elseif part:IsA("CornerWedgePart") then
			entry.shape = "CornerWedge"
		elseif part:IsA("MeshPart") then
			entry.mesh = readMesh(part :: MeshPart)
			if not entry.mesh then
				table.insert(skipped, pathOf(part) .. ": mesh not readable, copied as a box")
			end
		else
			table.insert(skipped, pathOf(part) .. ": " .. part.ClassName .. " copied as a box")
		end
		table.insert(parts, entry)
	end

	for _, root in roots do
		if root:IsA("BasePart") then
			add(root)
		end
		for _, d in root:GetDescendants() do
			if d:IsA("BasePart") then
				add(d)
			end
		end
	end
	return { parts = parts, skipped = skipped }
end

---------------------------------------------------------------- rigs and animation

-- Joint tree of a rig model: { root, joints = { {name, part0, part1, c0, c1} } }
-- ordered parent-first. Classic rigs use Motor6D (Part1 = Part0 * C0 * T * C1^-1);
-- current Roblox avatars use AnimationConstraint between two attachments, which
-- is the same math with C0/C1 taken from the attachments' CFrames.
local function rigJoints(model: Instance)
	local joints = {}
	local isChild = {}
	local function add(name, part0, part1, c0, c1)
		if part0 and part1 and part0:IsA("BasePart") and part1:IsA("BasePart")
			and part0:IsDescendantOf(model) and part1:IsDescendantOf(model) and not isChild[part1] then
			table.insert(joints, { name = name, part0 = part0, part1 = part1, c0 = c0, c1 = c1 })
			isChild[part1] = true
		end
	end
	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			add(d.Name, d.Part0, d.Part1, d.C0, d.C1)
		end
	end
	for _, d in model:GetDescendants() do
		if d:IsA("AnimationConstraint") then
			local a0, a1 = (d :: any).Attachment0, (d :: any).Attachment1
			if a0 and a1 then
				add(d.Name, a0.Parent, a1.Parent, a0.CFrame, a1.CFrame)
			end
		end
	end
	if #joints == 0 then
		error(pathOf(model) .. " has no Motor6D or AnimationConstraint joints; it isn't a rig", 0)
	end
	local root = (model :: any).PrimaryPart
	if not root or isChild[root] then
		root = nil
		for _, j in joints do
			if not isChild[j.part0] then
				root = j.part0
				break
			end
		end
	end
	local byParent = {}
	for _, j in joints do
		byParent[j.part0] = byParent[j.part0] or {}
		table.insert(byParent[j.part0], j)
	end
	local ordered = {}
	local function walk(part)
		for _, j in byParent[part] or {} do
			table.insert(ordered, j)
			walk(j.part1)
		end
	end
	walk(root)
	return root, ordered
end

function Commands.export_rig(args)
	local model = resolve(args.path)
	local root, motors = rigJoints(model)
	local names = {}
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			if names[d.Name] then
				error("Rig has two parts named " .. d.Name .. "; part names must be unique to map bones", 0)
			end
			names[d.Name] = true
		end
	end
	local exported = Commands.export_parts({ paths = { args.path } })
	local joints = {}
	for _, j in motors do
		table.insert(joints, {
			name = j.name,
			part0 = j.part0.Name,
			part1 = j.part1.Name,
			c0 = { j.c0:GetComponents() },
			c1 = { j.c1:GetComponents() },
		})
	end
	return {
		rig = { name = model.Name, path = pathOf(model), root = root.Name, parts = exported.parts, joints = joints },
		skipped = exported.skipped,
	}
end

local function cframeFrom(c): CFrame
	return CFrame.new(table.unpack(c))
end

-- Save keyframes ({time, poses = {partName = cframe12}}) as a KeyframeSequence
-- where the Animation Editor finds it: ServerStorage.RBX_ANIMSAVES.<rig>.
function Commands.save_animation(args)
	local model = resolve(args.rig)
	local root, motors = rigJoints(model)
	local children = {}
	for _, j in motors do
		children[j.part0.Name] = children[j.part0.Name] or {}
		table.insert(children[j.part0.Name], j.part1.Name)
	end

	return recorded("save animation " .. args.name, function()
		local kfs = Instance.new("KeyframeSequence")
		kfs.Name = args.name
		kfs.Loop = args.loop == true
		if args.priority then
			kfs.Priority = (Enum.AnimationPriority :: any)[args.priority]
		end
		for _, kf in args.keyframes do
			local keyframe = Instance.new("Keyframe")
			keyframe.Time = kf.time
			local function addPose(parent: Instance, partName: string)
				local pose = Instance.new("Pose")
				pose.Name = partName
				local cf = kf.poses[partName]
				pose.CFrame = if cf then cframeFrom(cf) else CFrame.identity
				pose.Weight = if cf or partName == root.Name then 1 else 0
				pose.Parent = parent
				for _, childName in children[partName] or {} do
					addPose(pose, childName)
				end
			end
			addPose(keyframe, root.Name)
			keyframe.Parent = kfs
		end

		local ServerStorage = game:GetService("ServerStorage")
		local saves = ServerStorage:FindFirstChild("RBX_ANIMSAVES")
		if not saves then
			saves = Instance.new("Model")
			saves.Name = "RBX_ANIMSAVES"
			saves.Parent = ServerStorage
		end
		local holder = saves:FindFirstChild(model.Name)
		if not holder then
			holder = Instance.new("ObjectValue")
			holder.Name = model.Name
			;(holder :: ObjectValue).Value = model
			holder.Parent = saves
		end
		local old = holder:FindFirstChild(args.name)
		if old and old:IsA("KeyframeSequence") then
			old.Parent = nil
		end
		kfs.Parent = holder

		local previewId = nil
		pcall(function()
			previewId = game:GetService("AnimationClipProvider"):RegisterKeyframeSequence(kfs)
		end)
		return { saved = pathOf(kfs), keyframes = #args.keyframes, previewAnimationId = previewId }
	end)
end

-- Read a KeyframeSequence (instance path or asset id) into keyframes by part name.
function Commands.read_animation(args)
	local kfs: Instance
	if args.assetId then
		kfs = game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync("rbxassetid://" .. tostring(args.assetId))
	else
		kfs = resolve(args.path)
		if kfs:IsA("Animation") then
			kfs = game:GetService("KeyframeSequenceProvider")
				:GetKeyframeSequenceAsync((kfs :: Animation).AnimationId)
		end
	end
	if not kfs:IsA("KeyframeSequence") then
		error(pathOf(kfs) .. " is not a KeyframeSequence or Animation", 0)
	end
	local keyframes = {}
	for _, kf in kfs:GetChildren() do
		if kf:IsA("Keyframe") then
			local poses = {}
			for _, pose in kf:GetDescendants() do
				if pose:IsA("Pose") and pose.Weight > 0 then
					poses[pose.Name] = { pose.CFrame:GetComponents() }
				end
			end
			table.insert(keyframes, { time = kf.Time, poses = poses })
		end
	end
	table.sort(keyframes, function(a, b)
		return a.time < b.time
	end)
	return { name = kfs.Name, loop = (kfs :: KeyframeSequence).Loop, keyframes = keyframes }
end

-- Frame an effect for screenshots and fire its particle emitters.
function Commands.vfx_prepare(args)
	local target = resolve(args.path)
	local center: Vector3, size: Vector3
	if target:IsA("Model") then
		local cf, sz = (target :: Model):GetBoundingBox()
		center, size = cf.Position, sz
	elseif target:IsA("BasePart") then
		center, size = target.Position, target.Size
	elseif target:IsA("Attachment") then
		center, size = (target :: Attachment).WorldPosition, Vector3.new(4, 4, 4)
	elseif target.Parent and target.Parent:IsA("BasePart") then
		center, size = (target.Parent :: BasePart).Position, (target.Parent :: BasePart).Size
	elseif target.Parent and target.Parent:IsA("Attachment") then
		center, size = (target.Parent :: Attachment).WorldPosition, Vector3.new(4, 4, 4)
	else
		error("Can't find a position for " .. pathOf(target), 0)
	end
	local emitters = {}
	local list = { target }
	for _, d in target:GetDescendants() do
		table.insert(list, d)
	end
	for _, d in list do
		if d:IsA("ParticleEmitter") then
			local count = args.burst or math.max(10, math.floor((d :: ParticleEmitter).Rate * 0.5))
			pcall(function()
				(d :: ParticleEmitter):Emit(count)
			end)
			table.insert(emitters, pathOf(d))
		end
	end
	local distance = args.distance or math.max(size.Magnitude * 1.6, 8)
	local dir = Vector3.new(0.6, 0.35, 1).Unit
	local cam = center + dir * distance
	return {
		center = { center.X, center.Y, center.Z },
		camera = { cam.X, cam.Y, cam.Z },
		emitters = emitters,
	}
end

function Commands.insert_asset(args)
	local parent = resolve(args.parent or "Workspace")
	return recorded("insert asset " .. tostring(args.assetId), function()
		local InsertService = game:GetService("InsertService")
		local model = InsertService:LoadAsset(args.assetId)
		local inserted = {}
		for _, child in model:GetChildren() do
			child.Parent = parent
			table.insert(inserted, pathOf(child))
		end
		model:Destroy()
		return { inserted = inserted }
	end)
end

-- loadstring only works in the editor. Inside a running playtest it is
-- disabled, so compile through a throwaway ModuleScript instead.
local function compile(code: string): (...any) -> ...any
	local ok, fn, compileErr = pcall(loadstring, code, "=run_luau")
	if ok then
		if not fn then
			error("Compile error: " .. tostring(compileErr), 0)
		end
		return fn
	end
	local module = Instance.new("ModuleScript")
	module.Name = "StudioPilotChunk"
	module.Source = "return function(...)\n" .. code .. "\nend"
	local loaded, result = pcall(require, module)
	module:Destroy()
	if not loaded or type(result) ~= "function" then
		error("Compile error (line numbers are +1): " .. tostring(result), 0)
	end
	return result
end

function Commands.run_luau(args)
	local fn = compile(args.code)
	local output = {}
	local function capture(prefix: string)
		return function(...)
			local parts = table.pack(...)
			for i = 1, parts.n do
				parts[i] = tostring(parts[i])
			end
			table.insert(output, prefix .. table.concat(parts, "\t", 1, parts.n))
		end
	end
	local env = setmetatable({
		print = capture(""),
		warn = capture("[warn] "),
		plugin = plugin,
	}, { __index = getfenv(0) })
	setfenv(fn, env)

	local results
	local ok, err = pcall(function()
		results = recorded("run_luau", function()
			return table.pack(fn())
		end)
	end)
	local returned = {}
	if ok and results then
		for i = 1, results.n do
			returned[i] = encode(results[i])
		end
	end
	return {
		ok = ok,
		error = if ok then nil else tostring(err),
		output = table.concat(output, "\n"),
		returned = if #returned > 0 then returned else nil,
		context = CONTEXT,
	}
end

function Commands.get_output(args)
	local limit = args.limit or 100
	local out = {}
	for i = #logBuffer, 1, -1 do
		local e = logBuffer[i]
		local keep = true
		if args.errorsOnly and e.kind ~= "Error" and e.kind ~= "Warning" then
			keep = false
		end
		if keep and args.contains and not e.text:find(args.contains, 1, true) then
			keep = false
		end
		if keep then
			table.insert(out, 1, ("[%s] %s"):format(e.kind, e.text))
			if #out >= limit then
				break
			end
		end
	end
	if #out == 0 then
		return "(no output)"
	end
	return table.concat(out, "\n")
end

function Commands.start_playtest(args)
	if CONTEXT ~= "edit" then
		error("start_playtest must run in the editor", 0)
	end
	if RunService:IsRunning() then
		error("A playtest is already running", 0)
	end
	local StudioTestService = game:GetService("StudioTestService")
	local mode = args.mode or "play"
	task.spawn(function()
		local ok, err = pcall(function()
			if mode == "run" then
				StudioTestService:ExecuteRunModeAsync({})
			else
				StudioTestService:ExecutePlayModeAsync({})
			end
		end)
		if not ok then
			warn("[StudioPilot] playtest failed: " .. tostring(err))
		end
	end)
	return { started = mode }
end

function Commands.stop_playtest()
	local StudioTestService = game:GetService("StudioTestService")
	StudioTestService:EndTest({ stoppedBy = "StudioPilot" })
	return { stopped = true }
end

---------------------------------------------------------------- transport

local enabled = plugin:GetSetting("StudioPilot_Enabled")
if enabled == nil then
	enabled = true
end
local connected = false
local statusChanged = Instance.new("BindableEvent")
local alive = true

local function post(path: string, body: any, timeout: boolean?)
	return HttpService:RequestAsync({
		Url = BASE .. path,
		Method = "POST",
		Headers = { ["Content-Type"] = "application/json" },
		Body = HttpService:JSONEncode(body),
	})
end

local function setConnected(v: boolean)
	if connected ~= v then
		connected = v
		statusChanged:Fire()
	end
end

local function execute(cmd): { [string]: any }
	local handler = Commands[cmd.tool]
	local ok, result
	if handler then
		ok, result = pcall(handler, cmd.args or {})
	else
		ok, result = false, "Plugin does not support command " .. tostring(cmd.tool) .. " (update the plugin?)"
	end
	local payload = { id = cmd.id, ok = ok }
	if ok then
		payload.result = encode(result)
	else
		payload.error = tostring(result)
	end
	return payload
end

local function sendResult(payload)
	local sent, encodeErr = pcall(post, "/result", payload)
	if not sent then
		pcall(post, "/result", { id = payload.id, ok = false, error = "Could not send result: " .. tostring(encodeErr) })
	end
end

local function runCommand(cmd)
	sendResult(execute(cmd))
end

local pauseUntil = 0

-- Poll the bridge as `context`, handing each command to `handle`.
local function pollLoop(context: string, handle: (any) -> ())
	local backoff = 1
	while alive do
		if not enabled then
			setConnected(false)
			task.wait(1)
			continue
		end
		local ok, res = pcall(post, "/poll", {
			place = placeName(),
			context = context,
			version = VERSION,
		})
		if ok and res.Success then
			setConnected(true)
			backoff = 1
			local data = HttpService:JSONDecode(res.Body)
			for _, cmd in data.commands or {} do
				if cmd.tool == "pause_polling" then
					-- Handled inline so no new request starts before the pause:
					-- an HTTP request in flight while Play builds the server
					-- DataModel crashed Studio under Wine.
					pauseUntil = os.clock() + math.clamp(tonumber(cmd.args and cmd.args.seconds) or 10, 1, 60)
					sendResult({ id = cmd.id, ok = true, result = { pausedFor = cmd.args and cmd.args.seconds or 10 } })
				else
					task.spawn(handle, cmd)
				end
			end
			while alive and os.clock() < pauseUntil do
				task.wait(0.25)
			end
		else
			setConnected(false)
			task.wait(backoff)
			backoff = math.min(backoff * 2, 10)
		end
	end
end

plugin.Unloading:Connect(function()
	-- No HTTP here: a request while Studio tears the DataModel down crashed it.
	-- The bridge notices the dropped long-poll and forgets this studio.
	alive = false
end)

---------------------------------------------------------------- UI (editor only)

if CONTEXT == "edit" then
	local toolbar = plugin:CreateToolbar("StudioPilot")
	local button = toolbar:CreateButton(
		"StudioPilot",
		"Connect this place to the local AI bridge (127.0.0.1:" .. tostring(PORT) .. ")",
		"rbxasset://textures/AnimationEditor/icon_checkmark.png"
	)
	button.ClickableWhenViewportHidden = true

	local function refresh()
		button:SetActive(enabled and connected)
	end
	statusChanged.Event:Connect(function()
		refresh()
		if enabled then
			print(if connected then "[StudioPilot] Connected to bridge" else "[StudioPilot] Bridge not reachable; retrying")
		end
	end)
	button.Click:Connect(function()
		enabled = not enabled
		plugin:SetSetting("StudioPilot_Enabled", enabled)
		print("[StudioPilot] " .. (if enabled then "Enabled" else "Disabled"))
		refresh()
	end)
	refresh()
end

local function startTransport()
	startLogCapture()
	pollLoop("edit", runCommand)
end

task.spawn(startTransport)
