from flask import Flask, request, jsonify, send_from_directory, Response
import serial
import serial.tools.list_ports
import os
from functools import wraps
import threading
import time
from collections import deque
import datetime
import json
import cv2
import atexit

# -----------------------------------------------------
# Flask App Configuration
# -----------------------------------------------------
app = Flask(__name__, static_url_path='', static_folder='static')

# Global Configuration
DEVELOPMENT_MODE = True
DEFAULT_PORT = "COM3"
PASSWORD = "letmein"
BAUD_RATE = 9600
ENABLE_AUTO_RECONNECT = True

# Global State
ser = None
history = []
serial_buffer = deque(maxlen=100)
serial_lock = threading.Lock()
listener_active = False

# -----------------------------------------------------
# Security Middleware
# -----------------------------------------------------
def require_password(f):
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
    global ser
    try:
        ser = serial.Serial(DEFAULT_PORT, BAUD_RATE, timeout=1)
        print(f"✅ Serial initialized on {DEFAULT_PORT}")
    except Exception as e:
        print(f"❌ Failed to open {DEFAULT_PORT}: {e}")
        ser = None

def auto_reconnect_loop():
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
    timestamp = datetime.datetime.now().isoformat()
    history.append({'cmd': cmd, 'response': response, 'timestamp': timestamp})
    if len(history) > 50:
        history.pop(0)

@app.route('/status', methods=['GET'])
def get_status():
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
    return send_from_directory('static', 'index.html')

@app.route('/ports', methods=['GET'])
def list_ports():
    ports = [port.device for port in serial.tools.list_ports.comports()]
    return jsonify({'ports': ports})

@app.route('/log', methods=['GET'])
@require_password
def get_log():
    return jsonify(history)

@app.route('/connect', methods=['POST'])
@require_password
def connect():
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

        try:
            parsed = json.loads(response)
            return jsonify(parsed)
        except:
            pass

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
    global history
    history = []
    return jsonify({'status': 'success', 'message': 'History cleared'})

# -----------------------------------------------------
# Camera Streaming (USB cam index hardcoded to 2)
# -----------------------------------------------------
camera = cv2.VideoCapture(2)  # Confirmed cam

def generate_video_stream():
    while True:
        success, frame = camera.read()
        if not success:
            break
        ret, buffer = cv2.imencode('.jpg', frame)
        frame = buffer.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

@app.route('/video_feed')
def video_feed():
    return Response(generate_video_stream(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/cam_status')
def cam_status():
    return jsonify({'opened': camera.isOpened()})

@atexit.register
def cleanup():
    if camera.isOpened():
        camera.release()
        print("🎥 Camera released.")

# -----------------------------------------------------
# App Bootstrap
# -----------------------------------------------------
if __name__ == '__main__':
    init_serial()
    if ENABLE_AUTO_RECONNECT:
        threading.Thread(target=auto_reconnect_loop, daemon=True).start()
    threading.Thread(target=serial_listener, daemon=True).start()
    listener_active = True
    ssl_cert = '192.168.12.123.pem'
    ssl_key = '192.168.12.123-key.pem'
    app.run(host='0.0.0.0', port=443, ssl_context=(ssl_cert, ssl_key))
