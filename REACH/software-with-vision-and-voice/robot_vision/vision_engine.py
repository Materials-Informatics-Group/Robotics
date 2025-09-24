# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: robot_vision/vision_engine.py
# Purpose:
#   • Embedded, in-process vision engine used by the Flask blueprint and other callers.
#   • Wraps camera access, provides tag/color analysis, and click-based classification.
# Notes:
#   • frame.shape[:2] == (H, W) but responses expose frame_size as [W, H] (frontend convention).
#   • Local imports of cv2/numpy inside analyze() allow importing this module without cv2 installed.
# =================================================================================================

import time
from typing import Dict, Any, List
from .camera import CameraStream
from .config import VisionConfig
from .colors import detect_colors, mean_hsv_at, hsv_match_name
from .tags import detect_aruco_tags


class VisionEngine:
    """Embedded, in-process vision engine.

    Attributes:
        conf (VisionConfig): Current vision configuration (mutable).
        cam (CameraStream): Background camera stream (server-camera mode).
    """

    def __init__(self, config: Dict[str, Any] = None):
        """Initialize engine, merge optional config, start camera, and warm up first frame."""
        self.conf = VisionConfig()
        if config:
            self.conf.update(config)
        c = self.conf.data

        # Start camera with configured index/size (MJPEG/YUY2 fallback handled in CameraStream)
        self.cam = CameraStream(
            index=c['camera_index'],
            width=c['frame_width'],
            height=c['frame_height']
        ).start()

        # Wait briefly for the first non-empty frame to avoid black startup
        self.cam.wait_for_frame(timeout=2.0)

    def _label_for_id(self, tag_id: int) -> str:
        """Map a numeric ArUco id to a friendly label using config.tag_id_map (fallback: str(id))."""
        mapping = self.conf.data.get("tag_id_map", {}) or {}
        return mapping.get(str(tag_id), str(tag_id))

    def get_frame(self):
        """Return the latest BGR frame from the camera (or None if none yet)."""
        return self.cam.read()

    def analyze(self, modes, params):
        """Run analysis for the current camera frame.

        Behavior:
          • If params.click is present, prefer returning ONLY the entity under the cursor:
            1) If click lies within a tag bbox → return that tag.
            2) Else classify color at the click; attempt to segment that color and keep the region
               containing the click (or fall back to a small box around the click for feedback).
          • If no click:
            - "tags" in modes → detect ArUco tags (optional filter via params.tag_labels)
            - "color" in modes → detect only requested color names via params.colors

        Args:
            modes (list[str]|None): Optional list; supports "tags" and/or "color".
            params (dict|None): Options:
              - bright (bool): scene hint for color thresholds (defaults to conf.data["bright"]).
              - click: {"x": int, "y": int}  → click selection mode.
              - tag_labels: [str]            → filter set of tag labels when modes includes "tags".
              - colors: [str]                → explicit list of color names when modes includes "color".

        Returns:
            dict: {
              "ok": bool,
              "frame_size": [W, H],
              "timestamp": float (seconds),
              "clicked": {...}|None,
              "detections": [ ... ],
              "error": str (optional)
            }
        """
        import cv2, numpy as np  # local imports so module import doesn't require cv2 on non-vision paths

        frame = self.cam.read()
        if frame is None:
            return {"ok": False, "error": "No camera frame"}

        detections: List[Dict[str, Any]] = []
        clicked = None
        p = params or {}
        bright = bool(p.get("bright", self.conf.data.get("bright", False)))
        colors_cfg = self.conf.data.get("colors", {})
        dict_name = self.conf.data.get("aruco", {}).get("dict", "DICT_4X4_50")

        # Helper to test whether a point lies inside a bbox (not used in current code path).
        def contains(pt, bbox, margin: int = 0):
            x, y = pt
            bx, by, bw, bh = bbox
            return (bx - margin) <= x <= (bx + bw + margin) and (by - margin) <= y <= (by + bh + margin)

        # ---------- CLICK: pick ONLY the thing under the cursor --------------------------------
        click = p.get("click")
        if click:
            x = int(click.get("x", -1)); y = int(click.get("y", -1))
            if x >= 0 and y >= 0:
                # 1) Prefer TAG if click is inside a tag box
                try:
                    tag_dets = detect_aruco_tags(frame, dict_name=dict_name)
                    for d in tag_dets:
                        d["label"] = self._label_for_id(d["id"])
                    for d in tag_dets:
                        bx, by, bw, bh = d["bbox"]
                        if (bx <= x <= bx + bw) and (by <= y <= by + bh):
                            clicked = {"type": "tag", "id": d["id"], "label": d["label"], "center_px": d["center_px"]}
                            detections = [d]
                            h, w = frame.shape[:2]
                            return {"ok": True, "frame_size": [w, h], "timestamp": time.time(),
                                    "clicked": clicked, "detections": detections}
                except Exception:
                    # If ArUco is unavailable or fails, we silently fall through to color classification.
                    pass

                # 2) Otherwise classify color at the click point
                H, S, V = mean_hsv_at(frame, x, y, size=24)

                # Local BGR means around the click (helps boundary disambiguation)
                roi_sz = 20
                x1, y1 = max(0, x - roi_sz), max(0, y - roi_sz)
                x2, y2 = min(frame.shape[1], x + roi_sz), min(frame.shape[0], y + roi_sz)
                roi_bgr = frame[y1:y2, x1:x2]
                b_mean = float(np.mean(roi_bgr[...,0])) if roi_bgr.size else 0.0
                g_mean = float(np.mean(roi_bgr[...,1])) if roi_bgr.size else 0.0
                r_mean = float(np.mean(roi_bgr[...,2])) if roi_bgr.size else 0.0

                name = hsv_match_name((H, S, V), colors_cfg, bright=bright, bgr_means=(b_mean, g_mean, r_mean))
                clicked = {"type": "color", "name": name or "unknown", "hsv": [int(H), int(S), int(V)], "point": [x, y]}

                # 3) Try to segment ONLY that color and keep the region containing the click
                strong = set(k.lower() for k in colors_cfg.keys()) - {"white", "gray", "black"}
                chosen = name if name in strong else None
                if chosen:
                    color_dets = detect_colors(frame, colors_cfg, [chosen], bright=bright)
                    containing = []
                    for d in color_dets:
                        bx, by, bw, bh = d["bbox"]
                        if (bx <= x <= bx + bw) and (by <= y <= by + bh):
                            containing.append(d)
                    if containing:
                        # Keep the largest region that contains the click
                        detections = [max(containing, key=lambda d: d["bbox"][2] * d["bbox"][3])]
                    else:
                        # Small visual feedback box if segmentation didn’t catch it
                        pad = 14
                        bx = max(0, x - pad); by = max(0, y - pad)
                        bw = min(frame.shape[1] - bx, 2 * pad); bh = min(frame.shape[0] - by, 2 * pad)
                        detections = [{
                            "type": "color", "color": name or "clicked",
                            "bbox": [int(bx), int(by), int(bw), int(bh)],
                            "center_px": [int(bx + bw/2), int(by + bh/2)],
                            "score": 1.0
                        }]

                h, w = frame.shape[:2]
                return {"ok": True, "frame_size": [w, h], "timestamp": time.time(),
                        "clicked": clicked, "detections": detections}

        # ---------- NO CLICK: honor explicit requests -------------------------------------------
        # Tags (optionally filter by label)
        if "tags" in (modes or []):
            try:
                tag_dets = detect_aruco_tags(frame, dict_name=dict_name)
                for d in tag_dets:
                    d["label"] = self._label_for_id(d["id"])
                want_labels = set([str(x) for x in (p.get("tag_labels") or [])])
                if want_labels:
                    tag_dets = [d for d in tag_dets if d.get("label") in want_labels]
                detections.extend(tag_dets)
            except Exception as e:
                return {"ok": False, "error": f"ArUco not available: {e}"}

        # Colors (only requested names)
        if "color" in (modes or []):
            req_colors = [c.lower() for c in (p.get("colors") or [])]
            if req_colors:
                detections.extend(detect_colors(frame, colors_cfg, req_colors, bright=bright))

        h, w = frame.shape[:2]
        return {"ok": True, "frame_size": [w, h], "timestamp": time.time(),
                "clicked": clicked, "detections": detections}

    def stop(self):
        """Stop camera stream and release resources."""
        self.cam.stop()
