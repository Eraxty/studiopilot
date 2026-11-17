// Where Roblox Studio looks for local plugins on this machine, best guess first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function pluginFolders() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Roblox', 'Plugins')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Documents', 'Roblox', 'Plugins')];
  // Linux: Studio runs in Vinegar's Wine prefix and reads the Wine user's
  // %LOCALAPPDATA%\Roblox\Plugins (vinegar/appdata only holds logs and settings).
  const user = os.userInfo().username;
  const roots = [
    path.join(home, '.var/app/org.vinegarhq.Vinegar/data/vinegar'),
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'vinegar'),
  ];
  return roots.map((r) => path.join(r, 'prefixes/studio/drive_c/users', user, 'AppData/Local/Roblox/Plugins'));
}

/** The folder to install into: one whose Roblox parent exists, else the first guess. */
export function pluginTarget() {
  const dirs = pluginFolders();
  return dirs.find((d) => fs.existsSync(path.dirname(d))) || dirs[0];
}
