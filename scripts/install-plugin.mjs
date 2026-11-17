#!/usr/bin/env node
// Copies the StudioPilot plugin into Roblox Studio's local Plugins folder.
// Handles Windows, macOS, and Linux via Vinegar (Flatpak or native).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginTarget } from './plugin-paths.mjs';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'StudioPilot.lua');
const target = process.argv[2] || pluginTarget();
fs.mkdirSync(target, { recursive: true });
const dest = path.join(target, 'StudioPilot.lua');
fs.copyFileSync(src, dest);
console.log(`Installed plugin -> ${dest}`);
console.log('Restart Roblox Studio (or open a new place) to pick it up.');
