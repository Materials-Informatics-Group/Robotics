# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: robot_vision/config.py
# Purpose:
#   • Central configuration for the Vision subsystem (defaults + simple merge wrapper).
#   • Exposes DEFAULT_CONFIG and a VisionConfig dataclass with .update() and .to_dict().
# Notes:
#   • OpenCV HSV ranges: H ∈ [0..179], S ∈ [0..255], V ∈ [0..255].
#   • Red spans the 179→0 wrap; handled by two ranges in DEFAULT_CONFIG["colors"]["red"].
#   • The default_factory currently uses a *shallow* copy of DEFAULT_CONFIG.
#     If per-instance mutation of nested dicts is expected, consider deepcopy (see suggestions below).
# =================================================================================================

from dataclasses import dataclass, field
from typing import Dict, Any
import copy

# -------------------------------------------------------------------------------------------------
# Global defaults for the vision module.
# - bright: scene hint for color logic
# - camera_index / frame_* / stream_fps: capture & streaming parameters
# - aruco: dictionary name for ArUco detection
# - colors: HSV in-range presets per color (each entry may be a union of ranges)
# - tag_id_map: optional mapping from numeric ArUco ids to friendly labels (e.g., A–D, 1–4)
# -------------------------------------------------------------------------------------------------
# HSV presets (H 0-179 in OpenCV)
DEFAULT_CONFIG = {
    "bright": True,
    "camera_index": 0,
    "frame_width": 640,
    "frame_height": 480,
    "stream_fps": 20,
    "aruco": {"dict": "DICT_4X4_50"},
    "colors": {
        "red": [
            {"low": [0, 50, 50],   "high": [8, 255, 255]},
            {"low": [173, 50, 50], "high": [179, 255, 255]}
        ],
        "orange": [ {"low": [8, 50, 50],   "high": [20, 255, 255]} ],
        "yellow": [ {"low": [20, 50, 50],  "high": [35, 255, 255]} ],
        "green":  [ {"low": [35, 50, 50],  "high": [85, 255, 255]} ],
        "cyan":   [ {"low": [85, 50, 50],  "high": [100, 255, 255]} ],
        "blue":   [ {"low": [100, 50, 50], "high": [135, 255, 255]} ],
        "purple": [ {"low": [135, 50, 50], "high": [160, 255, 255]} ],
        "pink":   [ {"low": [160, 50, 50], "high": [173, 255, 255]} ],
        "white":  [ {"low": [0, 0, 200],   "high": [179, 40, 255]} ],
        "gray":   [ {"low": [0, 0, 80],    "high": [179, 40, 200]} ],
        "black":  [ {"low": [0, 0, 0],     "high": [179, 255, 40]} ]
    },
    # Map ArUco numeric IDs to friendly labels used in UI (A-D,1-4 etc.)
    # Leave empty to default to str(id). You can override in vision.config.json.
    "tag_id_map": {
        "0": "A", "1": "B", "2": "C", "3": "D",
        "4": "1", "5": "2", "6": "3", "7": "4"
    }
}

@dataclass
class VisionConfig:
    """
    Mutable configuration wrapper for the vision system.

    Attributes:
        data (dict): Backing store for configuration values. Initialized from DEFAULT_CONFIG
                     via a *shallow* copy (nested dicts/lists are shared references).

    Usage:
        conf = VisionConfig()
        conf.update({"frame_width": 800, "frame_height": 600})
        d = conf.to_dict()
    """
    
    data: Dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULT_CONFIG))


    def update(self, new_conf: Dict[str, Any]):
        """
        Recursively merge keys from new_conf into self.data.
        - Dict values merge deeply.
        - Non-dict values replace existing entries.

        Args:
            new_conf (dict): User-supplied configuration diff to apply.
        """
        def merge(a, b):
            for k, v in b.items():
                if isinstance(v, dict) and isinstance(a.get(k), dict):
                    merge(a[k], v)
                else:
                    a[k] = v
        merge(self.data, new_conf)

    def to_dict(self):
        """Return the underlying configuration dictionary."""
        return self.data
