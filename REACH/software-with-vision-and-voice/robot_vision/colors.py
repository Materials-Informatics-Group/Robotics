# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: robot_vision/colors.py
# Purpose:
#   • Color utilities for the vision subsystem:
#       - Compute mean HSV at a clicked region.
#       - Map HSV (optionally with BGR context) to a human-friendly color name.
#       - Detect colored regions using HSV ranges + morphological cleanup.
# Notes:
#   • OpenCV HSV ranges: H ∈ [0..179], S ∈ [0..255], V ∈ [0..255].
#   • “bright=True” relaxes grayscale gates and adjusts S floors to better handle overexposed scenes.
# =================================================================================================

from typing import List, Dict, Tuple
import numpy as np, cv2


def mean_hsv_at(bgr, x: int, y: int, size: int = 20) -> Tuple[float, float, float]:
    """
    Compute the mean HSV within a square ROI centered at (x, y).

    Args:
        bgr (np.ndarray): BGR image (H×W×3, uint8).
        x (int): Center X (pixels).
        y (int): Center Y (pixels).
        size (int): Half-side of the square (ROI is ~ (2*size)^2, clamped to image).

    Returns:
        Tuple[float, float, float]: (H, S, V) means using OpenCV HSV ranges.
                                    Returns (0,0,0) if ROI is empty after clamping.
    """
    h, w = bgr.shape[:2]
    x1, y1 = max(0, x - size), max(0, y - size)
    x2, y2 = min(w, x + size), min(h, y + size)
    roi = bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return (0.0, 0.0, 0.0)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    m = hsv.reshape(-1, 3).mean(axis=0)
    return float(m[0]), float(m[1]), float(m[2])


def hsv_match_name(hsv, presets, bright: bool = False, bgr_means=None) -> str:
    """
    Heuristically map an HSV triple (optionally with BGR means) to a color name.

    Args:
        hsv (Tuple[float,float,float]): (H, S, V) in OpenCV ranges.
        presets (dict): Reserved for future per-color tuning (not used directly here).
        bright (bool): If True, apply thresholds suited for bright environments.
        bgr_means (Tuple[float,float,float]|None): Optional (B, G, R) means from a nearby ROI
            to refine ambiguous hue boundaries (e.g., red/blue, green/cyan/blue).

    Returns:
        str: One of: red, orange, yellow, green, cyan, blue, purple, pink, white, gray, black.
    """
    H, S, V = hsv

    # --- Grayscale/black gates (brightness-aware) ---------------------------------------------
    if bright:
        if V < 60: return "black"
        if S < 20 and V > 210: return "white"
        if S < 20 and 70 <= V <= 210: return "gray"
    else:
        if V < 40: return "black"
        if S < 30: return "white" if V > 200 else "gray"

    # SPECIAL-CASE: washed-out yellow under bright light (H ~50–65, low S, high V)
    if 45 <= H <= 65 and V >= 180 and S <= 45:
        return "yellow"

    # --- Nearest hue center (circular distance over 0..179) -----------------------------------
    centers = [
        ("red", 0), ("orange", 14), ("yellow", 27),
        ("green", 60), ("cyan", 92), ("blue", 117),
        ("purple", 147), ("pink", 166)
    ]
    def hue_dist(a, b):
        d = abs(a - b); return min(d, 180 - d)
    name = min(centers, key=lambda kv: hue_dist(H, kv[1]))[0]

    # RED rescue: if BGR means show strong red dominance, prefer 'red' even if H leans blue-ish.
    if bgr_means is not None:
        b, g, r = bgr_means
        eps = 1e-6
        r_over_g = r / (g + eps)
        r_over_b = r / (b + eps)
        if r_over_g >= 1.35 and r_over_b >= 1.35 and V >= 120 and S >= 25:
            return "red"

    # Green/Cyan/Blue boundary refinement using BGR dominance
    if 70 <= H <= 110 and bgr_means is not None:
        b, g, r = bgr_means
        eps = 1e-6
        # Neutral cyan-ish: B≈G and R relatively small → call it green
        if abs(b - g) <= 16 and r <= 0.60 * min(b, g):
            return "green"
        g_over_b = g / (b + eps); g_over_r = g / (r + eps)
        b_over_g = b / (g + eps); b_over_r = b / (r + eps)
        if (g_over_b >= 1.06 and g_over_r >= 1.20) or ((g - b) >= 10 and (g - r) >= 22):
            return "green"
        if (b_over_g >= 1.06 and b_over_r >= 1.20) or ((b - g) >= 10 and (b - r) >= 22):
            return "blue"

    # Another yellow rescue after nearest-hue
    if name in ("green", "cyan") and 45 <= H <= 65 and V >= 180 and S <= 45:
        return "yellow"

    return name


