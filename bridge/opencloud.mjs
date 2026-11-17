// Uploads files to Roblox through the Open Cloud Assets API, so Blender models
// and images can be inserted into Studio.
//
// Needs an Open Cloud API key with the "Assets: Read & Write" permission:
//   https://create.roblox.com/dashboard/credentials
// Configure it in ~/.config/studiopilot/config.json:
//   { "robloxApiKey": "...", "creator": { "userId": "123" } }   (or "groupId")
// or with STUDIOPILOT_ROBLOX_API_KEY / STUDIOPILOT_ROBLOX_USER_ID / STUDIOPILOT_ROBLOX_GROUP_ID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://apis.roblox.com/assets/v1';

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === 'win32' ? process.env.APPDATA : path.join(os.homedir(), '.config'));
  return path.join(base, 'studiopilot', 'config.json');
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  const apiKey = process.env.STUDIOPILOT_ROBLOX_API_KEY || cfg.robloxApiKey;
  const creator = process.env.STUDIOPILOT_ROBLOX_GROUP_ID
    ? { groupId: process.env.STUDIOPILOT_ROBLOX_GROUP_ID }
    : process.env.STUDIOPILOT_ROBLOX_USER_ID
      ? { userId: process.env.STUDIOPILOT_ROBLOX_USER_ID }
      : cfg.creator;
  if (!apiKey || !creator) {
    throw new Error(
      `Uploading to Roblox needs an Open Cloud API key (Assets read+write) and a creator id. ` +
      `Create a key at https://create.roblox.com/dashboard/credentials, then put ` +
      `{"robloxApiKey": "...", "creator": {"userId": "<your user id>"}} in ${configPath()}.`,
    );
  }
  return { apiKey, creator };
}

const TYPES = {
  '.fbx': { assetType: 'Model', mime: 'model/fbx' },
  '.obj': { assetType: 'Model', mime: 'model/obj' },
  '.gltf': { assetType: 'Model', mime: 'model/gltf+json' },
  '.glb': { assetType: 'Model', mime: 'model/gltf-binary' },
  '.png': { assetType: 'Decal', mime: 'image/png' },
  '.jpg': { assetType: 'Decal', mime: 'image/jpeg' },
  '.jpeg': { assetType: 'Decal', mime: 'image/jpeg' },
  '.bmp': { assetType: 'Decal', mime: 'image/bmp' },
  '.tga': { assetType: 'Decal', mime: 'image/tga' },
  '.mp3': { assetType: 'Audio', mime: 'audio/mpeg' },
  '.ogg': { assetType: 'Audio', mime: 'audio/ogg' },
};

/** Upload a local file and wait for Roblox to finish processing it. */
export async function uploadAsset({ filePath, name, description = 'Uploaded by StudioPilot' }) {
  const { apiKey, creator } = loadConfig();
  const ext = path.extname(filePath).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new Error(`Can't upload ${ext} files (supported: ${Object.keys(TYPES).join(' ')})`);

  const form = new FormData();
  form.append('request', JSON.stringify({
    assetType: type.assetType,
    displayName: (name || path.basename(filePath, ext)).slice(0, 50),
    description,
    creationContext: { creator },
  }));
  form.append('fileContent', new Blob([fs.readFileSync(filePath)], { type: type.mime }), path.basename(filePath));

  const res = await fetch(`${API}/assets`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Roblox upload failed (HTTP ${res.status}): ${JSON.stringify(body)}`);

  let op = body;
  const opPath = op.path || `operations/${op.operationId}`;
  const deadline = Date.now() + 120_000;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error(`Roblox is still processing the upload (${opPath}); try insert_asset later.`);
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${API}/${opPath}`, { headers: { 'x-api-key': apiKey } });
    op = await poll.json();
  }
  if (op.error) throw new Error(`Roblox rejected the asset: ${JSON.stringify(op.error)}`);
  const assetId = Number(op.response?.assetId);
  if (!assetId) throw new Error(`Upload finished without an asset id: ${JSON.stringify(op)}`);
  return { assetId, assetType: type.assetType, moderation: op.response?.moderationResult?.moderationState };
}
