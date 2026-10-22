"""Four-view body scan: validation, measurement, and body fitting.

The MVP scan is four controlled photos — front, back, left, right — plus the
user's height. Everything here is CPU-only and runs on the dev laptop:

    pose.py      person detection, 33 keypoints, person matte (MediaPipe)
    quality.py   per-view checks that reject obviously bad scans
    measure.py   silhouette anthropometry → 12 measurements with confidence
    body_fit.py  fits the parametric body to the measured girths (3D model)
    analyze.py   ties the above together for the /scan/analyze endpoint
"""