def detect_colors(
    bgr,
    config_colors: Dict[str, List[Dict[str, List[int]]]],
    requested: List[str],
    bright: bool = False
) -> List[Dict]:
    """
    Detect colored blobs using HSV ranges with morphology & QOL filters.

    Args:
        bgr (np.ndarray): BGR image (H×W×3, uint8).
        config_colors (dict): { "<name>": [ { "low":[H,S,V], "high":[H,S,V] }, ... ], ... }
            Note: If a hue range wraps 179→0, split it into two entries in config.
        requested (list[str]): Color names to search for (case-insensitive).
        bright (bool): If True, apply scene-brightness tweaks (S floors, helper bands).

    Returns:
        list[dict]: One entry per detection:
            {
              "type": "color", "color": "<name>",
              "bbox": [x, y, w, h], "center_px": [cx, cy],
              "score": <0..1 area fraction heuristic>
            }
    """
    detections = []
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    Htot, Wtot = hsv.shape[:2]
    frame_area = Htot * Wtot

    # Per-color S floors in bright scenes
    def bright_s_floor_for(color: str) -> int:
        if not bright: return -1
        return {"yellow": 18, "orange": 28, "green": 40}.get(color, 40)

    for color in (c.lower() for c in requested):
        ranges = list(config_colors.get(color, []))

        # Tight green+cyan union (avoid blue leak) under bright scenes
        if bright and color == "green":
            extra = []
            for r in config_colors.get("cyan", []):
                lo = list(r['low']); hi = list(r['high'])
                hi[0] = min(hi[0], 98)   # clamp cyan top H
                extra.append({"low": lo, "high": hi})
            ranges += extra

        # Washed-out yellow helper band under bright light (H ~45–65, low S, high V)
        if bright and color == "yellow":
            ranges = list(ranges)  # copy
            ranges.append({"low": [45, 15, 160], "high": [65, 255, 255]})
            # Small union with orange can help amber-ish yellows
            ranges += list(config_colors.get("orange", []))

        if not ranges:
            continue

        # Build mask with per-color S floor
        mask_total = None
        s_floor = bright_s_floor_for(color)
        for r in ranges:
            low = np.array(r['low'], dtype=np.uint8)
            high = np.array(r['high'], dtype=np.uint8)
            if s_floor >= 0:
                low[1] = max(s_floor, int(low[1]))
            mask = cv2.inRange(hsv, low, high)
            mask_total = mask if mask_total is None else cv2.bitwise_or(mask_total, mask)

        # Morphological cleanup (5×5 open + close)
        kernel = np.ones((5, 5), np.uint8)
        mask_total = cv2.morphologyEx(mask_total, cv2.MORPH_OPEN, kernel)
        mask_total = cv2.morphologyEx(mask_total, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(mask_total, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h

            # Area guard: ignore tiny specks and massive panels
            if area < 200 or area > 0.15 * frame_area:
                continue

            # Aspect-ratio guard: prefer roughly square-ish blobs
            ar = w / float(h)
            if ar < 0.6 or ar > 1.6:
                continue

            # Fill fraction within bbox (avoid sparse masks)
            roi_mask = mask_total[y:y+h, x:x+w]
            fill = cv2.countNonZero(roi_mask) / float(max(1, area))
            if fill < 0.30:
                continue

            # Black/white content guard (avoid shadows/highlights misfires)
            roi_hsv = hsv[y:y+h, x:x+w].astype("float32")
            S = roi_hsv[..., 1]; V = roi_hsv[..., 2]
            bw_frac = (np.mean(V < 60) + np.mean((S < (25 if bright else 30)) & (V > 200)))
            if bw_frac > 0.40:
                continue

            # Anti-blue for green (helps cyan/blue edges)
            if color == "green":
                roi_bgr = bgr[y:y+h, x:x+w].astype("float32")
                b = float(np.mean(roi_bgr[..., 0])); g = float(np.mean(roi_bgr[..., 1])); r = float(np.mean(roi_bgr[..., 2]))
                eps = 1e-6
                b_over_g = b / (g + eps); b_over_r = b / (r + eps)
                if (b_over_g >= 1.12 and b_over_r >= 1.25):
                    continue

            # Anti-green/blue for yellow (ensure R&G dominate B; keep G not overly above R)
            if color == "yellow":
                roi_bgr = bgr[y:y+h, x:x+w].astype("float32")
                b = float(np.mean(roi_bgr[..., 0])); g = float(np.mean(roi_bgr[..., 1])); r = float(np.mean(roi_bgr[..., 2]))
                eps = 1e-6
                if not (r >= 1.15 * b and g >= 1.15 * b and (g / (r + eps)) <= 1.25):
                    continue

            cx, cy = int(x + w / 2), int(y + h / 2)
            detections.append({
                "type": "color", "color": color,
                "bbox": [int(x), int(y), int(w), int(h)],
                "center_px": [cx, cy],
                "score": float(min(1.0, area / (frame_area if frame_area > 0 else 1)))
            })

    return detections
