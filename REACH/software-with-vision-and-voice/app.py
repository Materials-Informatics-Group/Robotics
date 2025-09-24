# =================================================================================================
# Project: REACH App — UI web application to control the REACH robot arm
# Institution: Hokkaido University (2025)
# Last Update: Q3 2025
# -------------------------------------------------------------------------------------------------
# Authors:
#   • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
# -------------------------------------------------------------------------------------------------
# File: app.py
# Purpose:
#   • Flask backend for the REACH robot arm UI.
#   • Exposes endpoints for serial communication, command logging, status checks,
#     and 2.5D calibration utilities. Optionally mounts the vision blueprint.
#
# Notes:
#   • No functional changes in this pass — comments and headers only.
#   • Potential improvement (optional): the `os` import currently sits inside a try/except
#     that guards the OpenCV import; if OpenCV is unavailable, `os` won’t be imported before
#     it’s used to compute CALIB_FILE. Consider importing `os` at the top-level instead.
# =================================================================================================

from flask import Flask, request, jsonify, send_from_directory
import serial
import serial.tools.list_ports
from functools import wraps
import threading
import time
from collections import deque
import datetime
import json
import atexit
import os

# -----------------------------------------------------
# Flask App Configuration
# -----------------------------------------------------
app = Flask(__name__, static_url_path='', static_folder='static')

# ---- Global Configuration / Defaults ----
DEVELOPMENT_MODE = True
DEFAULT_PORT = "COM3"
PASSWORD = "letmein"
BAUD_RATE = 9600
ENABLE_AUTO_RECONNECT = True
USE_HTTPS = True  # Set to True if you want HTTPS
SSL_CERT = '192.168.12.116+1.pem'        # e.g. "myrobot.local.pem"
SSL_KEY  = '192.168.12.116+1-key.pem'    # e.g. "myrobot.local-key.pem"

# ---- Vision (embedded; optional blueprint) ----
CAMERA_INDEX = 0  # REACH laptop uses index 0
try:
    from robot_vision.integration.flask_blueprint import make_vision_blueprint
    vision_bp = make_vision_blueprint(config={
        "camera_index": CAMERA_INDEX,
        "frame_width": 640,
        "frame_height": 480,
        "stream_fps": 20,
        "aruco": {"dict": "DICT_4X4_50"},
        "bright": True,  # default to bright environment
        # Optional: label mapping for pretty tag names (adjust as you like)
        "tag_id_map": {"0": "A", "1": "B", "2": "C", "3": "D", "4": "1", "5": "2", "6": "3", "7": "4"},
    })
    app.register_blueprint(vision_bp, url_prefix="/vision")
    print("[vision] blueprint registered at /vision")
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"[vision] failed to initialize: {e}")

# -----------------------------------------------------
# Global State
# -----------------------------------------------------
ser = None                                 # serial.Serial instance (or None)
history = []                               # rolling list of {cmd, response, timestamp}
serial_buffer = deque(maxlen=100)          # recent raw lines from robot
serial_lock = threading.Lock()             # guard serial access
listener_active = False                    # hint to reconnect loop

