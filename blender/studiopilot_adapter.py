"""StudioPilot adapter for Blender.

Runs a small HTTP server inside Blender so the StudioPilot bridge can drive it.
Requests are executed on Blender's main thread through bpy.app.timers, since
bpy is not thread-safe.

Start Blender with it:   blender --python studiopilot_adapter.py
or run it once from Blender's Scripting tab. Port: STUDIOPILOT_BLENDER_PORT (8767).
"""

import contextlib
import io
import json
import math
import os
import queue
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bpy
import mathutils

PORT = int(os.environ.get("STUDIOPILOT_BLENDER_PORT", "8767"))
VERSION = "0.1.0"
_jobs: "queue.Queue[tuple[str, dict, dict]]" = queue.Queue()
_scope: dict = {}  # persists variables between run_python calls

# ---------------------------------------------------------------- helpers


def _mesh_objects(names):
    if names:
        objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
        missing = [n for n in names if n not in bpy.data.objects]
        if missing:
            raise ValueError(f"objects not found: {missing}")
        return objs
    return [o for o in bpy.context.scene.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT", "ARMATURE"} and o.visible_get()]


def _bounds(objs):
    lo = mathutils.Vector((math.inf,) * 3)
    hi = mathutils.Vector((-math.inf,) * 3)
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(corner)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
    if lo.x == math.inf:
        return mathutils.Vector((0, 0, 0)), 1.0
    return (lo + hi) / 2, max((hi - lo).length, 0.01)


# ---------------------------------------------------------------- commands


def cmd_ping(_args):
    return {"blender": bpy.app.version_string, "adapter": VERSION, "file": bpy.data.filepath or None}


def cmd_scene(_args):
    out = []
    for o in bpy.context.scene.objects:
        item = {
            "name": o.name,
            "type": o.type,
            "location": [round(v, 4) for v in o.location],
            "rotation_deg": [round(math.degrees(v), 2) for v in o.rotation_euler],
            "scale": [round(v, 4) for v in o.scale],
            "dimensions": [round(v, 4) for v in o.dimensions],
            "parent": o.parent.name if o.parent else None,
            "visible": o.visible_get(),
        }
        if o.type == "MESH":
            item["verts"] = len(o.data.vertices)
            item["faces"] = len(o.data.polygons)
            item["materials"] = [s.material.name for s in o.material_slots if s.material]
        out.append(item)
    return {"file": bpy.data.filepath or None, "objects": out}


def cmd_run_python(args):
    code = args.get("code", "")
    buf = io.StringIO()
    _scope.update({"bpy": bpy, "mathutils": mathutils, "math": math})
    _scope.pop("result", None)
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        exec(compile(code, "<run_python>", "exec"), _scope)
    result = _scope.get("result")
    try:
        json.dumps(result)
    except TypeError:
        result = repr(result)
    return {"output": buf.getvalue()[-20000:], "result": result}


VIEWS = {
    # name: (azimuth deg around Z, elevation deg)
    "front": (0, 0),
    "back": (180, 0),
    "left": (90, 0),
    "right": (-90, 0),
    "top": (0, 89.9),
    "iso": (35, 30),
}


def cmd_render(args):
    """Render the given objects (or all visible) from several views to PNGs."""
    objs = _mesh_objects(args.get("objects"))
    views = args.get("views") or ["iso", "front", "right", "top"]
    size = int(args.get("size", 512))
    center, radius = _bounds(objs)

    scene = bpy.context.scene
    saved = {
        "camera": scene.camera,
        "engine": scene.render.engine,
        "x": scene.render.resolution_x,
        "y": scene.render.resolution_y,
        "pct": scene.render.resolution_percentage,
        "path": scene.render.filepath,
        "transparent": scene.render.film_transparent,
        "hidden": {o.name: o.hide_render for o in scene.objects},
    }
    cam_data = bpy.data.cameras.new("SP_RenderCam")
    cam = bpy.data.objects.new("SP_RenderCam", cam_data)
    scene.collection.objects.link(cam)
    light_data = bpy.data.lights.new("SP_RenderSun", "SUN")
    light_data.energy = 3
    light = bpy.data.objects.new("SP_RenderSun", light_data)
    scene.collection.objects.link(light)
    light.rotation_euler = (math.radians(50), math.radians(10), math.radians(30))

    out_dir = tempfile.mkdtemp(prefix="sp_render_")
    files = []
    try:
        wanted = {o.name for o in objs}
        for o in scene.objects:
            if o.type not in {"CAMERA", "LIGHT"}:
                o.hide_render = o.name not in wanted
        # Workbench needs a GPU context, which headless Blender often lacks;
        # fall back to a few CPU Cycles samples there.
        if bpy.app.background:
            scene.render.engine = "CYCLES"
            scene.cycles.device = "CPU"
            scene.cycles.samples = int(args.get("samples", 12))
            scene.cycles.use_denoising = True
        else:
            scene.render.engine = "BLENDER_WORKBENCH"
            try:
                scene.display.shading.light = "STUDIO"
                scene.display.shading.color_type = "MATERIAL"
            except Exception:
                pass
        scene.render.resolution_x = size
        scene.render.resolution_y = size
        scene.render.resolution_percentage = 100
        scene.render.film_transparent = False
        scene.camera = cam
        cam_data.lens = 50
        dist = radius * 1.6 + 0.5
        for v in views:
            az, el = VIEWS.get(v, VIEWS["iso"])
            az, el = math.radians(az), math.radians(el)
            # Blender: -Y is front
            offset = mathutils.Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
            cam.location = center + offset
            direction = center - cam.location
            cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            cam_data.clip_end = dist * 10
            path = os.path.join(out_dir, f"{v}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            files.append({"view": v, "path": path})
    finally:
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
        bpy.data.objects.remove(light, do_unlink=True)
        bpy.data.lights.remove(light_data)
        scene.camera = saved["camera"]
        scene.render.engine = saved["engine"]
        scene.render.resolution_x = saved["x"]
        scene.render.resolution_y = saved["y"]
        scene.render.resolution_percentage = saved["pct"]
        scene.render.filepath = saved["path"]
        scene.render.film_transparent = saved["transparent"]
        for name, hidden in saved["hidden"].items():
            if name in scene.objects:
                scene.objects[name].hide_render = hidden
    return {"objects": [o.name for o in objs], "images": files}


def cmd_export(args):
    """Export objects to FBX for Roblox (meters -> studs scale, Y-up)."""
    objs = _mesh_objects(args.get("objects"))
    path = args.get("path") or os.path.join(tempfile.mkdtemp(prefix="sp_export_"), (args.get("name") or "Model") + ".fbx")
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=True,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        axis_forward="-Z",
        axis_up="Y",
        object_types={"MESH", "ARMATURE", "EMPTY"},
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        bake_anim=bool(args.get("animation", False)),
        path_mode="COPY",
        embed_textures=True,
    )
    return {"path": path, "objects": [o.name for o in objs], "bytes": os.path.getsize(path)}


# Roblox is Y-up with -Z forward; Blender is Z-up with -Y forward.
# Roblox (x, y, z) -> Blender (x, -z, y)
R2B = mathutils.Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def _primitive(shape, size):
    """Mesh data for a Roblox part shape in Roblox local space (studs)."""
    import bmesh

    sx, sy, sz = size
    bm = bmesh.new()
    if shape == "Ball":
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=0.5)
    elif shape == "Cylinder":  # Roblox cylinders run along X
        bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.5, radius2=0.5, depth=1.0,
                              matrix=mathutils.Matrix.Rotation(math.radians(90), 4, "Y"))
    elif shape in ("Wedge", "CornerWedge"):  # tall edge at the back (+Z), slope facing front (-Z)
        vs = [bm.verts.new(v) for v in [(-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, -0.5, 0.5), (-0.5, -0.5, 0.5),
                                         (-0.5, 0.5, 0.5), (0.5, 0.5, 0.5)]]
        for f in [(0, 1, 2, 3), (3, 2, 5, 4), (0, 3, 4), (1, 5, 2), (0, 4, 5, 1)]:
            bm.faces.new([vs[i] for i in f])
    else:
        bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = mathutils.Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    return bm


