# Runs with plain python3 against an adapter on STUDIOPILOT_BLENDER_PORT.
# Checks rig import + animation round trip against Roblox's Motor6D math.
import json, math, os, urllib.request
PORT = int(os.environ.get("STUDIOPILOT_BLENDER_PORT", "18767"))
def call(cmd, args=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/{cmd}", data=json.dumps(args or {}).encode(), method="POST")
    r = json.loads(urllib.request.urlopen(req, timeout=120).read())
    if not r["ok"]: raise SystemExit(f"{cmd} failed: {r['error']}\n{r.get('traceback','')}")
    return r["result"]

# --- tiny CFrame math (Roblox convention, row-major 3x3 + position)
def cf(x=0, y=0, z=0, R=None): return [x, y, z] + (R or [1,0,0, 0,1,0, 0,0,1])
def mul(a, b):
    R = [sum(a[3 + r*3 + k] * b[3 + k*3 + c] for k in range(3)) for r in range(3) for c in range(3)]
    p = [a[r] + sum(a[3 + r*3 + k] * b[k] for k in range(3)) for r in range(3)]
    return p + R
def inv(a):
    Rt = [a[3 + c*3 + r] for r in range(3) for c in range(3)]
    p = [-sum(Rt[r*3 + k] * a[k] for k in range(3)) for r in range(3)]
    return p + Rt
def rotx(t): c, s = math.cos(t), math.sin(t); return [1,0,0, 0,c,-s, 0,s,c]
def roty(t): c, s = math.cos(t), math.sin(t); return [c,0,s, 0,1,0, -s,0,c]

parts = {
    "HumanoidRootPart": cf(0, 3, 0), "LowerTorso": cf(0, 2.8, 0), "UpperTorso": cf(0, 3.8, 0),
    "Head": cf(0, 5, 0), "RightUpperArm": cf(1.5, 4, 0),
}
joints = [  # name, part0, part1, C0, C1   (C0/C1 chosen so rest pose is consistent)
    ("Root", "HumanoidRootPart", "LowerTorso", cf(0, -0.2, 0), cf(0, 0, 0)),
    ("Waist", "LowerTorso", "UpperTorso", cf(0, 0.5, 0), cf(0, -0.5, 0)),
    ("Neck", "UpperTorso", "Head", cf(0, 0.8, 0), cf(0, -0.4, 0)),
    ("RightShoulder", "UpperTorso", "RightUpperArm", cf(1.2, 0.5, 0, roty(0.3)), mul(cf(-0.3, 0.3, 0), cf(0, 0, 0, roty(0.3)))),
]
# make Part1 rest positions match their joints exactly: P1 = P0*C0*C1^-1
for _, p0, p1, c0, c1 in joints:
    parts[p1] = mul(mul(parts[p0], c0), inv(c1))
rig = {"name": "TestRig", "root": "HumanoidRootPart",
       "parts": [{"name": n, "shape": "Block", "size": [1, 1, 1], "cframe": c, "color": [0.7, 0.7, 0.7]} for n, c in parts.items()],
       "joints": [{"name": n, "part0": a, "part1": b, "c0": c0, "c1": c1} for n, a, b, c0, c1 in joints]}

call("run_python", {"code": "for o in list(bpy.data.objects): bpy.data.objects.remove(o)"})
ck = call("checkpoint", {"label": "empty"})
r = call("import_rig", {"rig": rig}); print("import_rig:", r)

T = {"LowerTorso": cf(0, 0, 0, roty(0.4)), "UpperTorso": cf(0, 0.1, 0, rotx(0.3)), "Head": cf(0, 0, 0, roty(-0.6)), "RightUpperArm": cf(0, 0, 0, rotx(-1.2))}
kfs = [{"time": 0, "poses": {k: cf() for k in T}}, {"time": 0.5, "poses": T}]
print("import_animation:", call("import_animation", {"armature": "TestRig", "keyframes": kfs, "name": "Wave"}))

# expected Roblox world CFrames at t=0.5
world = {"HumanoidRootPart": parts["HumanoidRootPart"]}
for _, p0, p1, c0, c1 in joints:  # joints are in parent-first order
    world[p1] = mul(mul(mul(world[p0], c0), T[p1]), inv(c1))
got = call("run_python", {"code": """
bpy.context.scene.frame_set(int(1 + 0.5 * bpy.context.scene.render.fps))
inv = R2B_INV
result = {}
for n in %s:
    m = inv @ bpy.data.objects[n].matrix_world @ R2B_M
    result[n] = [m[0][3], m[1][3], m[2][3], m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
""".replace("R2B_INV", "mathutils.Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1))).inverted()").replace("R2B_M", "mathutils.Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))") % json.dumps(list(T))})["result"]
worst = max(abs(a - b) for n in T for a, b in zip(world[n], got[n]))
print(f"posed part error vs Roblox math: {worst:.2e}")
assert worst < 1e-3, (world, got)

back = call("export_animation", {"armature": "TestRig"})
last = back["keyframes"][-1]["poses"]
err = max(abs(a - b) for n in T for a, b in zip(T[n], last[n]))
print(f"exported Transform error: {err:.2e}, times {[k['time'] for k in back['keyframes']]}")
assert err < 1e-3

print("checkpoints:", len(call("checkpoints")["checkpoints"]))
print("restore:", call("restore", {"id": ck["id"]}))
assert call("scene")["objects"] == [], "restore should bring back the empty scene"
print("RIG TESTS PASSED")