# -----------------------------------------------------
# Security Middleware
# -----------------------------------------------------
def require_password(f):
    """
    In production (DEVELOPMENT_MODE=False), enforce a simple password
    supplied in the JSON body as {"password": "..."}.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not DEVELOPMENT_MODE:
            data = request.get_json() or {}
            if data.get('password') != PASSWORD:
                return jsonify({'status': 'error', 'message': 'Unauthorized'}), 403
        return f(*args, **kwargs)
    return decorated_function

# -----------------------------------------------------
# Serial Communication Setup
# -----------------------------------------------------
def init_serial():
    """Open the default serial port if available; set global `ser`."""
    global ser
    try:
        ser = serial.Serial(DEFAULT_PORT, BAUD_RATE, timeout=1)
        print(f"✅ Serial initialized on {DEFAULT_PORT}")
    except Exception as e:
        print(f"❌ Failed to open {DEFAULT_PORT}: {e}")
        ser = None

def auto_reconnect_loop():
    """
    Background loop: if serial connection is missing or broken,
    periodically attempt to reconnect and (re)start the listener thread.
    """
    global ser, listener_active
    while True:
        needs_reconnect = False
        if ser is None:
            needs_reconnect = True
        else:
            try:
                _ = ser.in_waiting
            except Exception as e:
                print(f"⚠️ Serial port access failed: {e}")
                try:
                    ser.close()
                except:
                    pass
                ser = None
                needs_reconnect = True
                listener_active = False

        if needs_reconnect:
            try:
                ser = serial.Serial(DEFAULT_PORT, baudrate=BAUD_RATE, timeout=1)
                print(f"🔁 Auto-reconnected to {DEFAULT_PORT}")
                if not listener_active:
                    threading.Thread(target=serial_listener, daemon=True).start()
                    listener_active = True
                    print("🟢 Serial listener restarted after reconnect")
            except Exception as e:
                print(f"⛔ Auto-reconnect failed: {e}")
                ser = None

        time.sleep(5)

# -----------------------------------------------------
# Serial Listener (runs on background thread)
# -----------------------------------------------------
def serial_listener():
    """
    Continuously read lines from the serial port and push them into
    `serial_buffer` with timestamps, guarded by `serial_lock`.
    """
    global ser
    print("🔄 Serial listener active...")
    while True:
        with serial_lock:
            if ser and ser.in_waiting:
                try:
                    line = ser.readline().decode(errors='ignore').strip()
                    if line:
                        serial_buffer.append({'timestamp': time.time(), 'data': line})
                        print(f"[BUFFER SIZE: {len(serial_buffer)}] 🛰️ Robot says: {line}")
                except Exception as e:
                    print(f"❌ Listener error: {e}")
        time.sleep(0.01)

def wait_for_new_response(since_time, timeout=2.0):
    """
    Return the first serial line observed at/after `since_time` (with a small grace),
    or "No response" if nothing arrives before `timeout`.
    """
    start = time.time()
    grace = 0.05
    while time.time() - start < timeout:
        with serial_lock:
            for item in list(serial_buffer):
                ts = item['timestamp']
                if ts >= since_time - grace:
                    return item['data']
        time.sleep(0.01)
    return "No response"

# -----------------------------------------------------
# Utility Functions
# -----------------------------------------------------
def log_command(cmd, response):
    """Append a command/response pair to the rolling history."""
    timestamp = datetime.datetime.now().isoformat()
    history.append({'cmd': cmd, 'response': response, 'timestamp': timestamp})
    if len(history) > 50:
        history.pop(0)

@app.route('/status', methods=['GET'])
def get_status():
    """Lightweight health check: is the serial device connected and open?"""
    connected = False
    if ser:
        try:
            _ = ser.in_waiting
            connected = ser.is_open
        except:
            connected = False
    return jsonify({'connected': connected})

# -----------------------------------------------------
# API Routes
# -----------------------------------------------------
@app.route('/')
def serve_index():
    """Serve the SPA entry point from /static."""
    return send_from_directory('static', 'index.html')

@app.route('/ports', methods=['GET'])
def list_ports():
    """Enumerate available serial ports on the host."""
    ports = [port.device for port in serial.tools.list_ports.comports()]
    return jsonify({'ports': ports})

@app.route('/log', methods=['GET'])
@require_password
def get_log():
    """Return recent command/response history."""
    return jsonify(history)

@app.route('/connect', methods=['POST'])
@require_password
def connect():
    """
    Open a serial connection to a specific port.
    Body: {"port": "COMx" | "/dev/ttyUSBx", ...}
    """
    global ser
    data = request.get_json()
    port = data.get('port')
    if not port:
        return jsonify({'status': 'error', 'message': 'No port specified'}), 400

    try:
        if ser and ser.is_open:
            ser.close()
        ser = serial.Serial(port, BAUD_RATE, timeout=1)
        return jsonify({'status': 'success', 'message': f'Connected to {port}'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/send', methods=['POST'])
@require_password
def send_command():
    """
    Send a raw command string to the robot and wait briefly for a response.
    Response auto-parses JSON payloads, and falls back to "ACK/ERR/unknown".
    """
    global ser
    data = request.get_json()
    if not data or 'command' not in data:
        return jsonify({'status': 'error', 'message': 'No command provided'}), 400

    cmd = data['command'].strip()

    if ser is None or not ser.is_open:
        return jsonify({'status': 'error', 'message': 'Serial port not available'}), 500

    try:
        since = time.time()
        ser.write((cmd + '\n').encode())
        response = wait_for_new_response(since)
        log_command(cmd, response)

        if response == "No response":
            return jsonify({'status': 'error', 'message': 'No response from robot'})

        # If the robot returned a JSON blob, pass it straight through.
        try:
            parsed = json.loads(response)
            return jsonify(parsed)
        except:
            pass

        # Otherwise, map common plain-text responses to a simple shape.
        if response.startswith("ACK"):
            return jsonify({'status': 'success', 'message': response})
        elif response.startswith("ERR"):
            return jsonify({'status': 'error', 'message': response})
        else:
            return jsonify({'status': 'unknown', 'message': response})

    except Exception as e:
        print(f"❌ Serial error: {e}")
        return jsonify({'status': 'error', 'message': 'Failed to send command'}), 500

@app.route('/log/clear', methods=['POST'])
@require_password
def clear_log():
    """Clear in-memory history."""
    global history
    history = []
    return jsonify({'status': 'success', 'message': 'History cleared'})

# -----------------------------------------------------
# App Bootstrap / Shutdown
# -----------------------------------------------------
@atexit.register
def cleanup():
    """Close the serial port cleanly on interpreter exit."""
    global ser
    try:
        if ser and ser.is_open:
            ser.close()
            print("🔌 Serial port closed.")
    except Exception as e:
        print(f"⚠️ Serial close error: {e}")

# -----------------------------------------------------
# 2.5D Calibration Endpoints (homography + config)
# -----------------------------------------------------
try:
    import numpy as np
    import cv2    
    HAVE_CV = True
except Exception as _e:
    print("[calibration] OpenCV not available in app.py context:", _e)    
    HAVE_CV = False

CALIB_FILE = os.path.join(app.static_folder, "calibration.json")

def _load_calib():
    """Load calibration JSON from the static folder; return {} if missing/invalid."""
    try:
        with open(CALIB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_calib(data: dict):
    """Persist calibration JSON; return True on success, False otherwise."""
    try:
        os.makedirs(os.path.dirname(CALIB_FILE), exist_ok=True)
        with open(CALIB_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        print("[calibration] save error:", e)
        return False

@app.route("/calibration/get", methods=["GET"])
def calibration_get():
    """Return the current calibration blob (homography, sizes, fixed poses, etc.)."""
    return jsonify({"ok": True, "data": _load_calib()})

@app.route("/calibration/save", methods=["POST"])
@require_password
def calibration_save():
    """Overwrite the calibration blob with the provided JSON body."""
    data = request.get_json(silent=True) or {}
    ok = _save_calib(data)
    return jsonify({"ok": ok})

@app.route("/calibration/solve", methods=["POST"])
def calibration_solve():
    """
    Compute a homography H (and inverse Hi) from 4 image points to world coords.
    Body:
      {
        "image_points": [[x,y], [x,y], [x,y], [x,y]],
        "world_width_mm":  <number>,
        "world_height_mm": <number>
      }
    """
    
    if not HAVE_CV:
        return jsonify({"ok": False, "error": "OpenCV/NumPy not installed"}), 501
    data = request.get_json(silent=True) or {}
    pts = data.get("image_points") or []
    Wmm = float(data.get("world_width_mm", 0))
    Hmm = float(data.get("world_height_mm", 0))
    if len(pts) != 4 or Wmm <= 0 or Hmm <= 0:
        return jsonify({"ok": False, "error": "invalid payload"}), 400
    try:
        src = np.array(pts, dtype=np.float32)
        dst = np.array([[0, 0], [Wmm, 0], [Wmm, Hmm], [0, Hmm]], dtype=np.float32)
        H, _ = cv2.findHomography(src, dst, method=0)
        if H is None:
            # Fallback to perspective transform if RANSAC/0 method failed to give H
            H = cv2.getPerspectiveTransform(src.astype(np.float32), dst.astype(np.float32))
        Hi = np.linalg.inv(H)
        return jsonify({"ok": True, "H": H.tolist(), "Hi": Hi.tolist()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# -----------------------------------------------------
# Main Entry
# -----------------------------------------------------
if __name__ == '__main__':
    # Initialize serial + background helpers
    init_serial()
    if ENABLE_AUTO_RECONNECT:
        threading.Thread(target=auto_reconnect_loop, daemon=True).start()
    threading.Thread(target=serial_listener, daemon=True).start()
    # listener_active is used as a hint in reconnect loop
    listener_active = True

    # Start Flask with HTTP or HTTPS, as configured.
    if USE_HTTPS:
        app.run(host='0.0.0.0', port=443, ssl_context=(SSL_CERT, SSL_KEY))
    else:
        app.run(host='0.0.0.0', port=5000)  # Plain HTTP
