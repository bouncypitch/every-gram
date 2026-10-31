#!/usr/bin/env python
"""Export the Berkeley Humanoid Lite URDF to web assets.

Run from anywhere:
    /Users/kdotmahesh/Code/every-gram/.venv/bin/python web/scripts/export_scene.py

Writes web/public/data/parts/<link>.glb and web/public/data/robot.json.

Frames
  matrix   column-major 4x4 (three.js Matrix4.fromArray): mesh file coords ->
           robot world at zero pose, i.e. FK(link) * visual_origin. World is the
           URDF frame: metres, Z up, X forward.
  explode  world-frame offset in metres applied at full explode.
  mesh_opt must be in the same coordinates as the source STL / `mesh`, so the
           same `matrix` places it.

Re-running keeps mass_opt_g, status, mesh_opt, checks and designs already in robot.json,
so it is safe to run after the physics worker has written results.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB.parent
ROBOT_DIR = ROOT / "assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite"
URDF = ROBOT_DIR / "urdf/berkeley_humanoid_lite.urdf"
OUT = WEB / "public/data"
GLTFPACK = WEB / "node_modules/.bin/gltfpack"
MAX_BYTES = 15 * 1024 * 1024
CREASE_DEG = 32


def vec(el, attr, default="0 0 0"):
    raw = el.get(attr, default) if el is not None else default
    return np.array([float(v) for v in raw.split()])


def origin_matrix(origin):
    """URDF <origin>: translate xyz, then fixed-axis roll-pitch-yaw (Rz Ry Rx)."""
    x, y, z = vec(origin, "xyz")
    r, p, yaw = vec(origin, "rpy")
    T = trimesh.transformations.euler_matrix(r, p, yaw, axes="sxyz")
    T[:3, 3] = [x, y, z]
    return T


def forward_kinematics(root):
    """Zero pose: every joint contributes only its fixed origin."""
    children = {}
    has_parent = set()
    for j in root.findall("joint"):
        p, c = j.find("parent").get("link"), j.find("child").get("link")
        children.setdefault(p, []).append((c, origin_matrix(j.find("origin"))))
        has_parent.add(c)
    roots = [l.get("name") for l in root.findall("link") if l.get("name") not in has_parent]
    assert len(roots) == 1, roots
    fk = {roots[0]: np.eye(4)}
    stack = [roots[0]]
    while stack:
        p = stack.pop()
        for c, T in children.get(p, []):
            fk[c] = fk[p] @ T
            stack.append(c)
    return fk


def label_for(link):
    if link == "base":
        return "Torso"
    if link == "imu_2":
        return "IMU board"
    limb, side, *rest = link.split("_")
    side = side.capitalize()
    joint = "_".join(rest)
    names = {
        "ankle_pitch": "ankle yoke",
        "ankle_roll": "foot",
        "hand_link": "hand",
        "elbow_roll": "elbow roll link",
        "elbow_pitch": "elbow pitch link",
        "knee_pitch": "knee link",
    }
    return f"{side} {names.get(joint, joint.replace('_', ' ') + ' link')}"


def group_for(link):
    return "arm" if link.startswith("arm") else "leg" if link.startswith("leg") else "torso"


def explode_for(link, c, center):
    """Spread limbs outward so each part reads alone from the front."""
    d = c - center
    if link == "base":
        return [0.0, 0.0, 0.0]
    if link == "imu_2":
        return [0.34, 0.0, 0.12]
    side = np.sign(c[1]) or 1.0
    if link.startswith("arm"):
        off = np.array([d[0] * 0.5, d[1] * 2.1 + side * 0.13, d[2] * 0.35 + 0.1])
    else:
        off = np.array([d[0] * 0.5, d[1] * 2.6 + side * 0.07, d[2] * 1.05 - 0.2])
    return [round(float(v), 4) for v in off]


def load_mesh(path):
    m = trimesh.load(path, force="mesh", process=True)
    m.merge_vertices()
    m.remove_unreferenced_vertices()
    # Split along hard edges so CAD corners stay sharp and curves stay smooth.
    shaded = trimesh.graph.smooth_shade(m, angle=np.radians(CREASE_DEG))
    shaded.vertex_normals  # force compute so the GLB carries normals
    return m, shaded


def pack(tmp_glb, dest, simplify=None):
    """gltfpack: meshopt-compress. Only simplifies if the size budget demands it."""
    cmd = [str(GLTFPACK), "-i", str(tmp_glb), "-o", str(dest), "-cc", "-vn", "10", "-kn"]
    if simplify:
        cmd += ["-si", str(simplify)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode or not dest.exists():
        sys.exit(f"gltfpack failed for {tmp_glb.name}: {r.stdout}{r.stderr}")


def main():
    if not GLTFPACK.exists():
        sys.exit("Run `npm install` in web/ first (needs gltfpack).")
    root = ET.parse(URDF).getroot()
    fk = forward_kinematics(root)

    prior = {}
    rj = OUT / "robot.json"
    if rj.exists():
        prior = {p["id"]: p for p in json.loads(rj.read_text()).get("parts", [])}

    (OUT / "parts").mkdir(parents=True, exist_ok=True)
    links = []
    total_mass = 0.0
    for link in root.findall("link"):
        name = link.get("name")
        mass_el = link.find("inertial/mass")
        mass = float(mass_el.get("value")) if mass_el is not None else 0.0
        total_mass += mass
        vis = link.findall("visual")
        if not vis:
            print(f"skip {name}: no visual ({mass * 1000:.6f} g)")
            continue
        assert len(vis) == 1, name
        v = vis[0]
        stl = (URDF.parent / v.find("geometry/mesh").get("filename").removeprefix("package://")).resolve()
        M = fk[name] @ origin_matrix(v.find("origin"))
        links.append((name, mass, M, stl))

    tmp = Path(tempfile.mkdtemp(prefix="every-gram-"))
    meshes = {}
    world_pts = []
    for name, _, M, stl in links:
        raw, shaded = load_mesh(stl)
        meshes[name] = shaded
        lo, hi = raw.bounds
        world_pts.append((M @ np.array([*((lo + hi) / 2), 1.0]))[:3])
        shaded.export(tmp / f"{name}.glb")

    def write_all(simplify=None):
        for name, *_ in links:
            pack(tmp / f"{name}.glb", OUT / "parts" / f"{name}.glb", simplify)
        return sum((OUT / "parts" / f"{n}.glb").stat().st_size for n, *_ in links)

    size = write_all()
    for ratio in (0.7, 0.5, 0.3):
        if size <= MAX_BYTES:
            break
        print(f"{size / 1e6:.1f} MB over budget, simplifying to {ratio}")
        size = write_all(ratio)
    shutil.rmtree(tmp)

    pts = np.array(world_pts)
    center = np.array([pts[:, 0].mean(), pts[:, 1].mean(), 0.5 * (pts[:, 2].min() + pts[:, 2].max())])
    parts = []
    for (name, mass, M, _), c in zip(links, pts):
        keep = prior.get(name, {})
        parts.append({
            "id": name,
            "label": label_for(name),
            "group": group_for(name),
            "mass_g": round(mass * 1000, 2),
            "mass_opt_g": keep.get("mass_opt_g"),
            "status": keep.get("status", "untouched"),
            "matrix": [round(float(x), 7) for x in M.T.ravel()],
            "explode": explode_for(name, c, center),
            "mesh": f"parts/{name}.glb",
            "mesh_opt": keep.get("mesh_opt"),
            "checks": keep.get("checks", {}),
            **({"designs": keep["designs"]} if "designs" in keep else {}),
        })
    doc = {
        "robot": {
            "name": "Berkeley Humanoid Lite",
            "source": "https://github.com/HybridRobotics/Berkeley-Humanoid-Lite",
            "mass_kg": round(total_mass, 2),
        },
        "parts": parts,
    }
    rj.write_text(json.dumps(doc, indent=1))
    print(f"{len(parts)} parts, {total_mass:.3f} kg, {size / 1e6:.2f} MB of GLB -> {rj}")


if __name__ == "__main__":
    main()
