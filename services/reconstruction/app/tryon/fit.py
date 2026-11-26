"""Fit-engine numbers → how the garment should sit in the picture.

The fit engine scores every size against the body, per dimension, and says
how much room each one leaves (`roomCm`: + looser than the ideal for this cut
and preference, − tighter). This turns those centimetres into the handful of
things a photo can show:

* the outline — a smaller garment pulls in until it hugs the body (it can't be
  narrower than the body under it), a bigger one stands away from it;
* strain — how hard the fabric is stretched: creases radiating from the
  armpits, tension across the belly;
* drape — how much spare cloth hangs in vertical folds;
* length — shorter in smaller sizes, plus the ride-up a tight top gets;
* sleeves — shorter and tighter, or longer and wider.

`amplify` makes the differences easier to see in a small preview; 1.0 is
geometrically faithful to the numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# A tee's length grows ~2.2 cm per size; sleeves ~1.5 cm.
LENGTH_PER_SIZE_CM = 2.2
SLEEVE_PER_SIZE_CM = 1.0

VERDICT_TONE = {
    "too tight": "bad", "snug — stretch helps": "warn", "snug": "warn", "good fit": "good",
    "relaxed": "loose", "loose": "loose", "too loose": "bad-loose",
    "too short": "bad", "slightly short": "warn", "good length": "good",
    "slightly long": "loose", "too long": "bad-loose",
}


@dataclass
class Zone:
    name: str  # chest | waist | hip | shoulders | sleeves | length | thigh | inseam
    label: str
    verdict: str
    tone: str  # bad | warn | good | loose | bad-loose
    room_cm: float  # + room to spare, − too small
    text: str  # short caption, e.g. "9 cm too small"


@dataclass
class FitGeometry:
    size: str
    step: int  # sizes away from the recommended one (− smaller)
    chest_ease: float  # roomCm at the chest (0 = ideal)
    waist_ease: float
    hip_ease: float
    shoulder_ease: float
    sleeve_len_cm: float  # sleeve length change vs. the photo garment
    length_cm: float  # hem change vs. the photo garment (+ longer)
    tightness: float  # 0..1 — strain to draw
    looseness: float  # 0..1 — drape to draw
    leg_ease: float = 0.0
    inseam_cm: float = 0.0
    zones: list[Zone] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if self.tightness > 0.75:
            return "Very tight"
        if self.tightness > 0.35:
            return "Snug"
        if self.looseness > 0.75:
            return "Very loose"
        if self.looseness > 0.35:
            return "Relaxed"
        return "True to size"


def _room(dims: dict[str, dict], name: str, default: float = 0.0) -> float:
    d = dims.get(name)
    return float(d["roomCm"]) if d and d.get("roomCm") is not None else default


def _caption(name: str, d: dict) -> str:
    """A short caption that agrees with the verdict (and so with the colour)."""
    out = float(d.get("outsideCm") or 0.0)
    room = float(d.get("roomCm") or 0.0)
    verdict = d.get("verdict", "")
    if name in ("arm_length", "inseam"):
        if out > 0.4:
            return f"{out:.0f} cm {'short' if 'short' in verdict else 'long'}"
        return {"slightly short": "a little short", "slightly long": "a little long"}.get(verdict, "right length")
    if verdict == "too tight":
        return f"{max(out, 1):.0f} cm too small"
    if verdict == "too loose":
        return f"{max(out, 1):.0f} cm too big"
    if verdict.startswith("snug"):
        return "snug"
    if verdict in ("relaxed", "loose"):
        return f"{room:.0f} cm roomy" if room >= 1.5 else "a little roomy"
    return "fits well"


def geometry(size: str, sizes: list[dict], recommended: str, category: str,
             amplify: float = 1.0) -> FitGeometry:
    """`sizes` is the fit engine's per-size list (each with `dimensions`)."""
    labels = [s["label"] for s in sizes]
    entry = next((s for s in sizes if s["label"] == size), None)
    if entry is None:
        raise ValueError(f"unknown size {size}")
    dims = {d["name"]: d for d in entry.get("dimensions") or []}
    step = labels.index(size) - (labels.index(recommended) if recommended in labels else labels.index(size))

    chest = _room(dims, "chest", default=_room(dims, "waist"))
    waist = _room(dims, "waist", default=chest)
    hip = _room(dims, "hip", default=waist)
    shoulder = _room(dims, "shoulder_width", default=chest * 0.18)
    cat = category.lower()
    lower = cat in ("bottoms",)
    key = (waist + hip) / 2 if lower else chest

    # Visual strain/drape from the key girth's room. A size down (~ −8 cm)
    # reads as "snug", two down (~ −16 cm) as "very tight".
    tight = max(0.0, min(1.0, (-key - 2.0) / 13.0))
    loose = max(0.0, min(1.0, (key - 3.0) / 13.0))
    # A girth that is past the size's range is the strongest evidence of all.
    for n in ("chest", "waist", "hip"):
        d = dims.get(n)
        if d and d.get("verdict") == "too tight":
            tight = max(tight, min(1.0, 0.55 + float(d.get("outsideCm") or 0) / 10.0))

    arm = dims.get("arm_length")
    sleeve = float(arm["roomCm"]) * 0.8 if arm else SLEEVE_PER_SIZE_CM * step
    sleeve -= 1.5 * tight  # a tight sleeve rides up the arm
    length = LENGTH_PER_SIZE_CM * step - 6.0 * tight + 1.5 * loose
    inseam = dims.get("inseam")
    inseam_cm = float(inseam["roomCm"]) if inseam else 2.0 * step

    zones = []
    for name, d in dims.items():
        if d.get("weight", 0) <= 0:
            continue
        zones.append(Zone(
            name={"shoulder_width": "shoulders", "arm_length": "sleeves"}.get(name, name),
            label=d.get("label", name).title(),
            verdict=d.get("verdict", ""),
            tone=VERDICT_TONE.get(d.get("verdict", ""), "good"),
            room_cm=float(d.get("roomCm") or 0.0),
            text=_caption(name, d),
        ))
    if not lower and abs(length) > 1.5:
        zones.append(Zone("length", "Length", "short" if length < 0 else "long",
                          "warn" if length < -4 else ("loose" if length > 4 else "good"), length,
                          f"{abs(length):.0f} cm {'shorter' if length < 0 else 'longer'}"))

    a = amplify
    return FitGeometry(
        size=size, step=step, chest_ease=chest * a, waist_ease=waist * a, hip_ease=hip * a,
        shoulder_ease=shoulder * a, sleeve_len_cm=sleeve * a, length_cm=length * a,
        tightness=tight, looseness=loose, leg_ease=hip * a, inseam_cm=inseam_cm * a, zones=zones,
    )
