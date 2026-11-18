// Tool definitions exposed over MCP. `context` says which Studio DataModel runs
// the command: "edit" (the normal editor), "server"/"client" (a running
// playtest), or "dynamic" (taken from the `context` argument). Tools with no
// pluginCommand are answered by the bridge itself.

const path = (desc = 'Instance path from game, e.g. "Workspace.Map.Door" or "ServerScriptService.Main".') =>
  ({ type: 'string', description: desc });

const VALUE_DOC =
  'Property values are JSON. Numbers, strings and booleans pass through. Other types use arrays or tagged objects: ' +
  'Vector3 [x,y,z], Vector2 [x,y], Color3 {"Color3":[r,g,b]} (0-1) or "#ff8800", UDim2 {"UDim2":[xs,xo,ys,yo]}, ' +
  'CFrame {"CFrame":[x,y,z]} or 12 numbers, BrickColor {"BrickColor":"Bright red"}, Enum "Enum.Material.Neon", ' +
  'instance reference {"Instance":"Workspace.Part"}, nil {"nil":true}.';

export const TOOLS = [
  // ---- bridge-local
  {
    name: 'list_studios',
    description: 'List Roblox Studio windows connected to the bridge, with the play context of each (edit, server, client).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_active_studio',
    description: 'Pick which connected Studio place receives commands when several are open. Pass no place to go back to "most recent".',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Place name exactly as list_studios shows it.' },
        id: { type: 'string', description: 'Connection id from list_studios; use it when two open places have the same name.' },
        studioSessionId: { type: 'string', description: 'Built-in MCP session (from list_studios) used by roblox_* tools.' },
      },
      additionalProperties: false,
    },
  },

  // ---- inspection
  {
    name: 'get_studio_info',
    pluginCommand: 'get_studio_info',
    context: 'edit',
    description: 'Place name, PlaceId/GameId, whether a playtest is running, current selection, and top-level services with child counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_children',
    pluginCommand: 'list_children',
    context: 'dynamic',
    description: 'List the children of an instance as a tree (name, class, child count). Use depth to see more levels.',
    inputSchema: {
      type: 'object',
      properties: {
        path: path('Instance path; "game" or "" for the DataModel root.'),
        depth: { type: 'integer', minimum: 1, maximum: 6, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 300, description: 'Maximum nodes returned.' },
        context: { type: 'string', enum: ['edit', 'server', 'client'], default: 'edit' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_properties',
    pluginCommand: 'get_properties',
    context: 'dynamic',
    description: 'Read properties and attributes of an instance. Without a list, returns every readable property of its class.',
    inputSchema: {
      type: 'object',
      properties: {
        path: path(),
        properties: { type: 'array', items: { type: 'string' }, description: 'Specific property names to read.' },
        context: { type: 'string', enum: ['edit', 'server', 'client'], default: 'edit' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_instances',
    pluginCommand: 'search_instances',
    context: 'edit',
    description: 'Find instances under a root by name substring (case-insensitive) and/or class (IsA). Returns paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of the instance name.' },
        className: { type: 'string', description: 'Class to match with IsA, e.g. "BasePart" or "RemoteEvent".' },
        root: path('Where to search from. Default: game.'),
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_selection',
    pluginCommand: 'get_selection',
    context: 'edit',
    description: 'Paths and classes of what the user currently has selected in Studio.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_selection',
    pluginCommand: 'set_selection',
    context: 'edit',
    description: 'Select instances in Studio (also useful to point the user at something).',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
      additionalProperties: false,
    },
  },

  // ---- scripts
  {
    name: 'read_script',
    pluginCommand: 'read_script',
    context: 'edit',
    description: 'Read a Script/LocalScript/ModuleScript source with line numbers (includes unsaved editor text).',
    inputSchema: {
      type: 'object',
      properties: {
        path: path(),
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_script',
    pluginCommand: 'edit_script',
    context: 'edit',
    description: 'Replace an exact string in a script. old_string must match exactly once unless replace_all is true. Undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        path: path(),
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_script',
    pluginCommand: 'write_script',
    context: 'edit',
    description: 'Replace the whole source of an existing script. Prefer edit_script for small changes. Undoable.',
    inputSchema: {
      type: 'object',
      properties: { path: path(), source: { type: 'string' } },
      required: ['path', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_script',
    pluginCommand: 'create_script',
    context: 'edit',
    description: 'Create a Script, LocalScript or ModuleScript with the given source. Fails if a child with that name exists unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        parent: path('Parent instance path, e.g. "ServerScriptService".'),
        name: { type: 'string' },
        className: { type: 'string', enum: ['Script', 'LocalScript', 'ModuleScript'] },
        source: { type: 'string' },
        runContext: { type: 'string', enum: ['Legacy', 'Server', 'Client'], description: 'Script.RunContext (Script only).' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['parent', 'name', 'className', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep_scripts',
    pluginCommand: 'grep_scripts',
    context: 'edit',
    description: 'Search every script source for a Lua pattern (or plain text). Returns path:line: text matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        plain: { type: 'boolean', default: true, description: 'Treat pattern as plain text (default) instead of a Lua pattern.' },
        caseSensitive: { type: 'boolean', default: false },
        root: path('Limit the search to this subtree. Default: game.'),
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },

  // ---- instances
  {
    name: 'create_instance',
    pluginCommand: 'create_instance',
    context: 'edit',
    description: `Create an instance with Instance.new and set properties on it. ${VALUE_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string' },
        parent: path('Parent path.'),
        name: { type: 'string' },
        properties: { type: 'object', additionalProperties: true },
        attributes: { type: 'object', additionalProperties: true },
      },
      required: ['className', 'parent'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_properties',
    pluginCommand: 'set_properties',
    context: 'edit',
    description: `Set properties (and optionally attributes) on one or more instances. ${VALUE_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Instances to change.' },
        properties: { type: 'object', additionalProperties: true },
        attributes: { type: 'object', additionalProperties: true },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_instances',
    pluginCommand: 'delete_instances',
    context: 'edit',
    description: 'Delete instances (undoable).',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_instance',
    pluginCommand: 'move_instance',
    context: 'edit',
    description: 'Reparent and/or rename an instance, optionally cloning it instead of moving.',
    inputSchema: {
      type: 'object',
      properties: {
        path: path(),
        newParent: path('New parent path. Omit to keep the current parent.'),
        newName: { type: 'string' },
        clone: { type: 'boolean', default: false },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_asset',
    pluginCommand: 'insert_asset',
    context: 'edit',
    description: 'Insert a Creator Store / Toolbox asset by id under a parent (default Workspace).',
    inputSchema: {
      type: 'object',
      properties: { assetId: { type: 'integer' }, parent: path('Parent path. Default: Workspace.') },
      required: ['assetId'],
      additionalProperties: false,
    },
  },

  // ---- execution and testing
  {
    name: 'run_luau',
    pluginCommand: 'run_luau',
    context: 'dynamic',
    description:
      'Run Luau code and return its print/warn output plus returned values. context "edit" runs in the editor with plugin ' +
      'permissions (changes are recorded as one undo step); "server"/"client" run inside a running playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        context: { type: 'string', enum: ['edit', 'server', 'client'], default: 'edit' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_output',
    pluginCommand: 'get_output',
    context: 'dynamic',
    description: 'Recent Output window messages (prints, warnings, errors) from the chosen context.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        errorsOnly: { type: 'boolean', default: false },
        contains: { type: 'string', description: 'Only messages containing this text.' },
        context: { type: 'string', enum: ['edit', 'server', 'client'], default: 'edit' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'start_playtest',
    pluginCommand: 'start_playtest',
    context: 'edit',
    description: 'Start a playtest. mode "play" spawns a character (server + client), "run" runs the server only. Returns once the session is up.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['play', 'run'], default: 'play' } },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_playtest',
    pluginCommand: 'stop_playtest',
    context: 'server',
    description: 'Stop the running playtest and return to edit mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ---- Blender (answered by the bridge; Blender runs the studiopilot adapter)
  {
    name: 'blender_start',
    local: true,
    description: 'Open Blender with the StudioPilot adapter (or confirm it is already running). Other blender_* tools start it automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional .blend file to open.' },
        background: { type: 'boolean', default: false, description: 'Run without a window.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'blender_scene',
    local: true,
    description: 'List the objects in the Blender scene with type, transform, dimensions, vertex/face counts and materials.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'blender_run_python',
    local: true,
    description:
      'Run Python inside Blender (bpy, mathutils and math are imported; variables persist between calls). ' +
      'Assign to `result` to return a value; print() output is returned too. Use this to model, edit meshes, add materials, rig and animate. ' +
      'Blender is Z-up in meters; 1 Blender unit becomes 1 stud in Roblox.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'blender_render',
    local: true,
    description: 'Render objects from several angles and return the images so you can see what you built. Check your work with this after modeling.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: { type: 'array', items: { type: 'string' }, description: 'Object names. Default: everything visible.' },
        views: { type: 'array', items: { type: 'string', enum: ['iso', 'front', 'back', 'left', 'right', 'top'] }, default: ['iso', 'front', 'right', 'top'] },
        size: { type: 'integer', minimum: 128, maximum: 1024, default: 512 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'blender_save',
    local: true,
    description: 'Save the Blender file (to a path, or to its current file).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_to_blender',
    local: true,
    description: 'Copy Studio parts/models into Blender (positions, sizes, colors; MeshPart geometry when Studio allows reading it). Good for remodeling something from the game.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Studio instance paths (parts or models). Default: current selection.' },
        collection: { type: 'string', description: 'Blender collection to put them in. Default: FromStudio.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'blender_to_studio',
    local: true,
    description:
      'Export Blender objects as FBX, upload them to Roblox through Open Cloud, and insert the result into Studio. ' +
      'Needs an Open Cloud API key (see upload_asset). The upload goes through Roblox moderation.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: { type: 'array', items: { type: 'string' }, description: 'Object names. Default: everything visible.' },
        name: { type: 'string', description: 'Asset / model name.' },
        parent: { type: 'string', description: 'Studio parent path. Default: Workspace.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_asset',
    local: true,
    description:
      'Upload a local file to Roblox (FBX/OBJ/GLB as a Model, PNG/JPG as a Decal, MP3/OGG as Audio) and return its asset id. ' +
      'Needs an Open Cloud API key with Assets read+write in ~/.config/studiopilot/config.json.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file.' },
        name: { type: 'string' },
        insert: { type: 'boolean', default: false, description: 'Insert into Studio after upload (models only).' },
        parent: { type: 'string', description: 'Studio parent when inserting. Default: Workspace.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  {
    name: 'blender_checkpoints',
    local: true,
    description: 'List Blender checkpoints. One is saved automatically before every change a blender_* tool makes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'blender_restore',
    local: true,
    description: 'Restore Blender to a checkpoint (undo everything after it). Pass the id from blender_checkpoints, or "last" for the most recent one.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'blender_import_rig',
    local: true,
    description:
      'Copy a Studio rig (R15/R6 character or any Motor6D model) into Blender as an armature with the parts parented to bones, ready to animate. ' +
      'Each bone is named after the part it moves.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Studio path of the rig Model, e.g. "Workspace.Rig".' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'blender_import_animation',
    local: true,
    description: 'Load a Roblox animation (KeyframeSequence / Animation path, or an asset id) onto a rig armature in Blender for editing.',
    inputSchema: {
      type: 'object',
      properties: {
        armature: { type: 'string', description: 'Blender armature name (from blender_import_rig).' },
        path: { type: 'string', description: 'Studio path of a KeyframeSequence or Animation.' },
        assetId: { type: 'integer' },
        name: { type: 'string', description: 'Action name in Blender.' },
      },
      required: ['armature'],
      additionalProperties: false,
    },
  },
  {
    name: 'blender_export_animation',
    local: true,
    description:
      "Send the armature's current Blender action to Studio as a KeyframeSequence under ServerStorage.RBX_ANIMSAVES.<rig>, " +
      'where the Animation Editor can open and publish it. Animate in Blender with blender_run_python (pose bones, keyframe_insert) first.',
    inputSchema: {
      type: 'object',
      properties: {
        armature: { type: 'string' },
        name: { type: 'string', description: 'Animation name.' },
        loop: { type: 'boolean', default: false },
        priority: { type: 'string', enum: ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'] },
        everyFrame: { type: 'boolean', default: false, description: 'Sample every frame instead of only keyframes (for baked/IK motion).' },
      },
      required: ['armature', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'vfx_capture',
    local: true,
    description:
      'Fire the particle emitters in an effect and screenshot it several times as it plays, so you can judge how a VFX looks. ' +
      "Uses Studio's built-in screen capture (edit mode).",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Effect, part, attachment or model containing the emitters.' },
        frames: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        intervalMs: { type: 'integer', minimum: 50, maximum: 3000, default: 250 },
        distance: { type: 'number', description: 'Camera distance in studs. Default: based on size.' },
        burst: { type: 'integer', description: 'Particles to emit per emitter. Default: half its Rate.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];
