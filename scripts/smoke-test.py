"""Full user journey against the running stack.

Exercises the real HTTP API, the real database, the real queue, real object
storage and the real orchestrator — sign-in, consent, capture upload, job
creation, live progress, and avatar download.

This is the test that proves the system works, as opposed to proving the
reconstruction maths works (tests/test_e2e.py already does that). Run it with
the stack up:

    .venv/Scripts/python.exe ../../scripts/smoke-test.py
"""

from __future__ import annotations

import io
import sys
import time
from pathlib import Path

import cv2
import httpx
import numpy as np

# Windows consoles default to cp1252, which can't encode the ▸/✔ glyphs below.
sys.stdout.reconfigure(encoding="utf-8")

def _api_base() -> str:
    """TAILORAI_API, else API_PORT from the repo's .env (another local app may
    hold 3000), else 3000."""
    import os  # noqa: PLC0415
    import re  # noqa: PLC0415

    if os.getenv("TAILORAI_API"):
        return os.environ["TAILORAI_API"].rstrip("/")
    env = Path(__file__).resolve().parents[1] / ".env"
    m = re.search(r"^API_PORT=(\d+)", env.read_text(encoding="utf-8"), re.M) if env.exists() else None
    return f"http://127.0.0.1:{m.group(1) if m else 3000}/v1"


API = _api_base()

# A fresh user per run. The consent gate can only be exercised on an account
# that has not yet consented, and a test that passes only against a virgin
# database is a test that stops testing anything after the first run.
EMAIL = f"smoke-{int(time.time())}@tailorai.test"

HEIGHT_CM = 174.0
PHOTO_COUNT = 4

_ok = 0
_fail = 0


def step(label: str) -> None:
    print(f"\n\033[36m▸ {label}\033[0m")


def ok(msg: str) -> None:
    global _ok
    _ok += 1
    print(f"  \033[32m✔\033[0m {msg}")


def fail(msg: str) -> None:
    global _fail
    _fail += 1
    print(f"  \033[31m✘\033[0m {msg}")


def die(msg: str) -> None:
    fail(msg)
    summary()
    sys.exit(1)


def summary() -> None:
    print(f"\n  {_ok} passed, {_fail} failed\n")


def synthetic_person(width: int, height: int, yaw_deg: float) -> bytes:
    """A plain-background humanoid silhouette — the capture we ask users for."""
    img = np.full((height, width, 3), 205, dtype=np.uint8)
    rng = np.random.default_rng(int(yaw_deg))
    img = np.clip(img.astype(np.int16) + rng.integers(-6, 6, img.shape), 0, 255).astype(np.uint8)

    cx = width // 2
    top = int(height * 0.08)
    body_h = int(height * 0.84)

    rad = np.deg2rad(yaw_deg)

    # Every view must be genuinely distinct, or near-duplicate rejection will
    # (correctly) discard half of them and the capture will score as poor
    # coverage. Width uses cos — separating front from back — and the subject
    # shifts laterally with sin, separating left from right. A single |cos|
    # term would make 0°/180° and 90°/270° pixel-identical, which no real
    # person is.
    side = 0.72 + 0.28 * np.cos(rad)
    cx += int(width * 0.045 * np.sin(rad))

    shade = int(55 + (yaw_deg % 360) * (70 / 360))
    colour = (shade, shade - 5, shade - 10)

    head_r = int(body_h * 0.062)
    cv2.circle(img, (cx, top + head_r), head_r, colour, -1)
    # Face marker on front-facing views only.
    if abs(((yaw_deg + 180) % 360) - 180) < 80:
        cv2.circle(img, (cx, top + head_r), int(head_r * 0.55), (150, 140, 130), -1)

    shoulder_y = top + int(body_h * 0.20)
    hip_y = top + int(body_h * 0.53)
    hs = int(body_h * 0.105 * side)
    hh = int(body_h * 0.088 * side)

    cv2.rectangle(img, (cx - int(head_r * 0.4), top + head_r), (cx + int(head_r * 0.4), shoulder_y), colour, -1)
    cv2.fillPoly(img, [np.array([(cx - hs, shoulder_y), (cx + hs, shoulder_y), (cx + hh, hip_y), (cx - hh, hip_y)], dtype=np.int32)], colour)

    limb = max(2, int(body_h * 0.026 * side))
    foot_y = top + body_h
    cv2.line(img, (cx - hs, shoulder_y), (cx - int(hs * 1.9), hip_y), colour, limb)
    cv2.line(img, (cx + hs, shoulder_y), (cx + int(hs * 1.9), hip_y), colour, limb)
    cv2.line(img, (cx - int(hh * 0.5), hip_y), (cx - int(hh * 0.7), foot_y), colour, limb * 2)
    cv2.line(img, (cx + int(hh * 0.5), hip_y), (cx + int(hh * 0.7), foot_y), colour, limb * 2)

    success, buf = cv2.imencode(".jpg", img)
    if not success:
        raise RuntimeError("encode failed")
    return buf.tobytes()


