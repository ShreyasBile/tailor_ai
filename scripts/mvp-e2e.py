"""End-to-end test of the Body Intelligence MVP journey against the running stack.

    fresh user → profile + consent → four tagged photos → scan job
    → stored measurements (≥10, with confidence) → 3D avatar
    → Find My Size on a garment → fit feedback
    plus: a bad scan is rejected with per-photo, user-readable reasons.

Uses the sample scan in apps/web/public/demo-scan (regenerate with
scripts/make-demo-scan.py). Run with the stack up:

    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\mvp-e2e.py
"""

from __future__ import annotations

import hashlib
import io
import sys
import time
from pathlib import Path

import cv2
import httpx
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]


def _api_base() -> str:
    """TAILORAI_API, else API_PORT from the repo's .env (another local app may
    hold 3000), else 3000."""
    import os  # noqa: PLC0415
    import re  # noqa: PLC0415

    if os.getenv("TAILORAI_API"):
        return os.environ["TAILORAI_API"].rstrip("/")
    env = ROOT / ".env"
    m = re.search(r"^API_PORT=(\d+)", env.read_text(encoding="utf-8"), re.M) if env.exists() else None
    return f"http://127.0.0.1:{m.group(1) if m else 3000}/v1"


API = _api_base()
DEMO = ROOT / "apps" / "web" / "public" / "demo-scan"
VIEWS = ("front", "back", "left", "right")
EMAIL = f"mvp-e2e-{int(time.time())}@tailorai.test"

_ok = _fail = 0


def check(cond: bool, label: str) -> None:
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  ✔ {label}")
    else:
        _fail += 1
        print(f"  ✘ {label}")


def step(label: str) -> None:
    print(f"\n▸ {label}")


def upload_scan(c: httpx.Client, images: dict[str, bytes]) -> str:
    """Session → four tagged multipart uploads → finalise → job id."""
    session = c.post("/capture-sessions", json={"mode": "PHOTO_SET"}).raise_for_status().json()
    for view, data in images.items():
        up = c.post(
            f"/capture-sessions/{session['id']}/uploads",
            json={
                "kind": "RAW_PHOTO",
                "fileName": f"{view}.jpg",
                "sizeBytes": len(data),
                "mimeType": "image/jpeg",
                "clientFingerprint": hashlib.sha256(data + view.encode()).hexdigest(),
                "partSizeBytes": 5 * 1024 * 1024,
                "view": view,
            },
        ).raise_for_status().json()
        part = up["parts"][0]
        r = httpx.put(part["url"], content=data, headers={"content-type": "image/jpeg"}, timeout=60)
        r.raise_for_status()
        c.post(
            f"/uploads/{up['uploadId']}/complete",
            json={"parts": [{"partNumber": 1, "etag": r.headers["etag"].strip('"')}]},
        ).raise_for_status()
    c.post(f"/capture-sessions/{session['id']}/finalise").raise_for_status()
    job = c.post(
        "/jobs", json={"sessionId": session["id"], "options": {"quality": "standard", "textured": False}}
    ).raise_for_status().json()
    return job["id"]


def wait(c: httpx.Client, job_id: str, timeout_s: int = 240) -> dict:
    end = time.time() + timeout_s
    while time.time() < end:
        job = c.get(f"/jobs/{job_id}").raise_for_status().json()
        if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            return job
        time.sleep(1.5)
    raise TimeoutError(job_id)


