# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: robot_vision/tags.py
# Purpose:
#   • Detect ArUco tags in a BGR image and return simple detection dicts for the UI/engine.
# Notes:
#   • Requires OpenCV with contrib (cv2.aruco). On many systems this is the package
#     `opencv-contrib-python`, not just `opencv-python`.
#   • Returns the first successful detection set across a few contrast-enhanced variants.
# =================================================================================================

import cv2

def detect_aruco_tags(bgr, dict_name: str = "DICT_4X4_50"):
    """
    Detect ArUco tags in a BGR frame.

    Args:
        bgr (np.ndarray): Input image in BGR format (H×W×3, uint8).
        dict_name (str): Name of the aruco dictionary attribute (e.g., "DICT_4X4_50",
                         "DICT_6X6_250"). If not found, falls back to DICT_4X4_50.

    Returns:
        list[dict]: A list of detections, each with:
            {
              "type": "tag",
              "id": <int>,
              "bbox": [x, y, w, h],
              "center_px": [cx, cy],
              "score": 1.0
            }
        If no tags are found, returns [].

    Notes:
        • To improve robustness under varied lighting, the function tries multiple
          grayscale variants: raw gray, CLAHE, and min-max normalization.
        • Early-exits on the first variant that yields detections.
    """    
    from cv2 import aruco

    # Resolve dictionary from string; fall back to a safe default if unknown.
    try:
        aruco_dict = getattr(aruco, dict_name)
    except AttributeError:
        aruco_dict = aruco.DICT_4X4_50

    dictionary = aruco.getPredefinedDictionary(aruco_dict)
    params = aruco.DetectorParameters()          # default detector params
    detector = aruco.ArucoDetector(dictionary, params)

    # Prepare grayscale candidates with different contrast treatments.
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    tries = [gray]

    # CLAHE for blown-out/flat lighting (best-effort; ignore if unavailable).
    try:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        tries.append(clahe.apply(gray))
    except Exception:
        pass

    # Min-max normalization to stretch contrast (best-effort).
    try:
        tries.append(cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX))
    except Exception:
        pass

    # Run detection on each variant; return the first non-empty set.
    for g in tries:
        corners, ids, _ = detector.detectMarkers(g)
        detections = []
        if ids is not None:
            for i, c in enumerate(corners):
                # Bounding box from the quadrilateral corners
                pts = c.reshape(-1, 2)
                x, y, w, h = cv2.boundingRect(pts.astype("int32"))
                # Center as mean of corner points
                cx, cy = int(pts[:, 0].mean()), int(pts[:, 1].mean())

                detections.append({
                    "type": "tag",
                    "id": int(ids[i][0]),
                    "bbox": [int(x), int(y), int(w), int(h)],
                    "center_px": [cx, cy],
                    "score": 1.0
                })
        if detections:
            return detections

    # No detections in any variant.
    return []
