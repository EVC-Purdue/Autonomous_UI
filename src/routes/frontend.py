import os
import socket
from pathlib import Path
import requests
import urllib3.util.connection as urllib3_conn

from flask import Blueprint, send_from_directory, request, jsonify

# Force IPv4 — phone hotspot NAT64 misroutes IPv6 to carrier's network
urllib3_conn.allowed_gai_family = lambda: socket.AF_INET

# Kart API configuration
KART_API_BASE = "http://100.93.187.32:8000"
frontend = Blueprint(
    "frontend",
    __name__,
    static_folder=Path(os.path.abspath(__file__)).parent.parent.joinpath("frontend"),
)
print(str(Path(os.path.abspath(__file__)).parent.parent.joinpath("frontend")))


@frontend.get("/scripts.js")
def scripts():
    return frontend.send_static_file("scripts.js")


@frontend.get("/styles.css")
def styles():
    return frontend.send_static_file("styles.css")


@frontend.route("/", methods=["GET"])
def root():
    return send_from_directory(frontend.static_folder, "index.html")


# Proxy endpoints to avoid CORS issues
@frontend.route("/api/get_state", methods=["GET"])
def proxy_get_state():
    try:
        response = requests.get(f"{KART_API_BASE}/get_state", timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/set_state", methods=["POST"])
def proxy_set_state():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/set_state", json=data, timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        print(f"[set_state] {type(e).__name__}: {e}")
        return {"error": str(e)}, 500


@frontend.route("/api/odom", methods=["GET"])
def proxy_odom():
    try:
        response = requests.get(f"{KART_API_BASE}/odom", timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        print(f"[proxy_odom] {type(e).__name__}: {e}")
        return {"error": f"{type(e).__name__}: {e}"}, 500


@frontend.route("/api/manual_control", methods=["POST"])
def proxy_manual_control():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/manual_control", json=data, timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/get_logs", methods=["GET"])
def proxy_get_logs():
    try:
        response = requests.get(f"{KART_API_BASE}/get_logs", timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/map", methods=["GET"])
def proxy_map():
    try:
        response = requests.get(f"{KART_API_BASE}/map", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/lines", methods=["GET"])
def proxy_lines():
    try:
        response = requests.get(f"{KART_API_BASE}/lines", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/racing_line", methods=["GET"])
def proxy_racing_line():
    try:
        response = requests.get(f"{KART_API_BASE}/racing_line", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/e_comms", methods=["GET"])
def proxy_e_comms():
    try:
        response = requests.get(f"{KART_API_BASE}/e_comms", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/imu/status", methods=["GET"])
def proxy_imu_status():
    try:
        response = requests.get(f"{KART_API_BASE}/imu/status", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/imu", methods=["GET"])
def proxy_imu():
    try:
        response = requests.get(f"{KART_API_BASE}/imu", timeout=2)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/imu/calibrate", methods=["POST"])
def proxy_imu_calibrate():
    try:
        response = requests.post(f"{KART_API_BASE}/imu/calibrate", timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/imu/calibrate_yaw", methods=["POST"])
def proxy_imu_calibrate_yaw():
    try:
        response = requests.post(f"{KART_API_BASE}/imu/calibrate_yaw", timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/gps", methods=["GET"])
def proxy_gps():
    try:
        response = requests.get(f"{KART_API_BASE}/gps", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/mpc_status", methods=["GET"])
def proxy_mpc_status():
    try:
        response = requests.get(f"{KART_API_BASE}/mpc_status", timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/mpc/residual_mode", methods=["POST"])
def proxy_residual_mode():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/mpc/residual_mode", json=data, timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/pathfinder/planner", methods=["POST"])
def proxy_pathfinder_planner():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/pathfinder/planner", json=data, timeout=3)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/pathfinder/line_path", methods=["POST"])
def proxy_pathfinder_line_path():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/pathfinder/line_path", json=data, timeout=5)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500