def main() -> None:
    if not all((DEMO / f"{v}.jpg").exists() for v in VIEWS):
        sys.exit(f"sample scan missing in {DEMO} — run scripts/make-demo-scan.py")
    images = {v: (DEMO / f"{v}.jpg").read_bytes() for v in VIEWS}

    print("\n  TailorAI · Body Intelligence MVP — end-to-end")
    c = httpx.Client(base_url=API, timeout=60)

    step("Account and profile")
    tokens = c.post("/auth/session", json={"token": EMAIL}).raise_for_status().json()
    c.headers["authorization"] = f"Bearer {tokens['accessToken']}"
    me = c.patch("/me", json={"heightCm": 172, "sexAtBirth": "MALE", "fitPreference": "REGULAR"}).json()
    check(me["heightCm"] == 172 and me["fitPreference"] == "REGULAR", "height and fit preference saved")
    c.post("/me/consents", json={"kind": "BIOMETRIC_PROCESSING", "version": "biometric-v1", "granted": True})

    step("Bad scan is rejected with per-photo reasons")
    blank = cv2.imencode(".jpg", np.full((1440, 1080, 3), 200, np.uint8))[1].tobytes()
    bad = wait(c, upload_scan(c, {**images, "front": blank}))
    report = bad.get("scanReport") or {}
    check(bad["status"] == "FAILED" and bad["errorCode"] == "SCAN_REJECTED", "job fails with SCAN_REJECTED")
    front_issues = [i for i in report.get("issues", []) if i["view"] == "front"]
    check(any(i["code"] == "NO_PERSON" for i in front_issues), "front photo flagged: no person found")
    check(all(i["message"] for i in report.get("issues", [])), "every issue has a user-facing message")
    check(all(v["ok"] for v in report.get("views", []) if v["view"] != "front"), "the other three photos pass")

    step("Four-view scan → Body Profile")
    t0 = time.time()
    job = wait(c, upload_scan(c, images))
    check(job["status"] == "COMPLETED", f"scan completed in {time.time() - t0:.1f}s")
    stages = {s["name"]: s["status"] for s in job["stages"]}
    check(stages.get("S3B_SCAN_ANALYZE") == "SUCCEEDED", "scan-analysis stage ran")

    meas = c.get("/me/measurements").raise_for_status().json()
    details = meas.get("details") or []
    check(len(details) >= 10, f"{len(details)} measurements stored (≥10 required)")
    check(all(0 < d["confidence"] <= 1 for d in details), "every measurement carries a confidence")
    check(any(d["typicalErrorCm"] for d in details), "typical error (from validation) attached")
    by = {d["name"]: d["value"] for d in details}
    check(by.get("height") == 172, "height anchors the scale exactly")
    check(70 < by.get("chest", 0) < 140 and 55 < by.get("waist", 0) < 130, "chest and waist are plausible")

    avatar = c.get("/me/avatar").raise_for_status().json()
    glb = httpx.get(avatar["assets"]["glb"]["url"], timeout=60)
    check(glb.status_code == 200 and glb.content[:4] == b"glTF", f"3D body downloadable ({len(glb.content) // 1024} KB GLB)")
    import trimesh  # noqa: PLC0415

    mesh = trimesh.load(io.BytesIO(glb.content), file_type="glb", force="mesh")
    h = (mesh.bounds[1][1] - mesh.bounds[0][1]) * 100
    check(abs(h - 172) < 1.5, f"3D body is {h:.1f} cm tall (user: 172 cm)")

    step("Find My Size")
    garments = c.get("/garments").raise_for_status().json()
    check(len(garments) >= 10, f"catalogue has {len(garments)} garments")
    rec = c.post("/garments/northline-crew-tee/recommend", json={}).raise_for_status().json()
    check(bool(rec["recommendedSize"]) and 0 <= rec["fitScore"] <= 100,
          f"crew tee → size {rec['recommendedSize']}, fit {rec['fitScore']} ({rec['fitLabel']})")
    # Rules text, or (GEMINI_API_KEY set) Gemini's rewrite, which must name the size.
    explained = (rec["explanation"].startswith("We recommend")
                 or (rec.get("explanationSource", "").startswith("gemini")
                     and rec["recommendedSize"] in rec["explanation"]))
    check(len(rec["dimensions"]) >= 3 and explained,
          f"recommendation explains the key dimensions ({rec.get('explanationSource', 'rules')})")
    trousers = c.post("/garments/denim-theory-cargo-pant/recommend", json={"preference": "LOOSE"}).raise_for_status().json()
    check(any(d["name"] == "inseam" for d in trousers["dimensions"]), f"trousers use waist/hip/inseam → {trousers['recommendedSize']}")
    snug = c.post("/garments/northline-crew-tee/recommend", json={"preference": "SNUG"}).json()
    loose = c.post("/garments/northline-crew-tee/recommend", json={"preference": "LOOSE"}).json()
    order = ["XS", "S", "M", "L", "XL", "XXL"]
    check(order.index(snug["recommendedSize"]) <= order.index(loose["recommendedSize"]),
          f"preference moves the size the right way (snug {snug['recommendedSize']} ≤ loose {loose['recommendedSize']})")

    fb = c.post(f"/recommendations/{rec['id']}/feedback", json={"sizeChosen": rec["recommendedSize"], "outcome": "PERFECT"})
    check(fb.status_code in (200, 201), "fit feedback recorded")
    recs = c.get("/me/recommendations").json()
    check(len(recs) >= 2, f"{len(recs)} recommendations in history (latest per garment)")

    print(f"\n  {_ok} passed, {_fail} failed\n")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()
