/* StudioPilot desktop UI. Plain DOM; all data comes from the main process over window.sp. */
(() => {
  const api = (m, a) => window.sp.api(m, a);
  const $ = (s) => document.querySelector(s);

  // ------------------------------------------------------------ tiny DOM helper
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only ever given sanitized markdown
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  marked.use({ gfm: true, breaks: false });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener'); }
  });
  const md = (text) => h('div', { class: 'md', html: DOMPurify.sanitize(marked.parse(text || '')) });
  const fileUrl = (p) => {
    const slashed = p.replace(/\\/g, '/');
    return 'file://' + (/^[A-Za-z]:/.test(slashed) ? '/' : '') + encodeURI(slashed).replace(/#/g, '%23');
  };

  function toast(text, bad = false) {
    const t = h('div', { class: `toast${bad ? ' bad' : ''}` }, text);
    $('#toast-root').append(t);
    setTimeout(() => t.remove(), bad ? 7000 : 3500);
  }
  async function safe(fn) {
    try { return await fn(); } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, ''), true); return undefined; }
  }

  // ------------------------------------------------------------ state
  const S = {
    settings: null,
    projects: [],
    chatList: [],
    chat: null, // full current chat
    claudeModels: [],
    status: null,
    attachments: [], // { data, mediaType, url }
    open: new Set(), // expanded tool groups / diffs, kept across re-renders
    gallery: new Map(), // chatId -> [{path, tool}]
    rojoLog: [],
  };

  // ------------------------------------------------------------ sidebar
  function renderSidebar() {
    const nav = $('#projects');
    nav.replaceChildren();
    for (const p of S.projects) {
      const chats = S.chatList.filter((c) => c.projectId === p.id);
      nav.append(h('div', { class: 'project' },
        h('div', { class: 'project-head', title: p.dir },
          h('span', { class: 'name' }, p.name),
          h('button', { class: 'icon-btn', title: 'New chat in this project', onclick: () => newChat(p.id) }, '+'),
          h('button', { class: 'icon-btn', title: 'Remove project (chats are deleted, files are kept)', onclick: () => removeProject(p) }, '×')),
        chats.map((c) => h('div', {
          class: `chat-item${S.chat?.id === c.id ? ' active' : ''}`,
          onclick: () => openChat(c.id),
        },
        h('span', { class: 't' }, c.title || 'New chat'),
        c.busy ? h('span', { class: 'busy', title: 'Working' }) : null,
        h('button', { class: 'icon-btn del', title: 'Delete chat', onclick: (e) => { e.stopPropagation(); deleteChat(c); } }, '×'))),
      ));
    }
    nav.append(h('div', { class: 'add-project', onclick: addProject }, '+ Add game folder'));
  }

  function renderStatus() {
    const st = S.status;
    const dots = $('#status-dots');
    dots.replaceChildren();
    if (!st) return;
    const item = (label, cls, title) => h('span', { title }, h('span', { class: `dot ${cls}` }), label);
    dots.append(
      item('Studio', st.studio.connected ? 'ok' : st.hub.running ? 'warn' : 'bad', st.studio.connected ? 'Plugin connected' : 'Open a place in Studio with the StudioPilot plugin'),
      item('Studio MCP', st.builtInMcp.connected ? 'ok' : 'warn', st.builtInMcp.connected ? "Studio's built-in tools are connected" : 'Turn on "Enable Studio as MCP server" in Studio\'s Assistant settings'),
      item('Blender', st.blender.path ? 'ok' : 'warn', st.blender.path || 'Blender not found'),
      item('Rojo', S.rojoRunning ? 'ok' : '', S.rojoRunning ? 'Rojo is serving' : 'Rojo not running'),
    );
    if ($('#tab-studio') && !$('#tab-studio').classList.contains('hidden')) renderStudioTab();
  }

  async function refreshList() {
    S.chatList = await api('chatList');
    if (S.chat) {
      const busy = new Set(S.chatList.filter((c) => c.id === S.chat.id && isBusy(S.chat)).map((c) => c.id));
      for (const c of S.chatList) c.busy = busy.has(c.id);
    }
    renderSidebar();
  }

  async function addProject() {
    const p = await safe(() => api('addProject'));
    if (!p) return;
    S.projects.push(p);
    await newChat(p.id);
  }
  async function removeProject(p) {
    if (!(await confirmBox(`Remove "${p.name}" from StudioPilot? Its chats are deleted. Files in ${p.dir} stay.`))) return;
    S.projects = await api('removeProject', { id: p.id });
    if (S.chat?.projectId === p.id) S.chat = null;
    await refreshList();
    renderChat();
  }
  async function deleteChat(c) {
    if (!(await confirmBox(`Delete the chat "${c.title}"?`))) return;
    await api('deleteChat', { chatId: c.id });
    if (S.chat?.id === c.id) S.chat = null;
    await refreshList();
    renderChat();
  }

  async function newChat(projectId) {
    projectId = projectId || S.chat?.projectId || S.projects[0]?.id;
    const engine = $('#engine-select').value || S.settings.engine;
    const chat = await safe(() => api('createChat', { projectId, engine }));
    if (!chat) return;
    S.chat = chat;
    await refreshList();
    renderChat();
    $('#input').focus();
  }

  async function openChat(id) {
    S.chat = await api('getChat', { id });
    renderSidebar();
    renderChat();
  }

  // ------------------------------------------------------------ chat rendering
  const isBusy = (chat) => !!chat?.messages?.some((m) => m.role === 'assistant' && !m.done);

  const TOOL_LABELS = {
    run_luau: 'Run Luau', read_script: 'Read script', edit_script: 'Edit script', write_script: 'Write script', create_script: 'Create script',
    grep_scripts: 'Search scripts', list_children: 'List children', get_properties: 'Get properties', set_properties: 'Set properties',
    create_instance: 'Create instance', delete_instances: 'Delete', move_instance: 'Move', search_instances: 'Search instances',
    start_playtest: 'Start playtest', stop_playtest: 'Stop playtest', get_output: 'Read output', get_studio_info: 'Studio info',
    blender_run_python: 'Blender Python', blender_render: 'Render in Blender', blender_to_studio: 'Blender → Studio', studio_to_blender: 'Studio → Blender',
    blender_import_rig: 'Import rig', blender_export_animation: 'Export animation', blender_import_animation: 'Import animation', vfx_capture: 'Capture VFX',
  };
  function toolInfo(name) {
    const short = name.replace(/^mcp__[\w-]+__/, '');
    let cat = 'tool';
    if (/^mcp__studiopilot__/.test(name)) cat = short.startsWith('blender') || short.includes('blender') ? 'blender' : short.startsWith('roblox_') ? 'studio' : /playtest|output|vfx/.test(short) ? 'test' : 'studio';
    else if (/^(Bash|Shell)$/.test(name)) cat = 'shell';
    else if (/^(Read|Edit|Write|Glob|Grep|MultiEdit|NotebookEdit)$/.test(name)) cat = 'files';
    else if (name === 'Task' || name === 'Agent') cat = 'agent';
    const label = TOOL_LABELS[short] || short.replace(/^roblox_/, '').replace(/_/g, ' ');
    return { label, cat };
  }
  function argSummary(input) {
    if (!input || typeof input !== 'object') return '';
    for (const k of ['path', 'command', 'code', 'pattern', 'query', 'file_path', 'description', 'name', 'prompt', 'textPrompt', 'paths', 'objects']) {
      if (input[k] != null) return String(Array.isArray(input[k]) ? input[k].join(', ') : input[k]).split('\n')[0].slice(0, 140);
    }
    const s = JSON.stringify(input);
    return s === '{}' ? '' : s.slice(0, 140);
  }

  function lightbox(src) {
    const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src }));
    document.body.append(lb);
  }

  function renderTool(b, key) {
    const { label, cat } = toolInfo(b.name);
    const open = S.open.has(key);
    const row = h('div', { class: 'tool-row', onclick: () => { open ? S.open.delete(key) : S.open.add(key); renderChat(); } },
      h('span', { class: `st ${b.status}` }),
      h('span', { class: `tool-cat ${cat}` }, cat),
      h('span', { class: 'tname' }, label),
      h('span', { class: 'targ' }, argSummary(b.input)));
    const wrap = h('div', {}, row);
    if (open) {
      wrap.append(h('div', { class: 'tool-detail' },
        h('pre', {}, JSON.stringify(b.input, null, 2)),
        b.result ? h('pre', {}, b.result) : null));
    }
    if (b.images?.length) wrap.append(h('div', { class: 'thumbs' }, b.images.map((p) => h('img', { src: fileUrl(p), onclick: () => lightbox(fileUrl(p)) }))));
    return wrap;
  }

  function renderChange(b, key) {
    const { lines, added, removed } = spDiff.diffLines(b.before, b.after);
    const open = S.open.has(key);
    const card = h('div', { class: 'card' },
      h('div', { class: 'change-head', onclick: () => { open ? S.open.delete(key) : S.open.add(key); renderChat(); } },
        h('span', {}, b.created ? 'Created' : 'Edited'),
        h('span', { class: 'p' }, b.path),
        h('span', { class: 'plus' }, `+${added}`),
        h('span', { class: 'minus' }, `−${removed}`)));
    if (open) {
      card.append(h('div', { class: 'diff' }, lines.map(([t, l]) => h('div', { class: t === '+' ? 'a' : t === '-' ? 'd' : t === '@' ? 'h' : '' }, t === '@' ? l : `${t === ' ' ? ' ' : t} ${l}`))));
    }
    return card;
  }

  function renderPermission(b) {
    const pending = b.status === 'pending';
    const respond = (answer) => safe(() => api('respond', { chatId: S.chat.id, requestId: b.requestId, answer }));
    const { label } = toolInfo(b.toolName);
    return h('div', { class: `card${pending ? ' attention' : ''}` },
      h('h4', {}, pending ? `Allow ${label}?` : `${label}: ${b.status}`),
      b.description ? h('div', { class: 'muted' }, b.description) : null,
      h('pre', {}, b.input?.command || JSON.stringify(b.input, null, 2)),
      pending ? h('div', { class: 'row' },
        h('button', { class: 'btn primary small', onclick: () => respond({ allow: true }) }, 'Allow'),
        b.suggestions?.length ? h('button', { class: 'btn small', onclick: () => respond({ allow: true, always: true }) }, 'Always allow') : null,
        h('button', { class: 'btn small', onclick: () => respond({ allow: false }) }, 'Deny')) : null);
  }

  function renderQuestion(b) {
    const pending = b.status === 'pending';
    const questions = b.input?.questions || [];
    const picked = questions.map(() => new Set());
    const other = questions.map(() => '');
    const card = h('div', { class: `card${pending ? ' attention' : ''}` });
    questions.forEach((q, qi) => {
      card.append(h('h4', {}, q.question));
      if (!pending) {
        card.append(h('div', { class: 'muted' }, `Answer: ${b.answers?.[q.question] ?? '(none)'}`));
        return;
      }
      for (const opt of q.options || []) {
        const input = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `q-${b.requestId}-${qi}`, onchange: (e) => {
          if (!q.multiSelect) picked[qi].clear();
          e.target.checked ? picked[qi].add(opt.label) : picked[qi].delete(opt.label);
        } });
        card.append(h('label', { class: 'q-opt' }, input, h('span', {}, opt.label, opt.description ? h('div', { class: 'd' }, opt.description) : null)));
      }
      card.append(h('input', { placeholder: 'Or type your own answer', style: 'width:100%;margin-top:4px', oninput: (e) => { other[qi] = e.target.value; } }));
    });
    if (pending) {
      card.append(h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => {
        const answers = {};
        questions.forEach((q, qi) => {
          const vals = [...picked[qi]];
          if (other[qi].trim()) vals.push(other[qi].trim());
          answers[q.question] = q.multiSelect ? vals : vals[vals.length - 1] || '';
        });
        safe(() => api('respond', { chatId: S.chat.id, requestId: b.requestId, answer: { answers } }));
      } }, 'Answer')));
    }
    return card;
  }

  function renderPlan(b) {
    const pending = b.status === 'pending';
    let feedback = '';
    const respond = (answer) => safe(() => api('respond', { chatId: S.chat.id, requestId: b.requestId, answer }));
    return h('div', { class: `card${pending ? ' attention' : ''}` },
      h('h4', {}, pending ? 'Plan ready for review' : `Plan ${b.status}`),
      md(b.input?.plan || ''),
      pending ? h('div', {},
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => respond({ approve: true, mode: 'acceptEdits' }) }, 'Approve and build'),
          h('button', { class: 'btn small', onclick: () => respond({ approve: true, mode: 'default' }) }, 'Approve, ask before each edit')),
        h('div', { class: 'row' },
          h('input', { placeholder: 'What should change in the plan?', style: 'flex:1', oninput: (e) => { feedback = e.target.value; } }),
          h('button', { class: 'btn small', onclick: () => respond({ approve: false, feedback }) }, 'Keep planning'))) : null);
  }

  function renderAssistant(m) {
    const el = h('div', { class: 'msg assistant' });
    const blocks = m.blocks || [];
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      const key = `${m.id}:${i}`;
      if (b.type === 'tool') {
        // group consecutive tool calls
        const group = [];
        while (i < blocks.length && blocks[i].type === 'tool') group.push([blocks[i], `${m.id}:${i++}`]);
        const running = group.filter(([t]) => t.status === 'running').length;
        const gkey = `${m.id}:g${group[0][1]}`;
        const det = h('details', { class: 'block tools', open: S.open.has(gkey) || running > 0 || group.length <= 2,
          ontoggle: (e) => { e.target.open ? S.open.add(gkey) : S.open.delete(gkey); } },
        h('summary', {}, running ? `Working… (${group.length} tool${group.length > 1 ? 's' : ''})` : `Used ${group.length} tool${group.length > 1 ? 's' : ''}`),
        group.map(([t, k]) => renderTool(t, k)));
        el.append(det);
        continue;
      }
      i++;
      if (b.type === 'text') el.append(h('div', { class: 'block' }, md(b.text)));
      else if (b.type === 'thinking') {
        el.append(h('details', { class: 'block thinking', open: S.open.has(key), ontoggle: (e) => { e.target.open ? S.open.add(key) : S.open.delete(key); } },
          h('summary', {}, b.draft ? 'Thinking…' : 'Thought process'), md(b.text)));
      } else if (b.type === 'change') el.append(h('div', { class: 'block' }, renderChange(b, key)));
      else if (b.type === 'permission') el.append(h('div', { class: 'block' }, renderPermission(b)));
      else if (b.type === 'question') el.append(h('div', { class: 'block' }, renderQuestion(b)));
      else if (b.type === 'plan') el.append(h('div', { class: 'block' }, renderPlan(b)));
      else if (b.type === 'notice') el.append(h('div', { class: 'block notice' }, b.text));
      else if (b.type === 'error') el.append(h('div', { class: 'block error-line' }, b.text));
    }
    if (!m.done) {
      const lastText = blocks.length && blocks[blocks.length - 1].type === 'text';
      if (!lastText) el.append(h('div', { class: 'typing' }, h('span'), h('span'), h('span')));
    } else {
      const bits = [];
      if (m.interrupted) bits.push('Stopped');
      if (m.durationMs) bits.push(`${(m.durationMs / 1000).toFixed(1)}s`);
      if (m.usage?.output_tokens) bits.push(`${m.usage.output_tokens.toLocaleString()} tokens out`);
      if (bits.length) el.append(h('div', { class: 'msg-foot' }, bits.join(' · ')));
    }
    return el;
  }

  function renderUser(m) {
    return h('div', { class: `msg user${m.queued ? ' queued' : ''}` },
      m.images?.length ? h('div', { class: 'user-images' }, m.images.map((i) => h('img', { src: fileUrl(i.path), onclick: () => lightbox(fileUrl(i.path)) }))) : null,
      h('div', { class: 'bubble' }, m.text || ''),
      h('div', { class: 'msg-actions' },
        m.queued ? h('span', { class: 'muted', style: 'font-size:12px;color:var(--faint)' }, 'Queued') : null,
        h('button', { class: 'icon-btn', title: 'Copy', onclick: () => navigator.clipboard.writeText(m.text || '') }, 'Copy'),
        !m.queued ? h('button', { class: 'icon-btn', title: 'Rewind to here: undo the script edits made after this message and edit it', onclick: () => rewind(m) }, 'Edit & rewind') : null));
  }

  const SUGGESTIONS = [
    'Make a kill brick that resets players who touch it',
    'Add a leaderboard with coins that save between sessions',
    'Model a low-poly sword in Blender and put it in StarterPack',
    'Playtest the game and fix any errors in the output',
  ];

  function renderChat() {
    const box = $('#messages');
    const chat = S.chat;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.replaceChildren();
    if (!chat) {
      $('#chat-title').value = '';
      $('#engine-badge').textContent = '';
      box.append(h('div', { class: 'empty' }, h('h2', {}, 'StudioPilot'), h('p', {}, 'Pick a chat or start a new one.')));
      syncComposer();
      return;
    }
    $('#chat-title').value = chat.title || '';
    $('#engine-badge').textContent = chat.engine === 'codex' ? `Codex · ${chat.model || 'default model'}` : (S.claudeModels.find((x) => x.id === chat.model)?.label || chat.model || 'Claude');
    const ctx = chat.context;
    $('#context-fill').style.width = ctx ? `${Math.min(100, (ctx.used / ctx.window) * 100).toFixed(1)}%` : '0';
    $('#context-meter').title = ctx ? `Context: ${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()} tokens` : 'Context used';

    if (!chat.messages.length) {
      box.append(h('div', { class: 'empty' },
        h('h2', {}, 'What are we building?'),
        h('p', {}, 'StudioPilot works in Roblox Studio and Blender for you. Open your place in Studio first.'),
        h('div', { class: 'suggestions' }, SUGGESTIONS.map((s) => h('div', { class: 'suggestion', onclick: () => { $('#input').value = s; autosize(); $('#input').focus(); } }, s)))));
    }
    for (const m of chat.messages) box.append(m.role === 'user' ? renderUser(m) : renderAssistant(m));
    if (nearBottom) box.scrollTop = box.scrollHeight;
    syncComposer();
    renderChangesTab();
    renderGalleryTab();
  }

  // ------------------------------------------------------------ composer
  function modelOptions(engine) {
    const sel = $('#model-select');
    sel.replaceChildren();
    if (engine === 'codex') {
      sel.append(h('option', { value: '' }, 'Default model'));
      const custom = S.settings.codexModel;
      if (custom) sel.append(h('option', { value: custom }, custom));
    } else {
      for (const m of S.claudeModels) sel.append(h('option', { value: m.id }, m.label));
    }
  }

  function syncComposer() {
    const chat = S.chat;
    const busy = !!isBusy(chat);
    const engine = chat?.engine || S.settings.engine;
    $('#engine-select').value = engine;
    $('#engine-select').disabled = !!chat?.messages?.length;
    modelOptions(engine);
    $('#model-select').value = chat?.model ?? (engine === 'codex' ? S.settings.codexModel : S.settings.claudeModel);
    $('#effort-select').value = chat?.effort || S.settings.effort;
    $('#plan-toggle').checked = chat?.mode === 'plan';
    $('#send').textContent = busy ? ($('#input').value.trim() ? 'Queue' : 'Stop') : 'Send';
    $('#send').classList.toggle('danger', busy && !$('#input').value.trim());
    $('#send').classList.toggle('primary', !(busy && !$('#input').value.trim()));
    const queued = chat?.messages?.filter((m) => m.queued).length || 0;
    $('#queue-note').textContent = queued ? `${queued} queued` : '';
  }

  function autosize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = `${Math.min(240, t.scrollHeight)}px`;
    syncComposer();
    slashMenu();
  }

  function addImageFile(file) {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 8e6) { toast('Images over 8 MB are too big to send', true); return; }
    const r = new FileReader();
    r.onload = () => {
      const url = r.result;
      S.attachments.push({ data: url.split(',')[1], mediaType: file.type, url });
      renderAttachments();
    };
    r.readAsDataURL(file);
  }
  function renderAttachments() {
    $('#attachments').replaceChildren(...S.attachments.map((a, i) => h('div', { class: 'att' },
      h('img', { src: a.url }),
      h('button', { title: 'Remove', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, '×'))));
  }

  const SLASH = [
    { c: '/new', d: 'Start a new chat', run: () => newChat() },
    { c: '/plan', d: 'Toggle plan mode', run: () => { $('#plan-toggle').checked = !$('#plan-toggle').checked; setOpt({ mode: $('#plan-toggle').checked ? 'plan' : 'default' }); } },
    { c: '/model', d: 'Switch model, e.g. /model sonnet', run: (arg) => {
      const m = S.claudeModels.find((x) => x.id.includes(arg) || x.label.toLowerCase().includes(arg));
      if (S.chat?.engine === 'codex') setOpt({ model: arg });
      else if (m) setOpt({ model: m.id }); else toast(`No model matching "${arg}"`, true);
    } },
    { c: '/effort', d: 'low, medium, high, xhigh or max', run: (arg) => setOpt({ effort: arg }) },
    { c: '/playtest', d: 'Have the playtester agent check the game', text: 'Use the roblox-playtester agent to playtest the game and report what works and what breaks.' },
    { c: '/compact', d: 'Summarize the conversation to free up context', text: '/compact' },
    { c: '/settings', d: 'Open settings', run: () => openSettings() },
  ];
  let slashSel = 0;
  function slashMenu() {
    const v = $('#input').value;
    const menu = $('#slash-menu');
    if (!v.startsWith('/') || v.includes('\n')) { menu.classList.add('hidden'); return; }
    const word = v.split(' ')[0];
    const items = SLASH.filter((s) => s.c.startsWith(word));
    if (!items.length || v.includes(' ')) { menu.classList.add('hidden'); return; }
    slashSel = Math.min(slashSel, items.length - 1);
    menu.replaceChildren(...items.map((s, i) => h('div', { class: i === slashSel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pickSlash(s); } },
      h('span', { class: 'c' }, s.c), h('span', { class: 'd' }, s.d))));
    menu.classList.remove('hidden');
    menu.items = items;
  }
  function pickSlash(s) {
    $('#slash-menu').classList.add('hidden');
    if (s.c === '/model' || s.c === '/effort') { $('#input').value = `${s.c} `; $('#input').focus(); return; }
    $('#input').value = '';
    autosize();
    if (s.text) { $('#input').value = s.text; send(); } else s.run();
  }

  async function setOpt(opts) {
    if (!S.chat) return;
    const chat = await safe(() => api('setOptions', { chatId: S.chat.id, ...opts }));
    if (chat) { S.chat = chat; renderChat(); }
  }

  async function send() {
    const text = $('#input').value.trim();
    const busy = isBusy(S.chat);
    if (!text && !S.attachments.length) {
      if (busy) await safe(() => api('stop', { chatId: S.chat.id }));
      return;
    }
    const cmd = SLASH.find((s) => s.run && (text === s.c || text.startsWith(`${s.c} `)));
    if (cmd) { $('#input').value = ''; autosize(); cmd.run(text.slice(cmd.c.length).trim().toLowerCase()); return; }
    if (!S.chat) await newChat();
    if (!S.chat) return;
    const images = S.attachments.map(({ data, mediaType }) => ({ data, mediaType }));
    $('#input').value = '';
    S.attachments = [];
    renderAttachments();
    autosize();
    await safe(() => api('send', { chatId: S.chat.id, text, images }));
    refreshList();
  }

  async function rewind(m) {
    const ok = await confirmBox('Rewind to this message? Script edits made after it are undone (when the script hasn\'t changed since), later messages are removed, and the message goes back into the box for editing. Other Studio changes like new parts are not undone; use Ctrl+Z in Studio for those.');
    if (!ok) return;
    const r = await safe(() => api('rewind', { chatId: S.chat.id, messageId: m.id }));
    if (!r) return;
    S.chat = await api('getChat', { id: S.chat.id });
    $('#input').value = r.text || '';
    autosize();
    renderChat();
    toast(`Rewound. Restored ${r.restored.length} script${r.restored.length === 1 ? '' : 's'}${r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : ''}.`, r.skipped.length > 0);
  }

  // ------------------------------------------------------------ side panel
  function showTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const b of ['changes', 'gallery', 'studio']) $(`#tab-${b}`).classList.toggle('hidden', b !== name);
    if (name === 'studio') renderStudioTab();
  }

  function renderChangesTab() {
    const box = $('#tab-changes');
    box.replaceChildren();
    const changes = [];
    S.chat?.messages.forEach((m) => (m.blocks || []).forEach((b, i) => { if (b.type === 'change') changes.push([b, `${m.id}:${i}`]); }));
    if (!changes.length) { box.append(h('div', { class: 'notice' }, 'Script edits in this chat show up here as diffs.')); return; }
    for (const [b, key] of changes.reverse()) box.append(renderChange(b, `panel:${key}`));
  }

  function renderGalleryTab() {
    const box = $('#tab-gallery');
    box.replaceChildren();
    const imgs = [];
    S.chat?.messages.forEach((m) => (m.blocks || []).forEach((b) => { if (b.type === 'tool' && b.images) for (const p of b.images) imgs.push({ path: p, tool: toolInfo(b.name).label }); }));
    if (!imgs.length) { box.append(h('div', { class: 'notice' }, 'Screenshots, playtest captures, Blender renders and VFX frames from this chat collect here.')); return; }
    box.append(h('div', { class: 'gallery-grid' }, imgs.reverse().map((i) => h('figure', {}, h('img', { src: fileUrl(i.path), onclick: () => lightbox(fileUrl(i.path)) }), h('figcaption', {}, i.tool)))));
  }

  async function renderStudioTab() {
    const box = $('#tab-studio');
    const st = S.status;
    const project = S.projects.find((p) => p.id === S.chat?.projectId) || S.projects[0];
    box.replaceChildren(
      h('div', { class: 'section-title' }, 'Connections'),
      h('div', { class: 'kv' }, h('span', {}, 'Studio plugin'), h('span', {}, st?.studio.connected ? `Connected (${st.studio.studios.map((s) => `${s.place} · ${s.context}`).join(', ')})` : 'Not connected')),
      h('div', { class: 'kv' }, h('span', {}, 'Studio built-in MCP'), h('span', {}, st?.builtInMcp.connected ? 'Connected' : 'Off')),
      h('div', { class: 'kv' }, h('span', {}, 'Blender'), h('span', {}, st?.blender.path ? 'Found' : 'Not found')),
      h('div', { class: 'row', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { class: 'btn small', onclick: () => safe(async () => { await api('openBlender'); toast('Blender is starting with the StudioPilot adapter'); }) }, 'Open Blender'),
        h('button', { class: 'btn small', onclick: () => { $('#input').value = 'Use the roblox-playtester agent to playtest the game and report what works and what breaks.'; send(); } }, 'Playtest now')),
      h('div', { class: 'section-title' }, 'Rojo'),
      h('div', { class: 'kv' }, h('span', {}, project ? project.dir : ''), h('span', {}, S.rojoRunning ? 'Serving' : 'Stopped')),
      h('div', { style: 'display:flex;gap:6px' },
        S.rojoRunning
          ? h('button', { class: 'btn small', onclick: () => safe(async () => { await api('rojoStop'); S.rojoRunning = false; renderStatus(); }) }, 'Stop Rojo')
          : h('button', { class: 'btn small', disabled: !st?.rojo.path, title: st?.rojo.path ? '' : 'Rojo is not installed', onclick: () => safe(async () => { await api('rojoStart', { dir: project.dir }); S.rojoRunning = true; renderStatus(); }) }, 'Start Rojo')),
      S.rojoLog.length ? h('div', { class: 'log' }, S.rojoLog.slice(-60).join('\n')) : null,
    );
  }

  // ------------------------------------------------------------ modals
  function modal({ title, body, wide = true }) {
    const close = () => back.remove();
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
      h('div', { class: 'modal', style: wide ? '' : 'width:min(480px,94vw)' },
        h('header', {}, title, h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: close }, '×')),
        body));
    $('#modal-root').append(back);
    return close;
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      let close;
      const done = (v) => { close(); resolve(v); };
      close = modal({ title: 'Confirm', wide: false, body: h('div', { class: 'content' }, h('p', {}, text),
        h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, 'Continue'))) });
    });
  }

  async function openSettings(section = 'general') {
    const content = h('div', { class: 'content' });
    const nav = h('nav');
    const sections = {
      general: ['General', renderGeneral],
      setup: ['Setup', renderSetup],
      roblox: ['Roblox uploads', renderRoblox],
      blender: ['Blender', renderBlender],
      skills: ['Skills', renderSkills],
      mcp: ['MCP servers', renderMcp],
    };
    const show = async (key) => {
      for (const b of nav.children) b.classList.toggle('active', b.dataset.k === key);
      content.replaceChildren(h('div', { class: 'notice' }, 'Loading…'));
      content.replaceChildren(...(await sections[key][1]()));
    };
    for (const [k, [label]] of Object.entries(sections)) nav.append(h('button', { 'data-k': k, onclick: () => show(k) }, label));
    modal({ title: 'Settings', body: h('div', { class: 'body' }, nav, content) });
    show(section);
  }

  function field(label, input, help) {
    return h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'help' }, help) : null);
  }

  async function renderGeneral() {
    const s = S.settings;
    const save = async (patch) => { S.settings = await api('saveSettings', patch); toast('Saved'); syncComposer(); };
    const engine = h('select', { onchange: (e) => save({ engine: e.target.value }) }, h('option', { value: 'claude' }, 'Claude Code'), h('option', { value: 'codex' }, 'Codex (GPT)'));
    engine.value = s.engine;
    const model = h('select', { onchange: (e) => save({ claudeModel: e.target.value }) }, S.claudeModels.map((m) => h('option', { value: m.id }, m.label)));
    model.value = s.claudeModel;
    const codexModel = h('input', { value: s.codexModel, placeholder: 'Leave empty for Codex\'s default', onchange: (e) => save({ codexModel: e.target.value.trim() }) });
    const effort = h('select', { onchange: (e) => save({ effort: e.target.value }) }, ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => h('option', { value: v }, v)));
    effort.value = s.effort;
    const auto = h('input', { type: 'checkbox', checked: s.autoApprove, onchange: (e) => save({ autoApprove: e.target.checked }) });
    const prompt = h('textarea', { placeholder: 'e.g. "This game uses Knit. Keep server code in ServerScriptService/Services."', onchange: (e) => save({ customPrompt: e.target.value }) });
    prompt.value = s.customPrompt;
    return [
      field('Default engine for new chats', engine),
      field('Claude model', model),
      field('Codex model', codexModel, 'Any model name your Codex account supports.'),
      field('Default effort', effort),
      field('Approve everything automatically', h('label', { class: 'toggle' }, auto, h('span', {}, 'Skip approval prompts for shell commands and file edits')),
        'StudioPilot tools never ask. With this off, the agent asks before running shell commands or editing files on disk. Questions and plans always come to you.'),
      field('Custom instructions', prompt, 'Added to every chat\'s system prompt.'),
    ];
  }

  async function renderSetup() {
    const st = await api('status');
    S.status = st;
    const row = (ok, title, sub, button) => h('div', { class: 'check' }, h('span', { class: `dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}` }),
      h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'sub' }, sub)), button);
    return [
      row(!!st.claude.path, 'Claude Code', st.claude.version || 'Not installed. Install it from https://code.claude.com',
        h('button', { class: 'btn small', onclick: () => api('login', { engine: 'claude' }) }, 'Log in')),
      row(st.codex.path ? true : null, 'Codex (optional)', st.codex.version || 'Not installed (npm i -g @openai/codex)',
        st.codex.path ? h('button', { class: 'btn small', onclick: () => api('login', { engine: 'codex' }) }, 'Log in') : null),
      row(st.plugin.installed, 'Studio plugin', st.plugin.installed ? st.plugin.path : 'Not installed',
        h('button', { class: 'btn small', onclick: () => safe(async () => { await api('installPlugin'); toast('Plugin and playtester agent installed. Open a new place in Studio to load it.'); openSettings('setup'); }) }, st.plugin.installed ? 'Reinstall' : 'Install')),
      row(st.hub.running, 'Bridge', st.hub.running ? 'Running on 127.0.0.1:8766' : 'Not running',
        st.hub.running ? null : h('button', { class: 'btn small', onclick: () => safe(async () => { await api('startHub'); openSettings('setup'); }) }, 'Start')),
      row(st.studio.connected ? true : null, 'Studio connection', st.studio.connected ? 'Connected' : 'Open a place in Roblox Studio. Allow HTTP requests to 127.0.0.1 when Studio asks.', null),
      row(st.builtInMcp.connected ? true : null, 'Studio built-in MCP', st.builtInMcp.connected ? 'Connected: input, screenshots, AI generation' : 'In Studio: Assistant panel > … > MCP Servers > turn on "Enable Studio as MCP server"', null),
      row(st.blender.path ? true : null, 'Blender (optional)', st.blender.path || 'Not found. Set the path under Blender.', null),
      row(st.rojo.path ? true : null, 'Rojo (optional)', st.rojo.version || 'Not installed', null),
    ];
  }

  async function renderRoblox() {
    const cfg = await api('robloxConfig');
    const key = h('input', { type: 'password', placeholder: cfg.hasKey ? 'Saved. Paste a new key to replace it' : 'Open Cloud API key' });
    const user = h('input', { value: cfg.creator?.userId || '', placeholder: 'Your Roblox user id' });
    const group = h('input', { value: cfg.creator?.groupId || '', placeholder: 'Or a group id' });
    return [
      h('p', { class: 'help', style: 'color:var(--muted)' }, 'Blender models and images upload with your Studio login, no key needed. Once, in Studio: Assistant panel → … → MCP Permissions → allow asset uploads and approve the folder Documents/StudioPilot/exports. An Open Cloud API key below is only a fallback for when Studio\'s built-in MCP is off.'),
      field('API key', key),
      field('Creator user id', user),
      field('Creator group id (optional)', group),
      h('button', { class: 'btn primary', onclick: () => safe(async () => {
        await api('saveRobloxConfig', { apiKey: key.value.trim() || undefined, userId: user.value.trim() || undefined, groupId: group.value.trim() || undefined });
        toast('Saved');
      }) }, 'Save'),
    ];
  }

  async function renderBlender() {
    const s = S.settings;
    const pathInput = h('input', { value: s.blenderPath, placeholder: S.status?.blender.path || 'Found on PATH automatically', style: 'flex:1' });
    return [
      field('Blender executable', h('div', { style: 'display:flex;gap:6px' }, pathInput,
        h('button', { class: 'btn', onclick: async () => { const p = await api('pickBlender'); if (p) pathInput.value = p; } }, 'Browse'),
        h('button', { class: 'btn primary', onclick: () => safe(async () => { S.settings = await api('saveSettings', { blenderPath: pathInput.value.trim() }); toast('Saved'); }) }, 'Save')),
      'Blender 4.2 or newer. Used for modeling, renders, rigs and animations.'),
      h('button', { class: 'btn', onclick: () => safe(async () => { await api('openBlender'); toast('Blender is starting'); }) }, 'Open Blender now'),
    ];
  }

  async function renderSkills() {
    const list = await api('listSkills');
    const url = h('input', { placeholder: 'https://github.com/owner/repo', style: 'flex:1' });
    return [
      h('p', { class: 'help', style: 'color:var(--muted)' }, 'Skills are instruction packs Claude loads when they fit the task. They live in ~/.claude/skills.'),
      h('div', { style: 'display:flex;gap:6px;margin-bottom:12px' }, url, h('button', { class: 'btn primary', onclick: () => safe(async () => {
        const r = await api('installSkills', { url: url.value.trim() });
        toast(r.installed.length ? `Installed ${r.installed.join(', ')}` : 'Nothing new to install');
        openSettings('skills');
      }) }, 'Install from GitHub')),
      ...list.map((s) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', {}, s.name), h('div', { class: 'sub' }, s.description)),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmBox(`Delete the skill "${s.name}"?`)) { await safe(() => api('removeSkill', { name: s.name })); openSettings('skills'); } } }, 'Remove'))),
    ];
  }

  const MCP_PRESETS = [
    { label: 'Obsidian vault / folder', name: 'notes', cmd: 'npx -y @modelcontextprotocol/server-filesystem /path/to/your/vault', help: 'Lets Claude read and write notes in a folder, e.g. your Obsidian vault. Replace the path.' },
    { label: 'Browser (Playwright)', name: 'playwright', cmd: 'npx -y @playwright/mcp@latest', help: 'Lets Claude open and use web pages.' },
    { label: 'Memory', name: 'memory', cmd: 'npx -y @modelcontextprotocol/server-memory', help: 'A small knowledge graph Claude can remember things in across chats.' },
  ];

  async function renderMcp() {
    const list = await api('listMcp');
    const name = h('input', { placeholder: 'name' });
    const cmd = h('input', { placeholder: 'command and args, or an https:// URL', style: 'flex:1' });
    return [
      h('p', { class: 'help', style: 'color:var(--muted)' }, 'Extra MCP servers available to Claude in every chat (user scope). StudioPilot itself is always added per chat.'),
      h('div', { style: 'display:flex;gap:6px;margin-bottom:12px' }, name, cmd, h('button', { class: 'btn primary', onclick: () => safe(async () => {
        const v = cmd.value.trim();
        if (/^https?:\/\//.test(v)) await api('addMcp', { name: name.value.trim(), url: v });
        else { const [command, ...args] = v.split(/\s+/); await api('addMcp', { name: name.value.trim(), command, args }); }
        toast('Added');
        openSettings('mcp');
      }) }, 'Add')),
      h('div', { class: 'section-title' }, 'Presets'),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px' }, MCP_PRESETS.map((p) => h('button', {
        class: 'btn small', title: p.help,
        onclick: () => { name.value = p.name; cmd.value = p.cmd; cmd.focus(); },
      }, p.label))),
      ...(list.length ? list : [{ name: '(none)', command: '', status: '' }]).map((s) => h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', {}, s.name), h('div', { class: 'sub' }, `${s.command} ${s.status ? `· ${s.status}` : ''}`)),
        s.command ? h('button', { class: 'btn small', onclick: async () => { if (await confirmBox(`Remove the MCP server "${s.name}"?`)) { await safe(() => api('removeMcp', { name: s.name })); openSettings('mcp'); } } }, 'Remove') : null)),
    ];
  }

  // ------------------------------------------------------------ wiring
  function wire() {
    $('#new-chat').onclick = () => newChat();
    $('#open-settings').onclick = () => openSettings();
    $('#toggle-panel').onclick = () => $('#panel').classList.toggle('hidden');
    for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
    $('#chat-title').onchange = (e) => { if (S.chat) api('renameChat', { chatId: S.chat.id, title: e.target.value }).then(refreshList); };
    $('#send').onclick = send;
    $('#attach').onclick = () => $('#file-input').click();
    $('#file-input').onchange = (e) => { for (const f of e.target.files) addImageFile(f); e.target.value = ''; };
    $('#engine-select').onchange = (e) => (S.chat && !S.chat.messages.length ? setOpt({ engine: e.target.value }) : null);
    $('#model-select').onchange = (e) => setOpt({ model: e.target.value });
    $('#effort-select').onchange = (e) => setOpt({ effort: e.target.value });
    $('#plan-toggle').onchange = (e) => setOpt({ mode: e.target.checked ? 'plan' : 'default' });

    const input = $('#input');
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      const menu = $('#slash-menu');
      if (!menu.classList.contains('hidden') && menu.items) {
        if (e.key === 'ArrowDown') { slashSel = (slashSel + 1) % menu.items.length; slashMenu(); e.preventDefault(); return; }
        if (e.key === 'ArrowUp') { slashSel = (slashSel - 1 + menu.items.length) % menu.items.length; slashMenu(); e.preventDefault(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { pickSlash(menu.items[slashSel]); e.preventDefault(); return; }
        if (e.key === 'Escape') { menu.classList.add('hidden'); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && isBusy(S.chat)) api('stop', { chatId: S.chat.id });
    });
    input.addEventListener('paste', (e) => {
      for (const item of e.clipboardData.items) if (item.type.startsWith('image/')) { addImageFile(item.getAsFile()); e.preventDefault(); }
    });
    const comp = $('#composer');
    document.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('dragging'); });
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) comp.classList.remove('dragging'); });
    document.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('dragging'); for (const f of e.dataTransfer.files) addImageFile(f); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newChat(); }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    });

    window.sp.on('chat', (chat) => {
      const entry = S.chatList.find((c) => c.id === chat.id);
      if (entry) { entry.busy = isBusy(chat); entry.title = chat.title; }
      if (S.chat?.id === chat.id) { S.chat = chat; renderChat(); }
      renderSidebar();
    });
    window.sp.on('status', (st) => { if (st) { S.status = st; renderStatus(); } });
    window.sp.on('rojo-log', (line) => {
      if (line === null) { S.rojoRunning = false; renderStatus(); return; }
      S.rojoLog.push(line);
      S.rojoLog = S.rojoLog.slice(-300);
    });
    window.sp.on('notice', (text) => toast(text));
    window.sp.on('update', ({ version, url }) => {
      const bar = h('div', { class: 'update-bar' },
        `StudioPilot ${version} is out.`,
        h('button', { class: 'btn small primary', onclick: () => api('openExternal', { url }) }, 'Download'),
        h('button', { class: 'icon-btn', onclick: () => bar.remove() }, '×'));
      $('#main').prepend(bar);
    });
    window.sp.on('focus', () => { if (!document.querySelector('.modal-back')) $('#input').focus(); });
  }

  async function boot() {
    const init = await api('init');
    S.settings = init.settings;
    S.projects = init.projects;
    S.chatList = init.chats;
    S.claudeModels = init.claudeModels;
    wire();
    renderSidebar();
    if (S.chatList[0]) await openChat(S.chatList[0].id); else renderChat();
    const st = await api('status');
    S.status = st;
    S.rojoRunning = (await api('rojoStatus')).running;
    renderStatus();
    if (!st.claude.path || !st.plugin.installed) openSettings('setup');
  }

  boot();
})();