def cmd_build_from_studio(args):
    """Recreate Roblox parts (and MeshPart geometry when provided) in Blender."""
    import bmesh

    name = args.get("collection") or "FromStudio"
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    made = []
    for p in args.get("parts", []):
        if p.get("mesh"):
            bm = bmesh.new()
            vs = [bm.verts.new(v) for v in p["mesh"]["verts"]]
            for f in p["mesh"]["faces"]:
                try:
                    bm.faces.new([vs[i] for i in f])
                except ValueError:
                    pass  # duplicate face
        else:
            bm = _primitive(p.get("shape", "Block"), p["size"])
        bm.transform(R2B)  # local mesh into Blender axes
        me = bpy.data.meshes.new(p["name"])
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new(p["name"], me)
        coll.objects.link(obj)
        c = p["cframe"]  # x, y, z, then rotation matrix row by row (Roblox GetComponents order)
        rb = mathutils.Matrix(((c[3], c[4], c[5], c[0]), (c[6], c[7], c[8], c[1]), (c[9], c[10], c[11], c[2]), (0, 0, 0, 1)))
        obj.matrix_world = R2B @ rb @ R2B.inverted()
        if p.get("color"):
            mat = bpy.data.materials.new(f"{p['name']}_mat")
            r, g, b = p["color"]
            mat.diffuse_color = (r, g, b, 1 - p.get("transparency", 0))
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            if bsdf:
                bsdf.inputs["Base Color"].default_value = (r, g, b, 1)
            me.materials.append(mat)
        made.append(obj.name)
    return {"collection": coll.name, "created": made}


