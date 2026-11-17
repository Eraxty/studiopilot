// Small JSON-file persistence for settings, projects and chats.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.chatDir = path.join(dir, 'chats');
    this.imageDir = path.join(dir, 'images');
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.mkdirSync(this.imageDir, { recursive: true });
  }

  #read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch { return fallback; }
  }

  #write(file, data) {
    const target = path.join(this.dir, file);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, target); // atomic, so a crash never leaves half a file
  }

  settings() {
    return {
      engine: 'claude',
      claudeModel: 'claude-opus-5-5',
      codexModel: '',
      effort: 'high',
      autoApprove: false,
      customPrompt: '',
      blenderPath: '',
      theme: 'dark',
      ...this.#read('settings.json', {}),
    };
  }

  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    this.#write('settings.json', next);
    return next;
  }

  projects() { return this.#read('projects.json', []); }
  saveProjects(list) { this.#write('projects.json', list); }

  chat(id) { return this.#read(path.join('chats', `${id}.json`), null); }
  saveChat(chat) { this.#write(path.join('chats', `${chat.id}.json`), chat); }
  deleteChat(id) { fs.rmSync(path.join(this.chatDir, `${id}.json`), { force: true }); }

  chatList() {
    const out = [];
    for (const f of fs.readdirSync(this.chatDir)) {
      if (!f.endsWith('.json')) continue;
      const c = this.#read(path.join('chats', f), null);
      if (c) out.push({ id: c.id, projectId: c.projectId, title: c.title, engine: c.engine, updatedAt: c.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Save a base64 image to disk; returns a file path the UI can load. */
  saveImage(data, mediaType = 'image/png') {
    const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const file = path.join(this.imageDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}
