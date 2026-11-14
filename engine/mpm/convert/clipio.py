# SPDX-License-Identifier: GPL-3.0-or-later
"""Pose-pack files (contracts section 9): clips/<id>.f32 and index.json."""

import json
import os
import struct

import numpy as np


def write_clip(path, frames, contacts):
    """frames (F, J, 7) float32 [px,py,pz,qw,qx,qy,qz]; contacts (F,) uint32."""
    F, J, _ = frames.shape
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"MPM0" + struct.pack("<III", F, J, 1))
        fh.write(np.ascontiguousarray(frames, dtype="<f4").tobytes())
        fh.write(np.ascontiguousarray(contacts, dtype="<u4").tobytes())


def read_clip(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"MPM0":
        raise ValueError("not an MPM0 clip")
    F, J, ver = struct.unpack("<III", data[4:16])
    body = np.frombuffer(data, "<f4", F * J * 7, 16).reshape(F, J, 7)
    contacts = np.frombuffer(data, "<u4", F, 16 + F * J * 7 * 4)
    return body, contacts


def add_to_pack(pack_dir, pack_meta, conv):
    """Write a converted clip into a pack and merge its entry into index.json. Returns the clip id."""
    idx_path = os.path.join(pack_dir, "index.json")
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as fh:
            index = json.load(fh)
        if index.get("joints") != conv["names"]:
            raise ValueError("clip joints differ from the pack's joint list")
    else:
        index = {"schema": "mpm.pack/1", "pack": pack_meta["pack"], "title": pack_meta.get("title", pack_meta["pack"]),
                 "license": pack_meta.get("license", ""), "license_url": pack_meta.get("license_url", ""),
                 "exportable": bool(pack_meta.get("exportable", False)), "joints": conv["names"],
                 "has_fingers": False, "clips": []}
    cid = conv["id"]
    write_clip(os.path.join(pack_dir, "clips", cid + ".f32"), conv["frames"], conv["contacts"])
    entry = {"id": cid, "move": conv["meta"]["move"], "style": conv["meta"]["style"],
             "tags": pack_meta.get("tags_for", {}).get(conv["meta"]["move"], []),
             "frames": int(conv["frames"].shape[0]), "fps": conv["fps"], "key_frames": conv["key_frames"]}
    index["clips"] = [c for c in index["clips"] if c["id"] != cid] + [entry]
    index["clips"].sort(key=lambda c: c["id"])
    tmp = idx_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    os.replace(tmp, idx_path)
    return cid