_restored_from = None


def cmd_save(args):
    path = args.get("path")
    if not path and bpy.data.filepath.startswith(CHECKPOINT_DIR):
        path = _restored_from
        if not path:
            raise ValueError("this scene came from a checkpoint of an unsaved file; pass a path to save it")
    if path:
        bpy.ops.wm.save_as_mainfile(filepath=path)
    else:
        bpy.ops.wm.save_mainfile()
    return {"file": bpy.data.filepath}



# ---------------------------------------------------------------- checkpoints

CHECKPOINT_DIR = os.environ.get("STUDIOPILOT_BLENDER_CHECKPOINTS") or os.path.join(tempfile.gettempdir(), "studiopilot-blender-checkpoints")
MAX_CHECKPOINTS = 30


def _checkpoint_list():
    if not os.path.isdir(CHECKPOINT_DIR):
        return []
    items = []
    for f in sorted(os.listdir(CHECKPOINT_DIR)):
        if f.endswith(".blend"):
            meta = os.path.join(CHECKPOINT_DIR, f[:-6] + ".json")
            label = ""
            if os.path.exists(meta):
                with open(meta) as fh:
                    label = json.load(fh).get("label", "")
            items.append({"id": f[:-6], "label": label})
    return items


def cmd_checkpoint(args):
    """Save a copy of the current scene so it can be restored later."""
    import time

    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    cid = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    path = os.path.join(CHECKPOINT_DIR, cid + ".blend")
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    with open(os.path.join(CHECKPOINT_DIR, cid + ".json"), "w") as fh:
        json.dump({"label": args.get("label", ""), "file": bpy.data.filepath}, fh)
    items = _checkpoint_list()
    for old in items[:-MAX_CHECKPOINTS]:
        for ext in (".blend", ".json"):
            with contextlib.suppress(OSError):
                os.remove(os.path.join(CHECKPOINT_DIR, old["id"] + ext))
    return {"id": cid}


def cmd_checkpoints(_args):
    return {"checkpoints": _checkpoint_list()}


