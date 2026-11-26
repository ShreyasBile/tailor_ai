"""Photo try-on: the shopper's own scan photo, re-dressed.

Two things, both on the shopper's real front (and back) scan photo, both on a
laptop CPU with no generative model:

* **Size preview** — the garment as it would sit on *this* body in *this* size:
  a size too small hugs the body, pulls into strain creases, rides up and
  shortens the sleeves; a size too big drapes wide, long and slack. Driven by
  the fit engine's per-size numbers, so the picture and the size advice agree.
* **Try-on** — a catalogue garment's own product photo, warped onto the body
  and lit by the folds and light of the original photo.

`parse.py` reads the photo (body, skin, top, bottoms, background), `garment.py`
reads a product photo, `fit.py` turns fit-engine numbers into geometry, and
`render.py` puts it together.
"""
