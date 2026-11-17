# StudioPilot

StudioPilot lets Claude Code, Codex or any other MCP client work inside Roblox Studio and Blender. It can read and edit scripts, build instances, run Luau, playtest the game with real keyboard and mouse input, model in Blender, and move models between Blender and Studio.

It has four parts:

- `plugin/StudioPilot.lua` is a Studio plugin. It long-polls a local HTTP server for commands and posts the results back.
- `bridge/server.mjs` is an MCP server over stdio with no dependencies. The first copy that starts binds `127.0.0.1:8766`, and any copy started after it forwards its calls to that first one. That lets several agent sessions share one Studio. If the first session closes, another takes over the port.
- The same bridge also hosts `ws://localhost:13469/studio`, where Studio's own built-in MCP server connects. Its tools show up as `roblox_*`. This replaces Roblox's `StudioMCP.exe`, so don't run both.
- `blender/studiopilot_adapter.py` runs inside Blender and takes commands on `127.0.0.1:8767`. The bridge starts Blender with it when a `blender_*` tool needs it.

```
Claude Code / Codex ──stdio MCP──> bridge ──HTTP long-poll──> Studio plugin (edit / server / client)
                                     ├────WebSocket :13469──> Studio built-in MCP (roblox_*)
                                     └────HTTP :8767────────> Blender adapter
```

During a playtest Studio loads the plugin into the server and client DataModels as well. That's why `run_luau`, `get_output` and `list_children` take a `context` argument. Roblox blocks HTTP from the playtest client, so the server half of the plugin relays client commands over a RemoteEvent. `loadstring` is also off inside a playtest, so `run_luau` falls back to compiling through a throwaway ModuleScript.

## Desktop app

`app/` is a desktop chat app, if you'd rather not work in a terminal. It runs Claude Code or Codex for you with the StudioPilot tools already connected:

- Projects (one folder per game) with any number of chats each
- Claude or Codex per chat, with model, effort and plan mode in the composer
- Streaming replies, thinking, and tool calls grouped into collapsible rows
- Approve/deny cards for shell commands, question cards and plan review
- Script edits shown as diffs. "Edit & rewind" on a message puts the scripts back, drops the later messages and lets you edit and resend.
- A side panel with all diffs, a gallery of screenshots, renders and VFX frames, and Studio/Blender/Rojo controls
- Image paste and drop, a message queue, slash commands (`/new`, `/plan`, `/model`, `/effort`, `/playtest`, `/compact`)
- Settings for default models, auto-approve, custom instructions, Roblox upload key, Blender path, skills (install from GitHub) and extra MCP servers
- A setup checklist on first run: Claude/Codex installed and logged in, plugin installed, Studio connected

```sh
cd app
npm install
npm start              # run from source
npm run dist           # build dist/StudioPilot-<version>.AppImage
```

The app starts the bridge in the background if it isn't running. Your login stays with Claude Code and Codex, and the app never sees your credentials.

## Setup

You need Node 20 or newer, and Blender 4.2 or newer for the Blender tools.

```sh
npm run setup
```

This copies the plugin into Studio's Plugins folder and installs the `roblox-playtester` agent into `~/.claude/agents`. It also registers the bridge with Claude Code and Codex if they're installed. Run it again after updating.

On Linux the plugin goes into Vinegar's Wine prefix (`prefixes/studio/drive_c/users/$USER/AppData/Local/Roblox/Plugins`). To use another folder, run `node scripts/install-plugin.mjs <folder>`.

Open a place in Studio. The first time, Studio asks whether the plugin may make HTTP requests to `127.0.0.1`. Say yes. "Connected to bridge" then shows up in Output. The StudioPilot toolbar button pauses or resumes the connection.

For the `roblox_*` tools, open the Assistant panel, go to `...` > MCP Servers and turn on "Enable Studio as MCP server". Studio reconnects to the bridge every few seconds by itself.

## Tools

| Area | Tools |
| --- | --- |
| Inspect | `get_studio_info`, `list_children`, `get_properties`, `search_instances`, `get_selection`, `set_selection` |
| Scripts | `read_script`, `edit_script` (exact find/replace), `write_script`, `create_script`, `grep_scripts` |
| Instances | `create_instance`, `set_properties`, `delete_instances`, `move_instance`, `insert_asset` |
| Run | `run_luau`, `get_output`, `start_playtest`, `stop_playtest` |
| Blender | `blender_start`, `blender_scene`, `blender_run_python`, `blender_render`, `blender_save`, `studio_to_blender`, `blender_to_studio`, `upload_asset` |
| Studio built-in | `roblox_user_keyboard_input`, `roblox_user_mouse_input`, `roblox_character_navigation`, `roblox_screen_capture`, `roblox_start_stop_play`, `roblox_generate_mesh`, `roblox_generate_animation`, `roblox_generate_avatar`, `roblox_search_asset`, `roblox_open_cloud_invoke` and about 25 more |
| Bridge | `list_studios`, `set_active_studio` |

Paths are dot paths from `game`, like `Workspace.Map.Door`. If a name has a dot in it, use brackets: `Workspace["v1.2"].Part`. Every edit in the editor is one ChangeHistory step, so Ctrl+Z undoes it. Deleted instances get their parent set to nil and are not destroyed, so undo can bring them back.

Property values are sent as JSON. A Vector3 is `[x, y, z]`, a color can be `"#ff8800"`, an enum is `"Enum.Material.Neon"`, and an instance reference is `{"Instance": "Workspace.Part"}`. `tools.mjs` lists the rest.

The bridge hides three of Studio's built-in tools: `submit_feedback`, `create_skill` and `edit_skill`. They send or publish things outside your place.

## Playtesting

Ask Claude to "use the roblox-playtester agent to check that the shop GUI works". The agent starts a playtest, walks the character around, presses keys, clicks GUI, takes screenshots and reads values on the server and client. Then it reports pass or fail for each check, with evidence.

## Blender

`blender_render` renders the model from several angles and hands the images back, so the agent can look at what it built. In a Blender window it uses Workbench. Headless Blender has no GPU context here, so it uses a few CPU Cycles samples.

`studio_to_blender` copies parts with their size, position and color. It reads MeshPart geometry through EditableMesh when Roblox allows that for the mesh. Otherwise the MeshPart comes over as a box. Axes are converted from Roblox (Y-up) to Blender (Z-up), and the FBX export converts them back.

`blender_to_studio` and `upload_asset` upload through the Open Cloud Assets API. They need an API key with Assets read and write permission:

```json
// ~/.config/studiopilot/config.json
{ "robloxApiKey": "...", "creator": { "userId": "123456" } }
```

Uploads go through Roblox moderation before Studio can insert them. Images can also go up without a key through `roblox_upload_image`, which uses your Studio login.

## Config

- `STUDIOPILOT_PORT` sets the bridge port (default 8766). If you change it, also change the plugin setting `StudioPilot_Port`.
- `STUDIOPILOT_STUDIO_MCP_PORT` (default 13469) and `STUDIOPILOT_BLENDER_PORT` (default 8767) set the other two ports. `STUDIOPILOT_BLENDER_PATH` points at a Blender that isn't on PATH.
- `npm run hub` runs the bridge without the stdio side. Use it to keep the ports up between agent sessions.
- `npm test` runs the bridge against a fake plugin, a fake Studio built-in MCP and headless Blender. Roblox isn't needed.
- `npm run test:live` runs the plugin tools against a real Studio. Start `npm run hub` first and use a scratch place, because it creates and deletes test objects.
