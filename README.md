# Autonomous_UI

Browser HUD for an autonomous racing kart. A small Flask app proxies the kart's
on-vehicle API and serves a live telemetry dashboard — map view, speed, pose,
e-comms, IMU calibration, manual control, and tests.

## Run

```bash
pip install -r requirements.txt
python -m src.app
```

Open http://localhost:8080. Override the port with `PORT=...`.

The kart API base is set in `src/routes/frontend.py` (`KART_API_BASE`).

## Stack

Flask · vanilla HTML/CSS/JS · Canvas 2D for the map. No build step.

## Layout

```
src/
  app.py              Flask entrypoint
  routes/
    frontend.py       serves the HUD + /api/* proxy to the kart
    driving.py        direct driving endpoints
  frontend/
    index.html        HUD layout
    scripts.js        polling, render, controls
    styles.css        design tokens + components
```
