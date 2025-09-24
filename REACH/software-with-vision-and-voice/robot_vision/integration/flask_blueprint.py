# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: flask_blueprint.py
# Purpose:
#   • Flask blueprint exposing the Vision UI/API.
#   • Supports both server-camera mode (MJPEG stream from VisionEngine) and browser-only mode
#     (getUserMedia frame uploads from the client).
#
# Public Routes (mounted under /vision):
#   GET  /health
#   POST /analyze                # server-camera analysis via VisionEngine
#   GET  /stream                 # server-camera MJPEG stream
#   GET  /panel                  # server-camera vision panel (templates/vision_panel.html)
#   GET  /panel_browser          # browser-camera panel (templates/panel_browser.html)
#   POST /upload/analyze         # browser-camera: analyze a click location on uploaded frame
#   POST /upload/find            # browser-camera: find a color on uploaded frame
#   POST /upload/find_tag        # browser-camera: find an ArUco tag on uploaded frame
# Notes:
#   • frame.shape[:2] returns (H, W). Responses return frame_size as [W, H] to match frontend code.
#   • ArUco tag labels can be remapped via conf.data["tag_id_map"].
# =================================================================================================

from flask import Blueprint, jsonify, request, Response, render_template
import cv2, time, base64, numpy as np

from ..vision_engine import VisionEngine
from ..colors import detect_colors, mean_hsv_at, hsv_match_name
from ..tags   import detect_aruco_tags