def cmd_restore(args):
    """Reopen a checkpoint. The user's own file path is kept so Save still targets it."""
    cid = args["id"]
    path = os.path.join(CHECKPOINT_DIR, cid + ".blend")
    if not os.path.exists(path):
        raise ValueError(f"no checkpoint {cid}")
    meta = {}
    with contextlib.suppress(OSError, ValueError):
        with open(os.path.join(CHECKPOINT_DIR, cid + ".json")) as fh:
            meta = json.load(fh)
    global _restored_from
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
    _restored_from = meta.get("file") or None  # blender_save writes here, not into the checkpoint
    return {"restored": cid, "objects": len(bpy.data.objects), "saveTarget": _restored_from}


# ---------------------------------------------------------------- rigs and animation
#
# A Roblox rig is parts joined by Motor6Ds: Part1 = Part0 * C0 * Transform * C1^-1.
# Each Motor6D becomes a bone whose rest matrix is the joint frame (Part0 * C0)
# converted to Blender axes, so a pose's matrix_basis M and the Motor6D
# Transform T relate by M = R2B * T * R2B^-1.


def _cf_to_matrix(c):
    return mathutils.Matrix(((c[3], c[4], c[5], c[0]), (c[6], c[7], c[8], c[1]), (c[9], c[10], c[11], c[2]), (0, 0, 0, 1)))


def _matrix_to_cf(m):
    return [m[0][3], m[1][3], m[2][3], m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]


def cmd_import_rig(args):
    """Build an armature + parented meshes from a Studio rig export."""
    rig = args["rig"]
    name = rig["name"]
    parts = {p["name"]: p for p in rig["parts"]}
    built = cmd_build_from_studio({"parts": rig["parts"], "collection": args.get("collection") or name})
    coll = bpy.data.collections[built["collection"]]

    arm_data = bpy.data.armatures.new(name + "_Armature")
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    arm["studiopilot_rig"] = json.dumps({"joints": rig["joints"], "root": rig["root"], "studioPath": rig.get("path")})
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.selected_objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bones = {}
    for j in rig["joints"]:
        jw = _cf_to_matrix(parts[j["part0"]]["cframe"]) @ _cf_to_matrix(j["c0"])
        eb = arm_data.edit_bones.new(j["part1"])
        eb.head = (0, 0, 0)
        eb.tail = (0, 0.4, 0)
        eb.matrix = R2B @ jw @ R2B.inverted()
        eb.length = max(0.2, min(parts[j["part1"]]["size"]) * 0.6)
        bones[j["part1"]] = (eb, j["part0"])
    for bone_name, (eb, parent_part) in bones.items():
        if parent_part in bones:
            eb.parent = bones[parent_part][0]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")

    for pname in parts:
        obj = bpy.data.objects.get(pname)
        if obj is None:
            continue
        world = obj.matrix_world.copy()
        if pname in bones:
            obj.parent = arm
            obj.parent_type = "BONE"
            obj.parent_bone = pname
        else:
            obj.parent = arm
        obj.matrix_world = world
    return {"armature": arm.name, "bones": list(bones), "collection": coll.name}


def _rig_meta(arm):
    raw = arm.get("studiopilot_rig")
    if not raw:
        raise ValueError(f"{arm.name} was not imported from Studio (no joint data)")
    return json.loads(raw)


def cmd_export_animation(args):
    """Sample an armature's action into Roblox keyframes (Motor6D Transforms per part)."""
    arm = bpy.data.objects[args["armature"]]
    _rig_meta(arm)
    scene = bpy.context.scene
    action = arm.animation_data.action if arm.animation_data else None
    if action is None:
        raise ValueError(f"{arm.name} has no action")
    fps = scene.render.fps / scene.render.fps_base
    if args.get("keyframes_only", True):
        frames = sorted({round(k.co[0]) for fc in _action_fcurves(action, arm) for k in fc.keyframe_points})
    else:
        start, end = (int(v) for v in action.frame_range)
        step = max(1, int(args.get("step", 1)))
        frames = list(range(start, end + 1, step))
    if not frames:
        raise ValueError("no keyframes found")
    first = frames[0]
    inv = R2B.inverted()
    out = []
    current = scene.frame_current
    try:
        for f in frames:
            scene.frame_set(f)
            poses = {}
            for pb in arm.pose.bones:
                t = inv @ pb.matrix_basis @ R2B
                poses[pb.name] = [round(v, 6) for v in _matrix_to_cf(t)]
            out.append({"time": round((f - first) / fps, 4), "poses": poses})
    finally:
        scene.frame_set(current)
    return {"armature": arm.name, "action": action.name, "fps": fps, "loop": bool(args.get("loop", False)), "keyframes": out}


