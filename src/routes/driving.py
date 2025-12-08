import json
import os

import requests
from flask import Blueprint, jsonify, request

driving = Blueprint(
    "driving",
    __name__,
)

URL = "http://10.186.19.128:8001/"


@driving.route("/get_data", methods=["GET"])
def get_data():
    res = requests.get(URL.replace('8001', '8000') + "logs")
    if res.status_code == 200:
        data = res.json()
        file_path = "data.jsonl"
        if not os.path.exists(file_path):
            open(file_path, 'x')
        with open(file_path, "a") as f:
            for record in data:
                f.write(json.dumps(record) + "\n")
    else:
        return jsonify({"error": res.text}, res.status_code)


@driving.route("/run_test", methods=["POST"])
def run_test():
    data = request.get_json()
    testIndex, steering, speed = data["test"], data["steering"], data["speed"]
    if testIndex not in {1, 2, 3}:
        return jsonify({"error": "Index should be 1, 2, or 3"}, 400)
    res = requests.post(
        URL + "run_test", json={"test": testIndex, "steering": steering, "speed": speed}
    )
    print(res)
    return jsonify({"success": 200})


@driving.route("/go_forward", methods=["POST"])
def go_forward():
    requests.get(URL + "go_forward")
    return jsonify({"success": 200})


@driving.route("/go_backwards", methods=["POST"])
def go_backwards():
    requests.get(URL + "go_backwards")
    return jsonify({"success": 200})


@driving.route("/turn_left", methods=["POST"])
def turn_left():
    requests.get(URL + "turn_left")
    return jsonify({"success": 200})


@driving.route("/turn_right", methods=["POST"])
def turn_right():
    requests.get(URL + "turn_right")
    return jsonify({"success": 200})
