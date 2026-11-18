// Upload assets with the user's own Studio login, through Studio's built-in
// open_cloud_invoke tool. No Open Cloud API key needed. Roblox requires the
// file's folder to be approved once in Studio: Assistant settings -> MCP
// Permissions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callStudioMcpTool, studioMcpTools } from './studio-mcp.mjs';

/** Folder StudioPilot exports into; approve this one folder in Studio once. */
export function exportDir() {
  const dir = process.env.STUDIOPILOT_EXPORT_DIR || path.join(os.homedir(), 'StudioPilot', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function canUploadViaStudio() {
  return studioMcpTools().some((t) => t.name === 'roblox_open_cloud_invoke');
}

// Studio on Linux runs under Wine and sees the host filesystem as drive Z:.
function studioPath(p) {
  if (process.platform !== 'linux') return p;
  return `Z:${p.replace(/\//g, '\\')}`;
}

function parseInvoke(res) {
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (res.isError) throw new Error(text || 'open_cloud_invoke failed');
  const status = Number((text.match(/status(?:\s*code)?["\s:]*(\d{3})/i) || [])[1] || 200);
  const start = text.indexOf('{');
  let body = null;
  if (start >= 0) {
    try { body = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch {}
  }
  if (status >= 400) {
    throw new Error(
      `Roblox answered ${status}: ${text.slice(0, 400)}\n` +
      'If this is a permissions error, open Studio > Assistant > ... > MCP Permissions and allow asset uploads ' +
      `and the folder ${exportDir()}.`,
    );
  }
  return body;
}

const TYPES = { '.fbx': 'Model', '.glb': 'Model', '.gltf': 'Model', '.rbxm': 'Model', '.rbxmx': 'Model', '.png': 'Decal', '.jpg': 'Decal', '.jpeg': 'Decal', '.tga': 'Decal', '.bmp': 'Decal', '.mp3': 'Audio', '.ogg': 'Audio', '.wav': 'Audio', '.flac': 'Audio' };

/**
 * Upload `filePath` (copied into the approved export folder if needed) as the
 * Studio user. `userId` comes from the plugin (StudioService:GetUserId()).
 */
export async function uploadViaStudio({ filePath, name, userId }) {
  const ext = path.extname(filePath).toLowerCase();
  const assetType = TYPES[ext];
  if (!assetType) throw new Error(`Can't upload ${ext} files through Studio`);
  let local = filePath;
  if (path.dirname(path.resolve(filePath)) !== path.resolve(exportDir())) {
    local = path.join(exportDir(), path.basename(filePath));
    fs.copyFileSync(filePath, local);
  }
  const created = parseInvoke(await callStudioMcpTool('roblox_open_cloud_invoke', {
    method: 'POST',
    endpoint: '/assets/v1/assets',
    scopes: ['asset:read', 'asset:write'],
    body: JSON.stringify({
      request: {
        assetType,
        displayName: (name || path.basename(local, ext)).slice(0, 50),
        description: 'Made with StudioPilot',
        creationContext: { creator: { userId: String(userId) } },
      },
    }),
    files: [{ name: 'fileContent', path: studioPath(local) }],
  }));
  let op = created || {};
  const opPath = op.path || (op.operationId ? `operations/${op.operationId}` : null);
  if (!opPath) throw new Error(`Upload started but Roblox returned no operation: ${JSON.stringify(created).slice(0, 300)}`);
  const deadline = Date.now() + 120_000;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error(`Roblox is still processing ${opPath}; try insert_asset later.`);
    await new Promise((r) => setTimeout(r, 2000));
    op = parseInvoke(await callStudioMcpTool('roblox_open_cloud_invoke', {
      method: 'GET', endpoint: `/assets/v1/${opPath}`, scopes: ['asset:read'],
    })) || {};
  }
  if (op.error) throw new Error(`Roblox rejected the asset: ${JSON.stringify(op.error)}`);
  const assetId = Number(op.response?.assetId);
  if (!assetId) throw new Error(`Upload finished without an asset id: ${JSON.stringify(op).slice(0, 300)}`);
  return { assetId, assetType, via: 'studio-login', moderation: op.response?.moderationResult?.moderationState };
}
