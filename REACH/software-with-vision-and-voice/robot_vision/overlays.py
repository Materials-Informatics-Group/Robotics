# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: robot_vision/overlays.py
# Purpose:
#   • Simple drawing helpers for visualizing detections on BGR images.
#   • Renders bounding boxes, a center point, and a text label per detection.
# Notes:
#   • Input images are assumed to be BGR (OpenCV) uint8 arrays of shape (H, W, 3).
#   • Detections are expected to include: "type", "bbox" [x,y,w,h], "center_px" [cx,cy],
#     and for labels either "color" (color type) or "label"/"id" (tag type).
# =================================================================================================

import cv2


def draw_overlays(bgr, detections):
    """
    Draw bounding boxes + labels for each detection and return a new image.

    Args:
        bgr (np.ndarray): Source image in BGR order (H×W×3, uint8).
        detections (list[dict]): Each item should include:
            - "type": "color" | "tag" | other
            - "bbox": [x, y, w, h]  (integers, pixel units)
            - "center_px": [cx, cy] (integers, pixel units)
            - For "color": "color": "<name>"
            - For "tag":   "label": "<name>" or fallback to "id"

    Returns:
        np.ndarray: A copy of the input with overlays drawn.
    """
    # Work on a copy so callers keep the original image intact
    out = bgr.copy()

    # Iterate over all detections and render simple primitives
    for d in detections:
        # Extract rectangle
        x, y, w, h = d["bbox"]

        # Pick color/label by detection type
        if d["type"] == "color":
            color = (0, 255, 0)  # green for color-class detections
            label = d.get("color", "")
        else:
            color = (255, 0, 0)  # blue for tag-class detections
            label = d.get("label", f"tag {d.get('id', '')}")

        # Bounding box
        cv2.rectangle(out, (x, y), (x + w, y + h), color, 2)

        # Center marker (small red dot)
        cx, cy = d["center_px"]
        cv2.circle(out, (cx, cy), 4, (0, 0, 255), -1)

        # Text label above the box
        cv2.putText(
            out,
            label,
            (x, max(0, y - 5)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            2,
            cv2.LINE_AA
        )

    return out