def _action_fcurves(action, arm):
    # Blender 4.4+ layered actions keep fcurves in channelbags
    if hasattr(action, "fcurves") and len(action.fcurves):
        return list(action.fcurves)
    curves = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                curves.extend(bag.fcurves)
    return curves


def cmd_import_animation(args):
    """Apply Roblox keyframes (Motor6D Transforms by part name) as an action."""
    arm = bpy.data.objects[args["armature"]]
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    if arm.animation_data is None:
        arm.animation_data_create()
    action = bpy.data.actions.new(args.get("name") or "StudioAnimation")
    arm.animation_data.action = action
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for kf in args["keyframes"]:
        frame = 1 + kf["time"] * fps
        for bone_name, cf in kf["poses"].items():
            pb = arm.pose.bones.get(bone_name)
            if pb is None:
                continue
            pb.matrix_basis = R2B @ _cf_to_matrix(cf) @ R2B.inverted()
            pb.keyframe_insert("location", frame=frame)
            pb.keyframe_insert("rotation_quaternion", frame=frame)
    scene.frame_start = 1
    scene.frame_end = int(1 + max(k["time"] for k in args["keyframes"]) * fps)
    return {"action": action.name, "frames": [scene.frame_start, scene.frame_end]}


COMMANDS = {
    "ping": cmd_ping,
    "scene": cmd_scene,
    "run_python": cmd_run_python,
    "render": cmd_render,
    "export": cmd_export,
    "build_from_studio": cmd_build_from_studio,
    "save": cmd_save,
    "checkpoint": cmd_checkpoint,
    "checkpoints": cmd_checkpoints,
    "restore": cmd_restore,
    "import_rig": cmd_import_rig,
    "export_animation": cmd_export_animation,
    "import_animation": cmd_import_animation,
}

# ---------------------------------------------------------------- main-thread pump


def _pump():
    while True:
        try:
            name, args, box = _jobs.get_nowait()
        except queue.Empty:
            break
        try:
            box["result"] = {"ok": True, "result": COMMANDS[name](args)}
        except Exception as e:  # report the whole traceback to the agent
            box["result"] = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
        box["done"].set()
    return 0.05


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        name = self.path.strip("/")
        if name not in COMMANDS:
            return self._send(404, {"ok": False, "error": f"unknown command {name}"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            args = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as e:
            return self._send(400, {"ok": False, "error": str(e)})
        box = {"done": threading.Event()}
        _jobs.put((name, args, box))
        if not box["done"].wait(timeout=float(args.get("timeout", 300))):
            return self._send(504, {"ok": False, "error": "Blender did not finish in time (is a modal dialog open?)"})
        self._send(200, box["result"])

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "app": "studiopilot-blender", "adapter": VERSION, "blender": bpy.app.version_string})
        self._send(404, {"ok": False})


def start():
    import builtins

    if getattr(builtins, "_studiopilot_server", None):
        return
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    builtins._studiopilot_server = server  # survives re-running the script
    bpy.app.timers.register(_pump, persistent=True)
    print(f"[StudioPilot] Blender adapter listening on 127.0.0.1:{PORT}")


start()

# In background mode (blender -b) there is no event loop to run timers, so
# drive the pump ourselves until killed.
if bpy.app.background and os.environ.get("STUDIOPILOT_BLENDER_BLOCK", "1") == "1":
    import time

    while True:
        _pump()
        time.sleep(0.05)
