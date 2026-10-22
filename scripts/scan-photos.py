"""Scan four photos of a real person through the running stack.

Creates (or reuses) an account, uploads front/back/left/right through the same
API the web app uses, waits for the scan, and saves the results:

    <out>/measurements.json   the scan report (per-view quality, measurements)
    <out>/body.glb            the fitted 3D body

    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\scan-photos.py ^
        --email me@example.test --height 175 ^
        --front f.jpg --back b.jpg --left l.jpg --right r.jpg --out .data\\scans\\me

Small photos are fine: the service enlarges them itself and judges each one by
how many pixels tall the person is. `--upscale` is accepted for old commands
but does nothing — enlarging here would hide a photo's real resolution from
that check.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import httpx

sys.stdout.reconfigure(encoding="utf-8")
API = "http://127.0.0.1:3000/v1"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--height", type=float, required=True, help="cm, barefoot")
    for v in ("front", "back", "left", "right"):
        ap.add_argument(f"--{v}", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--upscale", action="store_true", help="no-op; the service upscales")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    images: dict[str, bytes] = {}
    for v in ("front", "back", "left", "right"):
        img = cv2.imread(getattr(a, v))
        if img is None:
            sys.exit(f"cannot read {getattr(a, v)}")
        images[v] = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 94])[1].tobytes()

    c = httpx.Client(base_url=API, timeout=60)
    tok = c.post("/auth/session", json={"token": a.email}).raise_for_status().json()
    c.headers["authorization"] = f"Bearer {tok['accessToken']}"
    c.patch("/me", json={"heightCm": a.height}).raise_for_status()
    c.post("/me/consents", json={"kind": "BIOMETRIC_PROCESSING", "version": "biometric-v1", "granted": True})

    session = c.post("/capture-sessions", json={"mode": "PHOTO_SET"}).raise_for_status().json()
    for view, data in images.items():
        up = c.post(f"/capture-sessions/{session['id']}/uploads", json={
            "kind": "RAW_PHOTO", "fileName": f"{view}.jpg", "sizeBytes": len(data),
            "mimeType": "image/jpeg", "partSizeBytes": 5 * 1024 * 1024, "view": view,
            "clientFingerprint": hashlib.sha256(data + view.encode()).hexdigest(),
        }).raise_for_status().json()
        r = httpx.put(up["parts"][0]["url"], content=data, headers={"content-type": "image/jpeg"}, timeout=60)
        r.raise_for_status()
        c.post(f"/uploads/{up['uploadId']}/complete",
               json={"parts": [{"partNumber": 1, "etag": r.headers["etag"].strip('"')}]}).raise_for_status()
    c.post(f"/capture-sessions/{session['id']}/finalise").raise_for_status()
    job = c.post("/jobs", json={"sessionId": session["id"],
                                "options": {"quality": "standard", "textured": False}}).raise_for_status().json()

    print(f"scan job {job['id']} …", end="", flush=True)
    while True:
        j = c.get(f"/jobs/{job['id']}").json()
        if j["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(1.5)
    print(f" {j['status']}")
    (out / "measurements.json").write_text(json.dumps(j.get("scanReport"), indent=2), encoding="utf-8")
    if j["status"] != "COMPLETED":
        for i in (j.get("scanReport") or {}).get("issues", []):
            print(f"  {i['view']}: {i['message']}")
        sys.exit(1)

    avatar = c.get("/me/avatar").raise_for_status().json()
    (out / "body.glb").write_bytes(httpx.get(avatar["assets"]["glb"]["url"], timeout=60).content)
    for m in j["scanReport"]["measurements"]:
        print(f"  {m['label']:15} {m['value']:6.1f} cm   confidence {m['confidence']:.2f}")
    print(f"saved to {out}")


if __name__ == "__main__":
    main()