def main() -> None:
    client = httpx.Client(timeout=60.0)
    print("\n\033[1m  TailorAI — full stack smoke test\033[0m")

    # ── 1. Auth ──
    step("Authentication")
    res = client.post(f"{API}/auth/session", json={"token": EMAIL})
    if res.status_code != 200:
        die(f"sign-in failed: {res.status_code} {res.text[:300]}")
    session = res.json()
    token = session["accessToken"]
    auth = {"authorization": f"Bearer {token}"}
    ok(f"signed in as {session['user']['email']}")

    if not session.get("refreshToken"):
        fail("no refresh token issued")
    else:
        ok("refresh token issued")

    # ── 2. Consent gate ──
    step("Consent gate")

    # Job creation must be refused before consent is granted.
    probe = client.post(
        f"{API}/capture-sessions", headers=auth, json={"mode": "PHOTO_SET"}
    )
    if probe.status_code != 201 and probe.status_code != 200:
        die(f"capture session create failed: {probe.status_code} {probe.text[:300]}")
    probe_session = probe.json()

    blocked = client.post(
        f"{API}/jobs", headers=auth, json={"sessionId": probe_session["id"]}
    )
    if blocked.status_code == 403 and blocked.json().get("code") == "CONSENT_REQUIRED":
        ok("job creation refused without biometric consent (403 CONSENT_REQUIRED)")
    else:
        fail(f"consent gate did NOT block: {blocked.status_code} {blocked.text[:200]}")

    granted = client.post(
        f"{API}/me/consents",
        headers=auth,
        json={"kind": "BIOMETRIC_PROCESSING", "version": "biometric-v1", "granted": True},
    )
    if granted.status_code in (200, 201):
        ok("biometric consent recorded")
    else:
        die(f"consent grant failed: {granted.status_code} {granted.text[:300]}")

    # ── 3. Profile / height ──
    step("Profile")
    prof = client.patch(f"{API}/me", headers=auth, json={"heightCm": HEIGHT_CM})
    if prof.status_code == 200 and prof.json()["heightCm"] == HEIGHT_CM:
        ok(f"height set to {HEIGHT_CM} cm (anchors metric scale)")
    else:
        die(f"profile update failed: {prof.status_code} {prof.text[:300]}")

    # ── 4. Capture session + uploads ──
    step("Capture upload")
    cs = client.post(f"{API}/capture-sessions", headers=auth, json={"mode": "PHOTO_SET"})
    if cs.status_code not in (200, 201):
        die(f"capture session failed: {cs.status_code} {cs.text[:300]}")
    capture = cs.json()
    ok(f"capture session {capture['id'][:8]}… (purge after {capture['purgeAfter'][:10]})")

    for i in range(PHOTO_COUNT):
        data = synthetic_person(720, 1280, i * (360 / PHOTO_COUNT))

        created = client.post(
            f"{API}/capture-sessions/{capture['id']}/uploads",
            headers=auth,
            json={
                "kind": "RAW_PHOTO",
                "fileName": f"photo_{i}.jpg",
                "sizeBytes": len(data),
                "mimeType": "image/jpeg",
                "clientFingerprint": f"smoke{i:04d}" + "0" * 20,
                "partSizeBytes": 5 * 1024 * 1024,
            },
        )
        if created.status_code not in (200, 201):
            die(f"upload create failed: {created.status_code} {created.text[:300]}")
        upload = created.json()

        # PUT straight to object storage via the presigned URL — bytes never
        # touch the API.
        part_url = upload["parts"][0]["url"]
        put = httpx.put(part_url, content=data, headers={"content-type": "image/jpeg"}, timeout=60.0)
        if put.status_code not in (200, 204):
            die(f"presigned PUT failed: {put.status_code} {put.text[:200]}")

        etag = (put.headers.get("etag") or "").replace('"', "")
        done = client.post(
            f"{API}/uploads/{upload['uploadId']}/complete",
            headers=auth,
            json={"parts": [{"partNumber": 1, "etag": etag}]},
        )
        if done.status_code not in (200, 201):
            die(f"upload complete failed: {done.status_code} {done.text[:300]}")

    ok(f"{PHOTO_COUNT} photos uploaded via presigned URLs and verified server-side")

    fin = client.post(f"{API}/capture-sessions/{capture['id']}/finalise", headers=auth)
    if fin.status_code not in (200, 201) or fin.json()["status"] != "READY":
        die(f"finalise failed: {fin.status_code} {fin.text[:300]}")
    ok("capture session finalised (READY)")

    # ── 5. Job ──
    step("Reconstruction job")
    job_res = client.post(
        f"{API}/jobs",
        headers={**auth, "idempotency-key": f"smoke-{capture['id']}"},
        json={"sessionId": capture["id"], "options": {"quality": "standard", "textured": True}},
    )
    if job_res.status_code not in (200, 201):
        die(f"job create failed: {job_res.status_code} {job_res.text[:400]}")
    job = job_res.json()
    ok(f"job {job['id'][:8]}… queued (est {job['estimatedSeconds']}s)")

    # Idempotency: the same key must return the same job, not a second one.
    repeat = client.post(
        f"{API}/jobs",
        headers={**auth, "idempotency-key": f"smoke-{capture['id']}"},
        json={"sessionId": capture["id"]},
    )
    if repeat.status_code in (200, 201) and repeat.json()["id"] == job["id"]:
        ok("idempotency key returns the original job (no duplicate)")
    else:
        fail(f"idempotency broken: {repeat.status_code} {repeat.text[:200]}")

    # ── 6. Watch it run ──
    step("Pipeline execution")
    started = time.time()
    last_stage = None
    final = None

    while time.time() - started < 180:
        poll = client.get(f"{API}/jobs/{job['id']}", headers=auth)
        if poll.status_code != 200:
            die(f"job poll failed: {poll.status_code}")
        state = poll.json()

        running = next((s for s in state["stages"] if s["status"] == "RUNNING"), None)
        stage_name = running["name"] if running else state["status"]
        if stage_name != last_stage:
            print(f"    {state['progress'] * 100:5.1f}%  {stage_name}")
            last_stage = stage_name

        if state["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            final = state
            break
        time.sleep(1.5)

    if final is None:
        die("job did not finish within 180s")

    elapsed = time.time() - started

    if final["status"] != "COMPLETED":
        print("\n  stage detail:")
        for s in final["stages"]:
            mark = {"SUCCEEDED": "✔", "FAILED": "✘", "SKIPPED": "–", "DEGRADED": "~"}.get(s["status"], "?")
            print(f"    {mark} {s['name']:22s} {s['status']:10s} {s.get('errorCode') or ''}")
        die(f"job {final['status']}: {final.get('errorCode')} — {final.get('errorMessage')}")

    ok(f"pipeline completed in {elapsed:.1f}s")

    succeeded = [s for s in final["stages"] if s["status"] == "SUCCEEDED"]
    skipped = [s for s in final["stages"] if s["status"] == "SKIPPED"]
    degraded = [s for s in final["stages"] if s["status"] == "DEGRADED"]
    ok(f"{len(succeeded)} stages succeeded, {len(skipped)} skipped, {len(degraded)} degraded")

    # ── 7. Body Core ──
    step("Body Core (permanent profile)")
    core_res = client.get(f"{API}/me/body-core", headers=auth)
    if core_res.status_code != 200:
        die(f"body core fetch failed: {core_res.status_code} {core_res.text[:300]}")
    core = core_res.json()

    ok(f"v{core['version']} · {core['bodyModel']} · quality {core['quality']['overall']:.2f}")

    if core["scale"]["source"] == "USER_HEIGHT":
        ok(f"scale resolved from USER_HEIGHT ({core['scale']['heightCm']} cm, conf {core['scale']['confidence']})")
    else:
        fail(f"expected USER_HEIGHT scale, got {core['scale']['source']}")

    if "shapeParams" not in core:
        ok("shape parameters withheld by default (sensitive field)")
    else:
        fail("shape parameters leaked into the default response")

    with_params = client.get(f"{API}/me/body-core?include=params", headers=auth)
    if with_params.status_code == 200 and "shapeParams" in with_params.json():
        n = len(with_params.json()["shapeParams"])
        ok(f"shape parameters available on explicit request ({n} coefficients)")
    else:
        fail("include=params did not return shape parameters")

    # ── 8. Avatar + export ──
    step("Avatar and export")
    av = client.get(f"{API}/me/avatar", headers=auth)
    if av.status_code != 200:
        die(f"avatar fetch failed: {av.status_code} {av.text[:300]}")
    avatar = av.json()
    stats = avatar["stats"]
    ok(f"{stats['vertexCount']} verts · {stats['triangleCount']} tris · {stats['fileSizeBytes'] / 1024:.0f} KB")

    if avatar["coverage"]:
        ok(f"coverage reported ({avatar['coverage']['inpaintedFraction'] * 100:.0f}% inferred)")

    exp = client.post(f"{API}/avatars/{avatar['id']}/exports", headers=auth, json={"format": "GLB"})
    if exp.status_code not in (200, 201):
        die(f"export failed: {exp.status_code} {exp.text[:300]}")
    export = exp.json()

    dl = client.get(f"{API}/exports/{export['id']}", headers=auth)
    url = dl.json()["download"]["url"]
    glb = httpx.get(url, timeout=60.0).content

    if glb[:4] != b"glTF":
        die(f"downloaded file is not a GLB (magic {glb[:4]!r})")
    ok(f"GLB downloaded and verified: {len(glb) / 1024:.0f} KB, magic 'glTF'")

    out = Path(__file__).resolve().parents[1] / ".data" / "smoke-avatar.glb"
    out.write_bytes(glb)

    try:
        import trimesh

        mesh = trimesh.load(io.BytesIO(glb), file_type="glb", force="mesh")
        delivered = (mesh.bounds[1][1] - mesh.bounds[0][1]) * 100
        if abs(delivered - HEIGHT_CM) < 0.5:
            ok(f"delivered height {delivered:.1f} cm matches requested {HEIGHT_CM} cm")
        else:
            fail(f"height drift: requested {HEIGHT_CM}, delivered {delivered:.1f}")
    except Exception as exc:  # noqa: BLE001
        fail(f"could not load GLB: {exc}")

    # ── 9. Authorisation ──
    step("Authorisation")
    anon = client.get(f"{API}/me")
    if anon.status_code == 401:
        ok("unauthenticated request rejected (401)")
    else:
        fail(f"unauthenticated request returned {anon.status_code}")

    other = client.post(
        f"{API}/auth/session", json={"token": f"intruder-{int(time.time())}@tailorai.test"}
    )
    other_auth = {"authorization": f"Bearer {other.json()['accessToken']}"}
    steal = client.get(f"{API}/avatars/{avatar['id']}", headers=other_auth)
    if steal.status_code == 404:
        ok("another user cannot read this avatar (404)")
    else:
        fail(f"cross-user access returned {steal.status_code} — DATA LEAK")

    # ── 10. Quotas ──
    step("Quotas")
    cs2 = client.post(f"{API}/capture-sessions", headers=auth, json={"mode": "PHOTO_SET"})
    dup = client.post(f"{API}/jobs", headers=auth, json={"sessionId": cs2.json()["id"]})
    if dup.status_code == 409 and dup.json().get("code") == "SESSION_NOT_READY":
        ok("job on an unfinalised session refused (409 SESSION_NOT_READY)")
    else:
        print(f"    note: got {dup.status_code} {dup.json().get('code')}")

    print(f"\n  \033[1mArtifact:\033[0m {out}")
    summary()
    sys.exit(0 if _fail == 0 else 1)


if __name__ == "__main__":
    main()
