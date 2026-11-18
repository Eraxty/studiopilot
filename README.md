<div align="center">

<img src="docs/icon.png" width="96" alt="StudioPilot">

# StudioPilot

**AI that builds your Roblox game inside Studio. Free.**

Claude or GPT writes your scripts, builds parts, plays your game to test it, and models stuff in Blender.

[Download](https://github.com/Eraxty/studiopilot/releases/latest) · [Setup](#setup) · [What it can do](#what-it-can-do) · [vs Ropilot](#vs-ropilot)

</div>

---

## Why this exists

I used Ropilot. It's good, but it's paid, and I already pay for Claude. So I opened it up, looked at how it works, and built my own version from scratch.

Turns out Ropilot is mostly Claude Code plus a Studio plugin plus a chat app. StudioPilot does the same thing, and it's free. You bring your own Claude or ChatGPT subscription.

None of Ropilot's code is in here. I just used it as the idea.

## What it can do

**Studio**
- reads, writes and edits your scripts, and you see a diff of every change
- makes parts, models and GUIs, sets properties, moves stuff around
- runs Luau in the editor, or on the server or client while you play
- every change is one Ctrl+Z in Studio

**Playtesting**
- hits Play and Stop for you
- walks your character around, presses keys, clicks buttons
- takes screenshots and reads the output window
- a `roblox-playtester` agent that plays your game and tells you what's broken

**Blender**
- models in Blender, renders it from a few angles so the AI can actually see it
- sends models to Studio, and Studio parts to Blender
- pulls your R15 rig into Blender, animates it, sends the animation back to the Animation Editor
- saves a checkpoint before every change so you can undo

**More**
- AI mesh, texture, animation and avatar generation (Studio's own tools)
- captures particle effects frame by frame
- Claude or Codex (GPT), your pick per chat
- Rojo start and stop from the app

## The app

There's a desktop app if you don't want to use a terminal.

- projects and chats on the side
- pick Claude or GPT, the model, how hard it thinks, and plan mode
- approve or deny commands, answer its questions, review plans before it builds
- every script edit as a diff, and "Edit & rewind" puts your scripts back if it messed up
- a gallery with all the screenshots and renders
- paste images straight in
- keeps the Studio plugin up to date and tells you when a new version is out
- one-click MCP presets (a folder or Obsidian vault, a browser, memory)

## Setup

You need [Claude Code](https://code.claude.com) (or [Codex](https://github.com/openai/codex)) logged in, Node 20+, and Roblox Studio. Blender is optional.

**Using the app:** grab the AppImage from [Releases](https://github.com/Eraxty/studiopilot/releases/latest), run it, and follow the setup checklist it shows you.

**Using Claude Code directly:**

```sh
git clone https://github.com/Eraxty/studiopilot
cd studiopilot
npm run setup
```

That installs the Studio plugin and the playtester agent, and adds StudioPilot to Claude Code and Codex.

Then in Studio:

1. Open your place. When Studio asks if the plugin can use HTTP on `127.0.0.1`, say yes.
2. For the playtest and AI generation tools: Assistant panel → `...` → MCP Servers → turn on **Enable Studio as MCP server**.

On Linux it works with [Vinegar](https://vinegarhq.org). The plugin goes into Vinegar's Wine prefix automatically.

## vs Ropilot

| | Ropilot | StudioPilot |
| --- | --- | --- |
| Price | paid credits | free, uses your own Claude/ChatGPT plan |
| Script editing with diffs | yes | yes |
| Playtesting (input, screenshots) | yes | yes, through Studio's built-in MCP |
| Blender modeling, rigs, animations | yes | yes |
| Desktop app | yes | yes |
| Works in plain Claude Code too | no | yes |
| Open source | no | yes |
| Undo for Blender changes | yes | yes |
| Cloud chat sync | yes | no, chats stay on your PC |

It's not a 1:1 copy, I built it my own way. The input and screenshot tools go through Roblox's own MCP and I haven't tested those much yet. If something breaks, open an issue.

## How it works

```
Claude Code / Codex ──MCP──> bridge ──HTTP──> Studio plugin
                               ├──WebSocket──> Studio's built-in MCP
                               └──HTTP───────> Blender adapter
```

- `plugin/StudioPilot.lua` is the Studio plugin. It asks the bridge for work and runs it.
- `bridge/` is the MCP server Claude talks to. No npm packages.
- `blender/` runs inside Blender.
- `app/` is the desktop app (Electron).

## Uploading models to Roblox

Sending Blender models into Studio needs a free Open Cloud API key with **Assets: Read & Write**. Make one at [create.roblox.com](https://create.roblox.com/dashboard/credentials) and paste it in the app's settings, or put it in `~/.config/studiopilot/config.json`:

```json
{ "robloxApiKey": "...", "creator": { "userId": "123456" } }
```

## Development

```sh
npm test              # bridge, Studio MCP relay and Blender, no Roblox needed
npm run test:live     # every tool against a real Studio (use a scratch place)
cd app && npm start   # run the app from source
cd app && npm run dist  # build the AppImage
```

## License

MIT