def make_vision_blueprint(config=None):
    """
    Create and return the Flask Blueprint that serves all vision-related endpoints and pages.

    Args:
        config (dict|None): Optional configuration blob passed to VisionEngine and used
            for certain route defaults (e.g., stream_fps, tag dictionary, color config).

    Returns:
        flask.Blueprint: A blueprint named 'vision' with routes mounted at /vision/*.

    Exposes:
        /vision/health
        /vision/analyze                (server-camera mode; uses VisionEngine camera)
        /vision/stream                 (server-camera MJPEG stream)
        /vision/panel                  (server-camera panel; existing)
        /vision/panel_browser          (browser-camera panel; no camera index)
        /vision/upload/analyze         (browser-camera: click analyze)
        /vision/upload/find            (browser-camera: find color)
        /vision/upload/find_tag        (browser-camera: find ArUco tag)
    """
    bp = Blueprint('vision', __name__, template_folder='templates', static_folder='static' )

    # Engine instance for server-camera mode (captures frames and performs analysis).
    engine = VisionEngine(config=config or {})

    # -------------------------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------------------------
    def _decode_data_url(data_url: str) -> np.ndarray:
        """Decode a data: URL (JPEG/PNG) into a BGR numpy image (cv2)."""
        if not data_url or "," not in data_url:
            raise ValueError("Invalid data URL")
        _, encoded = data_url.split(",", 1)
        buf = base64.b64decode(encoded)
        arr = np.frombuffer(buf, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode image")
        return img

    def _label_for_tag_id(tag_id: int) -> str:
        """Return a human-friendly label for a detected tag id using conf.data['tag_id_map'], if any."""
        idmap = (engine.conf.data.get("tag_id_map") or {})
        return idmap.get(str(tag_id), str(tag_id))

    # -------------------------------------------------------------------------------------------
    # Server-camera routes (VisionEngine-based)
    # -------------------------------------------------------------------------------------------
    @bp.route("/health")
    def health():
        """Simple health probe; indicates whether a frame can be captured right now."""
        return jsonify({"status": "ok", "camera_ready": engine.get_frame() is not None})

    @bp.route("/analyze", methods=["POST"])
    def analyze():
        """
        Analyze the current server-camera frame.

        Request JSON:
            { "modes": [...], "params": {...} }

        Returns:
            JSON with fields produced by VisionEngine.analyze(), typically:
            { "ok": true, "detections": [...], "frame_size": [W, H], ... }
        """
        payload = request.get_json(silent=True) or {}
        modes = payload.get("modes", [])
        params = payload.get("params", {})
        return jsonify(engine.analyze(modes, params))

    def mjpeg_gen():
        """
        Generator that yields a multipart/x-mixed-replace MJPEG stream at the configured FPS.
        """
        fps_delay = 1.0 / max(1, int((config or {}).get("stream_fps", 20)))
        while True:
            frame = engine.get_frame()
            if frame is None:
                time.sleep(0.05)
                continue
            ok, jpg = cv2.imencode(".jpg", frame)
            if not ok:
                continue
            # Boundary must match 'boundary=frame' in the Response mimetype below.
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n")
            time.sleep(fps_delay)

    @bp.route("/stream")
    def stream():
        """Serve the MJPEG stream for the server camera."""
        return Response(mjpeg_gen(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @bp.route("/panel")
    def panel():
        """Render the server-camera vision panel UI."""
        return render_template("vision_panel.html")

    # -------------------------------------------------------------------------------------------
    # Browser-camera routes (client uploads a frame)
    # -------------------------------------------------------------------------------------------
    @bp.route("/panel_browser")
    def panel_browser():
        """Render the browser-only vision panel UI (uses getUserMedia in the browser)."""
        # Separate HTML/JS/CSS files served from /vision/static and /vision/templates
        return render_template("panel_browser.html")

    @bp.route("/upload/analyze", methods=["POST"])
    def upload_analyze():
        """
        Analyze a single uploaded frame and a click location.
        Preference: if the click falls inside a detected tag, return that tag; otherwise return color.
        Request JSON:
            {
              "image": "data:image/jpeg;base64,...",
              "x": <int>, "y": <int>,
              "bright": <bool>   # optional, hints color thresholding
            }
        Response JSON:
            { "ok": true, "frame_size": [W, H], "clicked": {"x":...,"y":...}, "detections": [...] }
        """
        data = request.get_json(silent=True) or {}
        data_url = data.get("image", "")
        x = int(data.get("x", -1))
        y = int(data.get("y", -1))
        bright = bool(data.get("bright", engine.conf.data.get("bright", False)))

        frame = _decode_data_url(data_url)
        H, W = frame.shape[:2]  # shape yields (H, W); we return [W, H] to clients

        # 1) Prefer tag if click lies inside a tag bbox (with small margin)
        dict_name = engine.conf.data.get("aruco", {}).get("dict", "DICT_4X4_50")
        tag_dets = detect_aruco_tags(frame, dict_name=dict_name)
        for d in tag_dets:
            d["label"] = _label_for_tag_id(d["id"])
            bx, by, bw, bh = d["bbox"]
            if (bx - 4) <= x <= (bx + bw + 4) and (by - 4) <= y <= (by + bh + 4):
                return jsonify({
                    "ok": True,
                    "frame_size": [W, H],
                    "clicked": {"x": x, "y": y},
                    "detections": [d]
                })

        # 2) Otherwise, report the color under/around the click (BGR refinement in a 48×48 ROI)
        Hc, Sc, Vc = mean_hsv_at(frame, x, y, size=24)
        x1, y1 = max(0, x - 24), max(0, y - 24)
        x2, y2 = min(W, x + 24), min(H, y + 24)
        roi = frame[y1:y2, x1:x2]
        if roi.size:
            b = float(np.mean(roi[..., 0])); g = float(np.mean(roi[..., 1])); r = float(np.mean(roi[..., 2]))
        else:
            b = g = r = 0.0

        colors_cfg = engine.conf.data.get("colors", {})
        name = hsv_match_name((Hc, Sc, Vc), colors_cfg, bright=bright, bgr_means=(b, g, r))

        det = {
            "type": "color",
            "color": name or "unknown",
            "bbox": [x1, y1, max(2, x2 - x1), max(2, y2 - y1)],
            "center_px": [int((x1 + x2) / 2), int((y1 + y2) / 2)],
            "score": 1.0
        }
        return jsonify({
            "ok": True,
            "frame_size": [W, H],
            "clicked": {"x": x, "y": y},
            "detections": [det]
        })

    @bp.route("/upload/find", methods=["POST"])
    def upload_find():
        """
        Find a specific color on the uploaded frame.
        Request JSON:
            { "image": "data:image/jpeg;base64,...", "color": "<name>", "bright": <bool> }
        Response JSON:
            { "ok": true, "frame_size": [W, H], "detections": [...] }
        """
        data = request.get_json(silent=True) or {}
        data_url = data.get("image", "")
        color = (data.get("color") or "").lower()
        bright = bool(data.get("bright", engine.conf.data.get("bright", False)))

        frame = _decode_data_url(data_url)
        dets = detect_colors(frame, engine.conf.data.get("colors", {}), [color], bright=bright)
        H, W = frame.shape[:2]
        return jsonify({"ok": True, "frame_size": [W, H], "detections": dets})

    @bp.route("/upload/find_tag", methods=["POST"])
    def upload_find_tag():
        """
        Find ArUco tags on the uploaded frame, optionally filtering to a requested tag/label.
        Request JSON:
            { "image": "data:image/jpeg;base64,...", "tag": "<id-or-label>" }
        Response JSON:
            { "ok": true, "frame_size": [W, H], "detections": [...] }
        """
        data = request.get_json(silent=True) or {}
        data_url = data.get("image", "")
        want = (data.get("tag") or "").strip()

        frame = _decode_data_url(data_url)
        dict_name = engine.conf.data.get("aruco", {}).get("dict", "DICT_4X4_50")
        dets = detect_aruco_tags(frame, dict_name=dict_name)
        for d in dets:
            d["label"] = _label_for_tag_id(d["id"])
        if want:
            dets = [d for d in dets if str(d["id"]) == want or d["label"] == want]

        H, W = frame.shape[:2]
        return jsonify({"ok": True, "frame_size": [W, H], "detections": dets})

    return bp
