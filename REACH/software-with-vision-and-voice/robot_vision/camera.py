# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: camera.py
# Purpose:
#   • Thin wrapper around OpenCV VideoCapture that:
#       - Tries platform-appropriate backends in order (Windows: DSHOW → MSMF → ANY)
#       - Negotiates FPS/FOURCC/size (prefers MJPG for reliability at 640×480+)
#       - Runs a background grab loop with simple failure detection & auto-reopen
#   • Exposes a thread-safe latest-frame read() for the vision engine/mjpeg stream.
# Notes:
#   • OpenCV returns (H, W, C) arrays. Callers that report [W, H] should swap accordingly.
#   • Printing FOURCC numeric codes as ints is less readable than fourcc string; see comment below.
# =================================================================================================

import cv2, threading, time, os


class CameraStream:
    """Background-grabbing camera with fallback backends and auto-reopen on failure.

    Attributes:
        index (int): OS camera index.
        width (int): Requested width in pixels.
        height (int): Requested height in pixels.
        fps (int|float): Target FPS hint.
        cap (cv2.VideoCapture|None): Underlying capture handle.
        frame (np.ndarray|None): Latest grabbed BGR frame.
        lock (threading.Lock): Protects access to `frame`.
        _stop (bool): Cooperative stop flag for the grab loop.
    """

    def __init__(self, index=0, width=640, height=480, fps=20):
        """Initialize stream parameters; capture is opened in start().

        Args:
            index: Camera index to open (0 by default).
            width: Desired capture width.
            height: Desired capture height.
            fps: Desired capture FPS (hint; drivers may ignore).
        """
        self.index = index
        self.width = width
        self.height = height
        self.fps = fps
        self.cap = None
        self.frame = None
        self.lock = threading.Lock()
        self._stop = False

    # --- helpers ----------------------------------------------------------
    def _open(self, backend):
        """Attempt to open a VideoCapture with an optional backend constant.

        Negotiation order matters on some drivers:
          1) Set FPS first (where supported)
          2) Set FOURCC (MJPG preferred on many Windows cams)
          3) Set frame size
        Then flush a few frames to let exposure/auto-gain settle.

        Returns:
            cv2.VideoCapture|None: Open handle on success, else None.
        """
        cap = cv2.VideoCapture(self.index, backend) if backend is not None else cv2.VideoCapture(self.index)
        if not cap.isOpened():
            return None

        # Order matters on some drivers: FPS -> FOURCC -> size
        if getattr(self, 'fps', None):
            cap.set(cv2.CAP_PROP_FPS, self.fps)

        # Many Windows cams need MJPG for 640x480+ reliably
        try:
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
        except Exception:
            pass

        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)

        # Let the camera settle and flush a few frames
        time.sleep(0.15)
        for _ in range(6):
            cap.read()

        # Verify negotiated settings
        act_w  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        act_h  = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        act_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
        # NOTE: For readability, FOURCC can be printed as string:
        #   f"{''.join([chr((fourcc >> 8*i) & 0xFF) for i in range(4)])}"
        print(f"[vision] idx={self.index} backend={backend} {act_w}x{act_h}@{act_fps:.1f} fourcc={fourcc}")

        # Fallback: if resolution not honored, try YUY2
        if (act_w, act_h) != (self.width, self.height):
            try:
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'YUY2'))
                cap.set(cv2.CAP_PROP_FRAME_WIDTH,  self.width)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                time.sleep(0.1); cap.read()
                act_w  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                act_h  = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                print(f"[vision] retry YUY2 → {act_w}x{act_h}")
            except Exception:
                pass

        return cap

    def _try_open(self):
        """Try a few sane backends in order, platform-aware.

        Windows:
            - CAP_DSHOW (often best control/compat)
            - CAP_MSMF
            - CAP_ANY
        Other OS:
            - CAP_ANY

        Returns:
            cv2.VideoCapture|None
        """
        if os.name == 'nt':  # Windows
            for be, name in [(cv2.CAP_DSHOW, "CAP_DSHOW"), (cv2.CAP_MSMF, "CAP_MSMF"), (None, "CAP_ANY")]:
                cap = self._open(be)
                if cap is not None:
                    print(f"[camera] opened index {self.index} via {name}")
                    return cap
        else:
            cap = self._open(None)
            if cap is not None:
                print(f"[camera] opened index {self.index} via CAP_ANY")
                return cap
        print("[camera] ERROR: unable to open camera")
        return None

    def _reopen(self):
        """Release and reopen with fallback order (used after repeated read failures)."""
        print("[camera] reopening...")
        try:
            if self.cap is not None:
                self.cap.release()
        except Exception:
            pass
        self.cap = self._try_open()

    # --- public API -------------------------------------------------------
    def start(self):
        """Open the camera (with backend fallbacks) and start the background grab loop.

        Returns:
            CameraStream: self, for chaining.
        """
        self.cap = self._try_open()
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()
        return self

    def _loop(self):
        """Background grab loop.

        - Reads frames at ~`fps` (uses 0.7 multiplier to leave headroom).
        - Tracks consecutive failures; after a threshold, attempts a clean reopen.
        - Stores the latest frame under a lock, available via read().
        """
        interval = 1.0 / max(self.fps or 15, 1)
        fail_streak = 0
        while not self._stop:
            if self.cap is None:
                time.sleep(0.5)
                continue
            ok, frame = self.cap.read()
            if ok:
                with self.lock:
                    self.frame = frame
                fail_streak = 0
            else:
                fail_streak += 1
                # Log sparingly to avoid spam
                if fail_streak in (1, 10, 30) or fail_streak % 60 == 0:
                    print(f"[camera] grab failed x{fail_streak}")
                # After enough failures, try a clean reopen
                if fail_streak >= 60:
                    self._reopen()
                    fail_streak = 0
            # Slightly faster than target to avoid drift/queueing under load
            time.sleep(interval * 0.7)

    def read(self):
        """Return a shallow copy of the latest frame (or None if none yet)."""
        with self.lock:
            return None if self.frame is None else self.frame.copy()
        
    def wait_for_frame(self, timeout=2.0, poll=0.05):
        """Block until a frame is available or timeout expires.

        Args:
            timeout (float): Maximum seconds to wait.
            poll (float): Poll interval in seconds.

        Returns:
            np.ndarray|None: The first available frame copy, or None if timed out.
        """
        deadline = time.monotonic() + timeout
        while not self._stop and time.monotonic() < deadline:
            f = self.read()
            if f is not None:
                return f
            time.sleep(poll)
        return None

    def stop(self):
        """Signal the grab loop to stop and release the capture handle."""
        self._stop = True
        try:
            if self.cap is not None:
                self.cap.release()
        except Exception:
            pass
