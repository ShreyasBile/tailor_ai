"""Transparent size recommendation.

Inputs: the user's body measurements, a garment (category, cut, stretch), the
brand's size chart (body-measurement ranges per size — the form brands
publish), and the user's fit preference.

For every size and every relevant dimension we ask: where does this body sit
inside that size's range, versus where it *should* sit for this cut and this
person's taste? The gap, in centimetres, is scored with an asymmetric curve —
too tight is penalised harder than too loose, and fabric stretch widens the
tight side. Dimension scores are combined with category-specific weights; a
critical dimension that will not physically fit caps the total.

Deliberately simple and explainable. It is the baseline a learned model will
have to beat once purchase/return outcomes exist (the feedback table).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Relative importance of each dimension, per garment category.
WEIGHTS: dict[str, dict[str, float]] = {
    "tops": {"chest": 0.45, "shoulder_width": 0.2, "waist": 0.15, "arm_length": 0.1, "neck": 0.1},
    "outerwear": {"chest": 0.45, "shoulder_width": 0.25, "arm_length": 0.15, "waist": 0.15},
    "bottoms": {"waist": 0.45, "hip": 0.35, "inseam": 0.15, "thigh": 0.05},
    "dresses": {"chest": 0.35, "waist": 0.35, "hip": 0.3},
}
CATEGORY_ALIASES = {
    "t-shirts": "tops", "tshirts": "tops", "shirts": "tops", "knitwear": "tops",
    "sweaters": "tops", "hoodies": "tops", "jackets": "outerwear", "coats": "outerwear",
    "jeans": "bottoms", "trousers": "bottoms", "pants": "bottoms", "shorts": "bottoms",
    "skirts": "bottoms", "dress": "dresses",
}
LENGTHS = {"inseam", "arm_length"}
CRITICAL = 0.3  # weight at/above which a dimension can veto a size

LABELS = {
    "chest": "Chest", "waist": "Waist", "hip": "Hip", "shoulder_width": "Shoulders",
    "inseam": "Inseam", "arm_length": "Sleeve", "neck": "Neck", "thigh": "Thigh",
}

# Where in a size's range the body should ideally sit (0 = bottom, 1 = top).
# A body near the top of the range wears that size snugly.
PREFERENCE_TARGET = {"snug": 0.72, "regular": 0.5, "loose": 0.25}
# A slim cut already runs close, so aim lower in the range; a relaxed or
# oversized cut has built-in room, so a body can sit higher.
FIT_INTENT_SHIFT = {"slim": -0.2, "regular": 0.0, "relaxed": 0.12, "oversized": 0.22}
# Extra centimetres a girth can exceed the range by before it is "too tight".
STRETCH_CM = {"none": 0.0, "low": 1.5, "medium": 3.0, "high": 5.0}


@dataclass
class DimResult:
    name: str
    body: float
    lo: float
    hi: float
    weight: float
    score: float
    verdict: str
    room_cm: float  # +: more room than ideal, −: tighter than ideal

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": LABELS.get(self.name, self.name),
            "body": round(self.body, 1),
            "range": [self.lo, self.hi],
            "weight": round(self.weight, 2),
            "score": round(self.score, 3),
            "verdict": self.verdict,
            "roomCm": round(self.room_cm, 1),
        }


def _category(cat: str) -> str:
    c = cat.lower().strip()
    return c if c in WEIGHTS else CATEGORY_ALIASES.get(c, "tops")


def _score_dim(name: str, body: float, lo: float, hi: float, weight: float,
               preference: str, fit_intent: str, stretch: str) -> DimResult:
    width = max(hi - lo, 1.0)
    is_length = name in LENGTHS
    if is_length:
        t = 0.5  # length preference doesn't change with taste in this version
        tol = 0.0
    else:
        t = PREFERENCE_TARGET.get(preference, 0.5) + FIT_INTENT_SHIFT.get(fit_intent, 0.0)
        t = min(max(t, 0.05), 0.95)
        tol = STRETCH_CM.get(stretch, 0.0)

    ideal = lo + t * width
    room = ideal - body  # positive: garment has more room than ideal

    # Asymmetric tolerance (cm): tightness hurts sooner than looseness.
    if room < 0:
        sigma = 0.4 * width + tol
    else:
        sigma = 0.8 * width if not is_length else 0.4 * width
    score = math.exp(-((room / sigma) ** 2))

    # Physically doesn't fit / far too big.
    if body > hi + tol and not is_length:
        score *= 0.5
    if body < lo - width and not is_length:
        score *= 0.6

    verdict = _verdict(name, body, lo, hi, tol, is_length)
    return DimResult(name, body, lo, hi, weight, score, verdict, room)


def _verdict(name: str, b: float, lo: float, hi: float, tol: float, is_length: bool) -> str:
    if is_length:
        if b > hi + 2:
            return "too short"
        if b > hi:
            return "slightly short"
        if b < lo - 2:
            return "too long"
        if b < lo:
            return "slightly long"
        return "good length"
    p = (b - lo) / max(hi - lo, 1.0)
    if b > hi + tol:
        return "too tight"
    if b > hi:
        return "snug — stretch helps"
    if p > 0.8:
        return "snug"
    if p >= 0.2:
        return "good fit"
    if b >= lo:
        return "relaxed"
    if lo - b > (hi - lo):
        return "too loose"
    return "loose"


def recommend(body: dict[str, dict | float], garment: dict, size_chart: list[dict],
              preference: str = "regular") -> dict:
    """Pick the best size. `body` values may be plain numbers or
    {"value": cm, "confidence": 0..1}."""
    cat = _category(garment.get("category", "tops"))
    fit_intent = garment.get("fitIntent", "regular")
    stretch = garment.get("stretch", "none")

    vals = {k: (v["value"] if isinstance(v, dict) else float(v)) for k, v in body.items()}
    confs = {k: (v.get("confidence", 0.7) if isinstance(v, dict) else 0.7) for k, v in body.items()}

    if not size_chart:
        raise ValueError("size chart is empty")

    weights = WEIGHTS[cat]
    charted = {d for s in size_chart for d in s["measurements"]}
    dims = [d for d in weights if d in charted and d in vals]
    if not dims:
        raise ValueError("no overlap between the size chart and the body measurements")
    total_w = sum(weights[d] for d in dims)

    sizes = []
    for s in size_chart:
        results = []
        for d in dims:
            rng = s["measurements"].get(d)
            if not rng:
                continue
            results.append(_score_dim(d, vals[d], float(rng[0]), float(rng[1]),
                                      weights[d] / total_w, preference, fit_intent, stretch))
        if not results:
            continue
        w_sum = sum(r.weight for r in results)
        score = sum(r.score * r.weight for r in results) / w_sum
        # A critical dimension that won't close/fit caps the size.
        blocked = any(r.verdict == "too tight" and r.weight >= CRITICAL for r in results)
        if blocked:
            score = min(score, 0.45)
        sizes.append({"label": s["label"], "score": score, "dims": results, "blocked": blocked})

    # A size that physically won't close ranks below every size that does — the
    # cap alone can't guarantee that, since a fitting size can also score < 0.45.
    ranked = sorted(sizes, key=lambda x: (x["blocked"], -x["score"]))
    best = ranked[0]
    second = ranked[1] if len(ranked) > 1 else None
    # A blocked runner-up is no real alternative ("between 32 and 34" must not
    # offer a 32 that won't close).
    rival = second is not None and second["blocked"] == best["blocked"]
    gap = max(0.0, best["score"] - second["score"]) if second is not None else 1.0
    # Within 15 points: the body sits near a size boundary in a key dimension.
    between = rival and gap < 0.15

    meas_conf = sum(confs.get(r.name, 0.7) * r.weight for r in best["dims"]) / sum(r.weight for r in best["dims"])
    separation = min(1.0, 0.6 + 4.0 * gap) if rival else 1.0
    confidence = max(0.05, min(0.99, meas_conf * separation))

    fit_score = round(100 * best["score"])
    order = {s["label"]: i for i, s in enumerate(size_chart)}
    alt = None
    if second is not None:
        alt = second["label"]

    return {
        "recommendedSize": best["label"],
        "fitScore": fit_score,
        "fitLabel": _fit_label(fit_score),
        "alternativeSize": alt,
        "betweenSizes": between,
        "confidence": {"value": round(confidence, 2), "label": _conf_label(confidence)},
        "dimensions": [r.to_dict() for r in sorted(best["dims"], key=lambda r: -r.weight)],
        # Per-size dimension detail lets the try-on view switch sizes without
        # another round trip.
        "sizes": [{"label": s["label"], "score": round(100 * s["score"]),
                   "dimensions": [r.to_dict() for r in sorted(s["dims"], key=lambda r: -r.weight)]}
                  for s in sorted(sizes, key=lambda s: order.get(s["label"], 0))],
        "explanation": _explain(best, second, between, preference, fit_intent, stretch, order),
        "engineVersion": "fit-rules-v1",
    }


def _fit_label(score: int) -> str:
    if score >= 85:
        return "Great fit"
    if score >= 70:
        return "Good fit"
    if score >= 50:
        return "Fair fit"
    return "Poor fit"


def _conf_label(c: float) -> str:
    return "high" if c >= 0.7 else "medium" if c >= 0.5 else "low"


def _explain(best: dict, second: dict | None, between: bool, preference: str,
             fit_intent: str, stretch: str, order: dict[str, int]) -> str:
    dims = sorted(best["dims"], key=lambda r: -r.weight)
    good = [r for r in dims if r.verdict in ("good fit", "good length")]
    other = [r for r in dims if r.verdict not in ("good fit", "good length")]

    parts = [f"We recommend size {best['label']}."]
    if good:
        names = _join([LABELS.get(r.name, r.name).lower() for r in good[:3]])
        parts.append(f"Your {names} sit{'s' if len(good) == 1 else ''} comfortably within this size.")
    for r in other[:2]:
        parts.append(f"{LABELS.get(r.name, r.name)}: {r.verdict}.")
    if fit_intent in ("slim", "relaxed", "oversized"):
        parts.append(f"This is a {fit_intent} cut, which we've accounted for.")
    if stretch in ("medium", "high"):
        parts.append("The fabric has some stretch, so a snug fit will still be comfortable.")
    if between and second is not None:
        bigger = second["label"] if order.get(second["label"], 0) > order.get(best["label"], 0) else best["label"]
        smaller = best["label"] if bigger == second["label"] else second["label"]
        parts.append(
            f"You're between {smaller} and {bigger} — choose {bigger} for a looser feel "
            f"or {smaller} for a closer fit."
        )
    if preference != "regular":
        parts.append(f"Tuned to your {preference} fit preference.")
    return " ".join(parts)


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]
