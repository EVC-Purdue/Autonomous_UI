import os
from pathlib import Path
import requests

from flask import Blueprint, send_from_directory, request, jsonify

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
        response = requests.get(f"{KART_API_BASE}/get_state", timeout=2)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/set_state", methods=["POST"])
def proxy_set_state():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/set_state", json=data, timeout=2)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/odom", methods=["GET"])
def proxy_odom():
    try:
        response = requests.get(f"{KART_API_BASE}/odom", timeout=2)
        return response.json(), response.status_code
    except Exception as e:
        return {"error": str(e)}, 500


@frontend.route("/api/manual_control", methods=["POST"])
def proxy_manual_control():
    try:
        data = request.get_json()
        response = requests.post(f"{KART_API_BASE}/manual_control", json=data, timeout=2)
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
