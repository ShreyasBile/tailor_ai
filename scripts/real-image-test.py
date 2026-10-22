"""Run a real photo (or set) through the LIVE pipeline and download the GLB.

Usage:
  python scripts/real-image-test.py <image1> [image2 ...] [--height 175]

Uses public-domain images only. With the mock adapter this produces a
silhouette-shaped humanoid textured with the photo — a real test of the
pipeline plumbing on real input, not a SAM-3D-Body-quality scan.
"""
from __future__ import annotations
import sys, time, hashlib, pathlib
import httpx

API = "http://127.0.0.1:3000/v1"

def main() -> None:
    args = [a for a in sys.argv[1:]]
    height = None
    if "--height" in args:
        i = args.index("--height"); height = float(args[i + 1]); del args[i:i + 2]
    email_override = None
    if "--email" in args:
        i = args.index("--email"); email_override = args[i + 1]; del args[i:i + 2]
    images = [pathlib.Path(a) for a in args]
    if not images:
        print("no images given"); sys.exit(1)
    for p in images:
        if not p.exists(): print("missing:", p); sys.exit(1)

    c = httpx.Client(timeout=120.0)
    email = email_override or f"realtest-{int(time.time())}@tailorai.app"
    print(f"\n  Real-image pipeline test — {len(images)} photo(s), user {email}\n")

    # auth
    r = c.post(f"{API}/auth/session", json={"token": email}); r.raise_for_status()
    tok = r.json()["accessToken"]; H = {"authorization": f"Bearer {tok}"}
    print("  [ok] signed in")

    # consent
    c.post(f"{API}/me/consents", headers=H, json={
        "kind": "BIOMETRIC_PROCESSING", "version": "biometric-v1", "granted": True}).raise_for_status()
    print("  [ok] consent granted")

    # height (anchors metric scale)
    if height:
        c.patch(f"{API}/me", headers=H, json={"heightCm": height}).raise_for_status()
        print(f"  [ok] height set: {height} cm")

    # session
    s = c.post(f"{API}/capture-sessions", headers=H, json={"mode": "PHOTO_SET"}); s.raise_for_status()
    sid = s.json()["id"]; print(f"  [ok] capture session {sid[:8]}")

    # upload each photo via presigned multipart
    for i, img in enumerate(images):
        data = img.read_bytes()
        fp = hashlib.sha256(data[:65536] + data[-65536:] + str(len(data)).encode()).hexdigest()
        cu = c.post(f"{API}/capture-sessions/{sid}/uploads", headers=H, json={
            "kind": "RAW_PHOTO", "fileName": f"real_{i}.jpg", "sizeBytes": len(data),
            "mimeType": "image/jpeg", "clientFingerprint": fp,
            "partSizeBytes": 5 * 1024 * 1024}); cu.raise_for_status()
        up = cu.json()
        put = httpx.put(up["parts"][0]["url"], content=data,
                        headers={"content-type": "image/jpeg"}, timeout=120)
        etag = (put.headers.get("etag") or "").replace('"', "")
        c.post(f"{API}/uploads/{up['uploadId']}/complete", headers=H,
               json={"parts": [{"partNumber": 1, "etag": etag}]}).raise_for_status()
        print(f"  [ok] uploaded {img.name} ({len(data)//1024} KB)")

    c.post(f"{API}/capture-sessions/{sid}/finalise", headers=H).raise_for_status()

    # job
    j = c.post(f"{API}/jobs", headers=H,
               json={"sessionId": sid, "options": {"quality": "standard", "textured": True}})
    j.raise_for_status(); jid = j.json()["id"]
    print(f"  [ok] job {jid[:8]} queued\n  processing:")

    # poll
    start = time.time(); last = None
    while time.time() - start < 240:
        job = c.get(f"{API}/jobs/{jid}", headers=H).json()
        run = next((s for s in job["stages"] if s["status"] == "RUNNING"), None)
        stage = run["name"] if run else job["status"]
        if stage != last:
            print(f"    {job['progress']*100:5.0f}%  {stage}"); last = stage
        if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(1.5)

    if job["status"] != "COMPLETED":
        print("\n  stage detail:")
        for s in job["stages"]:
            print(f"    {s['status']:10} {s['name']}  {s.get('errorCode') or ''}")
        print(f"\n  FAILED: {job.get('errorCode')} — {job.get('errorMessage')}"); sys.exit(1)

    print(f"\n  [ok] completed in {time.time()-start:.0f}s")

    # body core + avatar
    core = c.get(f"{API}/me/body-core", headers=H).json()
    print(f"  core: {core['bodyModel']} q={core['quality']['overall']:.2f} "
          f"scale={core['scale']['source']} {core['scale'].get('heightCm')}cm")
    av = c.get(f"{API}/me/avatar", headers=H).json()
    st = av["stats"]; cov = av.get("coverage") or {}
    print(f"  avatar: {st['vertexCount']} verts, {st['triangleCount']} tris, "
          f"{st['fileSizeBytes']/1024:.0f} KB, textured={av['isTextured']}, "
          f"inpainted={cov.get('inpaintedFraction', 0)*100:.0f}%")

    # export + download GLB
    ex = c.post(f"{API}/avatars/{av['id']}/exports", headers=H, json={"format": "GLB"}).json()
    rec = c.get(f"{API}/exports/{ex['id']}", headers=H).json()
    glb = httpx.get(rec["download"]["url"], timeout=120).content
    out = pathlib.Path(__file__).resolve().parents[1] / ".data" / "real-test" / "real-avatar.glb"
    out.write_bytes(glb)
    print(f"  [ok] GLB downloaded: {out}  ({len(glb)/1024:.0f} KB, magic={glb[:4]!r})")

    if av.get("thumbnailUrl") if False else True:
        pass
    print("\n  done.\n")

if __name__ == "__main__":
    main()
