const API_BASE = '/api';

/* ---------------- Control state ---------------- */
let manualMode = false;
let activeKeys = new Set();
let controlInterval = null;

let MAX_SPEED = 50.0;
let MAX_STEERING = 10.0;

const TELEMETRY_RATE_MS = 100;   // /odom + /get_state at 10 Hz
const LINES_RATE_MS = 250;       // /lines at 4 Hz
const ECOMMS_RATE_MS = 200;      // /e_comms at 5 Hz
const IMU_RATE_MS = 500;         // /imu/status at 2 Hz, bumps to 4 Hz while CALIBRATING
const IMU_FAST_RATE_MS = 250;
let telemetryInterval = null;
let linesInterval = null;
let ecommsInterval = null;
let imuInterval = null;
let imuPollMs = IMU_RATE_MS;
let imuLastErrorShown = '';
let isConnected = false;
let consecutiveErrors = 0;
const MAX_CONSOLE_ENTRIES = 60;

/* ---------------- World state ---------------- */
const world = {
    staticPath: [],
    staticBBox: null,
    staticTotalLen: 0,
    staticCumLen: [],
    dynamicPath: [],
    dynamicLen: 0,
    odom: null,
};

const session = {
    samples: 0,
    peakSpeed: 0,
    speedSum: 0,
    cteSqSum: 0,
    cteSamples: 0,
    startTs: performance.now(),
    lastUpdateTs: performance.now(),
    rateEMA: 0,
};

// Client-side distance + trail from odom — the source of truth for the driven line.
// Also derives velocity/speed from the position stream so the UI works even when
// the backend doesn't populate twist fields (vy, speed have been seen as zero/missing).
const driven = {
    lastX: null,
    lastY: null,
    lastT: null,
    totalDist: 0,
    vxEMA: 0,
    vyEMA: 0,
    speedEMA: 0,
    trail: [],            // [[x,y], ...] — also referenced by world.dynamicPath
    maxTrailLen: 20000,   // ~33 min at 10 Hz
};

const view = {
    mode: 'fit',
    scale: 1,
    cx: 0, cy: 0,
    w: 0, h: 0,
    dpr: 1,
};

/* ---------------- Console log ---------------- */
function logToConsole(message, type = 'info') {
    const console_ = document.getElementById('consoleLog');
    if (!console_) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const ts = new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const stamp = document.createElement('span');
    stamp.className = 'log-timestamp';
    stamp.textContent = `[${ts}]`;
    entry.appendChild(stamp);
    entry.appendChild(document.createTextNode(' ' + String(message)));
    console_.appendChild(entry);
    while (console_.children.length > MAX_CONSOLE_ENTRIES) console_.removeChild(console_.firstChild);
    console_.scrollTop = console_.scrollHeight;
    const lc = document.getElementById('logCount');
    if (lc) lc.textContent = `${console_.children.length} events`;
}

function setStatus(msg, isError = false) { logToConsole(msg, isError ? 'error' : 'success'); }

function updateConnectionStatus(connected) {
    isConnected = connected;
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('connectionText');
    if (connected) { dot.classList.add('connected'); text.textContent = 'Connected'; consecutiveErrors = 0; }
    else { dot.classList.remove('connected'); text.textContent = 'Disconnected'; }
}

/* ---------------- Geometry helpers ---------------- */
function computeBBox(points) {
    if (!points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

function pathCumulative(points) {
    const cum = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i-1][0];
        const dy = points[i][1] - points[i-1][1];
        total += Math.hypot(dx, dy);
        cum.push(total);
    }
    return { cum, total };
}

function nearestCte(staticPts, x, y) {
    if (staticPts.length < 2) return 0;
    let minD2 = Infinity;
    for (let i = 0; i < staticPts.length - 1; i++) {
        const ax = staticPts[i][0], ay = staticPts[i][1];
        const bx = staticPts[i+1][0], by = staticPts[i+1][1];
        const dx = bx - ax, dy = by - ay;
        const seg2 = dx*dx + dy*dy;
        let t = seg2 ? ((x-ax)*dx + (y-ay)*dy) / seg2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = ax + t*dx, py = ay + t*dy;
        const d2 = (x-px)*(x-px) + (y-py)*(y-py);
        if (d2 < minD2) minD2 = d2;
    }
    return Math.sqrt(minD2);
}

// Accept [[x,y],...] or [{x,y,...},...] and return canonical [[x,y],...].
function normalizeXY(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
        if (Array.isArray(it) && it.length >= 2 && isFinite(it[0]) && isFinite(it[1])) {
            out.push([+it[0], +it[1]]);
        } else if (it && typeof it === 'object' && isFinite(it.x) && isFinite(it.y)) {
            out.push([+it.x, +it.y]);
        }
    }
    return out;
}

function trackDrivenDistance(x, y, tMs) {
    if (!isFinite(x) || !isFinite(y)) return;
    const t = isFinite(tMs) ? tMs : performance.now();
    if (driven.lastX === null) {
        driven.lastX = x; driven.lastY = y; driven.lastT = t;
        driven.trail.push([x, y]);
        return;
    }
    const dx = x - driven.lastX;
    const dy = y - driven.lastY;
    const d = Math.hypot(dx, dy);
    const dtSec = Math.max(0.001, (t - driven.lastT) / 1000);

    // Filter sub-cm sensor jitter and obvious teleports (>5 m between samples).
    if (d > 0.01 && d < 5) {
        driven.totalDist += d;
        driven.trail.push([x, y]);
        if (driven.trail.length > driven.maxTrailLen) {
            driven.trail.splice(0, driven.trail.length - driven.maxTrailLen);
        }
        const vxInst = dx / dtSec;
        const vyInst = dy / dtSec;
        const sInst  = d  / dtSec;
        // EMA — keep responsive without flickering. ~0.3 → ~3-sample horizon at 10 Hz.
        const a = 0.3;
        driven.vxEMA    = a * vxInst + (1 - a) * driven.vxEMA;
        driven.vyEMA    = a * vyInst + (1 - a) * driven.vyEMA;
        driven.speedEMA = a * sInst  + (1 - a) * driven.speedEMA;
    } else if (d <= 0.01) {
        // Vehicle is stationary — decay velocity estimates toward zero.
        driven.vxEMA    *= 0.7;
        driven.vyEMA    *= 0.7;
        driven.speedEMA *= 0.7;
    }
    driven.lastX = x; driven.lastY = y; driven.lastT = t;
}

/* ---------------- Canvas rendering ---------------- */
const canvas = () => document.getElementById('mapCanvas');
const ctx = () => canvas().getContext('2d');

function resizeCanvas() {
    const c = canvas(); if (!c) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    view.w = w; view.h = h; view.dpr = dpr;
    ctx().setTransform(dpr, 0, 0, dpr, 0, 0);
    fitView();
}

function fitView() {
    const bbox = world.staticBBox;
    if (!bbox || !view.w) return;
    const pad = 0.08;
    const bw = Math.max(1e-3, bbox.maxX - bbox.minX);
    const bh = Math.max(1e-3, bbox.maxY - bbox.minY);
    const sx = (view.w * (1 - pad*2)) / bw;
    const sy = (view.h * (1 - pad*2)) / bh;
    view.scale = Math.min(sx, sy);
    view.cx = (bbox.minX + bbox.maxX) / 2;
    view.cy = (bbox.minY + bbox.maxY) / 2;
}

function followView() {
    if (!world.odom || !view.scale) return;
    view.cx = world.odom.x;
    view.cy = world.odom.y;
}

function w2s(x, y) {
    return [
        view.w / 2 + (x - view.cx) * view.scale,
        view.h / 2 - (y - view.cy) * view.scale,
    ];
}

function niceStep(target) {
    if (target <= 0 || !isFinite(target)) return 1;
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    const m = target / base;
    let nice;
    if (m < 1.5) nice = 1;
    else if (m < 3) nice = 2;
    else if (m < 7) nice = 5;
    else nice = 10;
    return nice * base;
}

function drawGrid(g) {
    const step = niceStep(60 / view.scale);
    if (!step || !isFinite(step)) return;
    const halfW = view.w / 2, halfH = view.h / 2;
    const xMin = view.cx - halfW / view.scale;
    const xMax = view.cx + halfW / view.scale;
    const yMin = view.cy - halfH / view.scale;
    const yMax = view.cy + halfH / view.scale;
    g.strokeStyle = 'rgba(255,255,255,0.025)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = Math.ceil(xMin/step)*step; x <= xMax; x += step) {
        const [sx] = w2s(x, 0);
        g.moveTo(sx, 0); g.lineTo(sx, view.h);
    }
    for (let y = Math.ceil(yMin/step)*step; y <= yMax; y += step) {
        const [, sy] = w2s(0, y);
        g.moveTo(0, sy); g.lineTo(view.w, sy);
    }
    g.stroke();

    const [ox, oy] = w2s(0, 0);
    g.strokeStyle = 'rgba(245,185,66,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ox - 8, oy); g.lineTo(ox + 8, oy);
    g.moveTo(ox, oy - 8); g.lineTo(ox, oy + 8);
    g.stroke();
}

function drawStatic(g) {
    const pts = world.staticPath;
    if (pts.length < 2) return;
    g.save();
    g.lineWidth = 1.5;
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(69, 216, 195, 0.8)';
    g.shadowColor = 'rgba(69, 216, 195, 0.45)';
    g.shadowBlur = 10;
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
        const [sx, sy] = w2s(pts[i][0], pts[i][1]);
        if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy);
    }
    g.stroke();
    g.restore();

    const [sx0, sy0] = w2s(pts[0][0], pts[0][1]);
    g.fillStyle = 'rgba(69, 216, 195, 0.9)';
    g.beginPath(); g.arc(sx0, sy0, 4, 0, Math.PI*2); g.fill();
}

function drawDynamic(g, layer) {
    const pts = world.dynamicPath;
    if (pts.length < 2) return;

    const lapLen = world.staticTotalLen > 0 ? world.staticTotalLen : Infinity;

    // distance-from-end for each point (arc length back to current vehicle pos)
    const dfe = new Array(pts.length);
    dfe[pts.length - 1] = 0;
    for (let i = pts.length - 2; i >= 0; i--) {
        const dx = pts[i+1][0] - pts[i][0];
        const dy = pts[i+1][1] - pts[i][1];
        dfe[i] = dfe[i+1] + Math.hypot(dx, dy);
    }

    const TIERS = 6;
    const maxOldAge = lapLen * 3;
    const buckets = Array.from({ length: TIERS }, () => []);

    for (let i = 0; i < pts.length - 1; i++) {
        const age = dfe[i];
        const isOld = age > lapLen;
        if (layer === 'old' && !isOld) continue;
        if (layer === 'current' && isOld) continue;

        let fade;
        if (layer === 'current') {
            fade = Math.min(1, age / Math.max(1, lapLen));
        } else {
            fade = Math.min(1, (age - lapLen) / Math.max(1, maxOldAge - lapLen));
        }
        const tier = Math.min(TIERS - 1, Math.floor(fade * TIERS));
        buckets[tier].push(i);
    }

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // draw older tiers first within each layer so newer overlays older
    for (let t = TIERS - 1; t >= 0; t--) {
        const segs = buckets[t];
        if (!segs.length) continue;
        const fade = (t + 0.5) / TIERS;

        let color, lineWidth, blur, shadowColor;
        if (layer === 'current') {
            // amber → slightly cooler / dimmer toward 1-lap-old boundary
            const r = 255 - 12 * fade;
            const gc = 200 - 50 * fade;
            const b = 70 + 30 * fade;
            const a = 0.95 - 0.28 * fade;
            color = `rgba(${r|0}, ${gc|0}, ${b|0}, ${a.toFixed(3)})`;
            lineWidth = 2.6 - 0.4 * fade;
            blur = 12 * (1 - fade * 0.6);
            shadowColor = `rgba(245, 185, 66, ${(0.55 * (1 - fade)).toFixed(3)})`;
        } else {
            // older laps — drawn under static, desaturated, no glow
            const r = 170 - 70 * fade;
            const gc = 120 - 70 * fade;
            const b = 95 - 25 * fade;
            const a = Math.max(0.12, 0.5 - 0.34 * fade);
            color = `rgba(${Math.max(40, r|0)}, ${Math.max(45, gc|0)}, ${Math.max(55, b|0)}, ${a.toFixed(3)})`;
            lineWidth = 1.5 - 0.3 * fade;
            blur = 0;
            shadowColor = 'transparent';
        }

        g.strokeStyle = color;
        g.lineWidth = lineWidth;
        g.shadowBlur = blur;
        g.shadowColor = shadowColor;

        g.beginPath();
        for (const i of segs) {
            const [sx0, sy0] = w2s(pts[i][0], pts[i][1]);
            const [sx1, sy1] = w2s(pts[i+1][0], pts[i+1][1]);
            g.moveTo(sx0, sy0);
            g.lineTo(sx1, sy1);
        }
        g.stroke();
    }
    g.restore();
}

// 2σ ellipse from the xy block of pose_cov (row-major 6x6: var(x)=0, cov(xy)=1, var(y)=7).
function drawPoseCovariance(g) {
    const o = world.odom;
    if (!o || !Array.isArray(o.pose_cov) || o.pose_cov.length < 8) return;
    const a = +o.pose_cov[0];
    const b = +o.pose_cov[1];
    const c = +o.pose_cov[7];
    if (!isFinite(a) || !isFinite(b) || !isFinite(c)) return;
    if (a <= 0 && c <= 0) return;

    // Eigenvalues of [[a,b],[b,c]].
    const tr = a + c;
    const det = a * c - b * b;
    const disc = Math.max(0, (tr * tr) / 4 - det);
    const root = Math.sqrt(disc);
    const l1 = tr / 2 + root;   // larger
    const l2 = tr / 2 - root;   // smaller
    if (l1 <= 0) return;

    // Major-axis angle in world frame. Eigenvector for l1: (b, l1 - a).
    let angle;
    if (Math.abs(b) > 1e-12) angle = Math.atan2(l1 - a, b);
    else angle = a >= c ? 0 : Math.PI / 2;

    const K = 2.0; // 2σ — covers ~86% of position mass for a 2D Gaussian
    const rxWorld = K * Math.sqrt(Math.max(0, l1));
    const ryWorld = K * Math.sqrt(Math.max(0, Math.max(l2, 0)));
    const rxPx = rxWorld * view.scale;
    const ryPx = ryWorld * view.scale;

    // Hide when the ellipse would sit inside the vehicle dot.
    const DOT_R = 5;
    if (Math.max(rxPx, ryPx) < DOT_R + 1.5) return;

    const [sx, sy] = w2s(o.x, o.y);
    g.save();
    g.translate(sx, sy);
    // Canvas y is flipped relative to world y, so negate the world angle.
    g.rotate(-angle);
    g.beginPath();
    g.ellipse(0, 0, Math.max(2, rxPx), Math.max(1, ryPx), 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.05)';
    g.fill();
    g.setLineDash([5, 4]);
    g.lineWidth = 1.25;
    g.shadowColor = 'rgba(255, 255, 255, 0.35)';
    g.shadowBlur = 6;
    g.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    g.stroke();
    g.restore();
}

function drawVehicle(g) {
    const o = world.odom;
    if (!o) return;
    const [sx, sy] = w2s(o.x, o.y);
    const yaw = o.yaw || 0;

    const t = (performance.now() % 1600) / 1600;
    const haloR = 14 + 8 * t;
    const haloA = 0.35 * (1 - t);
    g.beginPath();
    g.arc(sx, sy, haloR, 0, Math.PI*2);
    g.fillStyle = `rgba(255, 111, 60, ${haloA.toFixed(3)})`;
    g.fill();

    const len = 22;
    const hx = sx + Math.cos(yaw) * len;
    const hy = sy - Math.sin(yaw) * len;
    g.strokeStyle = 'rgba(255, 111, 60, 0.95)';
    g.lineWidth = 2;
    g.shadowColor = 'rgba(255, 111, 60, 0.6)';
    g.shadowBlur = 10;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(hx, hy); g.stroke();
    g.shadowBlur = 0;

    const ang = Math.atan2(-Math.sin(yaw), Math.cos(yaw));
    g.fillStyle = 'rgba(255, 111, 60, 1)';
    g.beginPath();
    g.moveTo(hx, hy);
    g.lineTo(hx - 6 * Math.cos(ang - 0.4), hy - 6 * Math.sin(ang - 0.4));
    g.lineTo(hx - 6 * Math.cos(ang + 0.4), hy - 6 * Math.sin(ang + 0.4));
    g.closePath(); g.fill();

    g.fillStyle = '#ff6f3c';
    g.shadowColor = 'rgba(255, 111, 60, 0.9)';
    g.shadowBlur = 14;
    g.beginPath(); g.arc(sx, sy, 5, 0, Math.PI*2); g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(sx, sy, 5, 0, Math.PI*2); g.stroke();
}

function drawCteIndicator(g) {
    const o = world.odom;
    if (!o || world.staticPath.length < 2) return;
    let bestPx = 0, bestPy = 0, minD2 = Infinity;
    for (let i = 0; i < world.staticPath.length - 1; i++) {
        const ax = world.staticPath[i][0], ay = world.staticPath[i][1];
        const bx = world.staticPath[i+1][0], by = world.staticPath[i+1][1];
        const dx = bx - ax, dy = by - ay;
        const seg2 = dx*dx + dy*dy;
        let t = seg2 ? ((o.x-ax)*dx + (o.y-ay)*dy) / seg2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = ax + t*dx, py = ay + t*dy;
        const d2 = (o.x-px)*(o.x-px) + (o.y-py)*(o.y-py);
        if (d2 < minD2) { minD2 = d2; bestPx = px; bestPy = py; }
    }
    const [sx, sy] = w2s(o.x, o.y);
    const [tx, ty] = w2s(bestPx, bestPy);
    g.save();
    g.setLineDash([3, 3]);
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(tx, ty); g.stroke();
    g.restore();
}

function drawScaleBar() {
    const lbl = document.getElementById('scaleLabel');
    if (!lbl || !view.scale) return;
    const meters = niceStep(80 / view.scale);
    lbl.textContent = `${formatNum(meters)} m`;
}

function render() {
    const c = canvas(); if (!c) return;
    const g = ctx();
    if (view.mode === 'follow') followView();
    g.clearRect(0, 0, view.w, view.h);
    drawGrid(g);
    drawDynamic(g, 'old');     // older laps fade in beneath static
    drawStatic(g);
    drawDynamic(g, 'current'); // current lap glows over static
    drawCteIndicator(g);
    drawPoseCovariance(g);
    drawVehicle(g);
    drawScaleBar();
    requestAnimationFrame(render);
}

/* ---------------- Data fetching ---------------- */
function adoptStatic(rawStatic) {
    const pts = normalizeXY(rawStatic);
    if (!pts.length) return false;
    world.staticPath = pts;
    world.staticBBox = computeBBox(pts);
    const cum = pathCumulative(pts);
    world.staticCumLen = cum.cum;
    world.staticTotalLen = cum.total;
    const tl = document.getElementById('totalLen');
    if (tl) tl.textContent = formatNum(cum.total);
    fitView();
    return true;
}

async function fetchMap() {
    try {
        const r = await fetch(`${API_BASE}/lines`);
        if (!r.ok) return;
        const data = await r.json();
        if (adoptStatic(data.static)) {
            logToConsole(`Loaded racing line · ${world.staticPath.length} pts · ${formatNum(world.staticTotalLen)} m`, 'success');
        }
        applyDynamic(data.dynamic);
    } catch (e) {
        logToConsole(`Map load failed: ${e.message}`, 'error');
    }
}

async function fetchLines() {
    try {
        const r = await fetch(`${API_BASE}/lines`);
        if (!r.ok) return;
        const data = await r.json();
        if (!world.staticPath.length) adoptStatic(data.static);
        applyDynamic(data.dynamic);
    } catch (e) { /* silent in poll */ }
}

function applyDynamic(_rawPts) {
    // The driven line is rendered from the odom-derived trail (driven.trail),
    // which world.dynamicPath aliases. /lines.dynamic is ignored — its shape
    // varies and odom is already the live ground truth.
}

function setEcommsStale(stale, statusText, statusClass) {
    const panel = document.getElementById('ecommsPanel');
    if (panel) panel.classList.toggle('stale', !!stale);
    const statusEl = document.getElementById('ecommsStatus');
    if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.className = `ecomms-status ${statusClass}`;
    }
}

async function updateEcomms() {
    try {
        const r = await fetch(`${API_BASE}/e_comms`);
        if (!r.ok) {
            setEcommsStale(true, `err ${r.status}`, 'err');
            return;
        }
        const d = await r.json();
        if (d && d.error) {
            setEcommsStale(true, 'no data', 'err');
            return;
        }
        const adcb = (d.adcb_state ?? '').toString();
        const rc = !!d.rc_mode;
        const thr = Number(d.throttle_pwm ?? 0);
        const ste = Number(d.steering_pwm ?? 0);

        setText('ecommsAdcb', adcb || '—');
        const rcEl = document.getElementById('ecommsRc');
        if (rcEl) {
            rcEl.textContent = rc ? 'ON' : 'OFF';
            rcEl.className = `ecomms-val ${rc ? 'bool-on' : 'bool-off'}`;
        }
        setText('ecommsThrottle', String(thr));
        setText('ecommsSteering', String(ste));

        // No callbacks have fired if everything is at default values.
        const hasData = adcb !== '' || rc || thr !== 0 || ste !== 0;
        if (hasData) setEcommsStale(false, 'live', 'live');
        else setEcommsStale(true, 'no data', 'err');
    } catch (e) {
        setEcommsStale(true, 'offline', 'err');
    }
}

function applyImuStatus(d) {
    const panel = document.getElementById('imuPanel');
    const stateEl = document.getElementById('imuState');
    const btn = document.getElementById('imuCalibrateBtn');
    if (!panel || !stateEl) return;

    const rawState = (d && typeof d.state === 'string') ? d.state : 'unknown';
    const state = ['WAITING', 'CALIBRATING', 'CALIBRATED'].includes(rawState) ? rawState : 'unknown';
    stateEl.textContent = state;
    stateEl.className = `imu-state ${state}`;
    panel.classList.remove('calibrating', 'calibrated', 'unknown');
    if (state === 'CALIBRATING') panel.classList.add('calibrating');
    else if (state === 'CALIBRATED') panel.classList.add('calibrated');
    else if (state === 'unknown') panel.classList.add('unknown');

    const samples = Number(d?.samples ?? 0);
    const target = Number(d?.target_samples ?? 0);
    setText('imuSamples', String(samples | 0));
    setText('imuTargetSamples', String(target | 0));
    const fill = document.getElementById('imuProgressFill');
    if (fill) {
        const pct = target > 0 ? Math.max(0, Math.min(100, (samples / target) * 100)) : 0;
        fill.style.width = `${pct.toFixed(1)}%`;
    }

    const bias = Array.isArray(d?.gyro_bias) ? d.gyro_bias : [];
    const fmtBias = v => isFinite(v) ? Number(v).toExponential(2) : '—';
    setText('imuGyroX', fmtBias(bias[0]));
    setText('imuGyroY', fmtBias(bias[1]));
    setText('imuGyroZ', fmtBias(bias[2]));

    const errEl = document.getElementById('imuError');
    const lastError = (d?.last_error ?? '').toString();
    if (errEl) {
        if (lastError) {
            errEl.textContent = lastError;
            errEl.hidden = false;
        } else {
            errEl.textContent = '';
            errEl.hidden = true;
        }
    }
    if (lastError && lastError !== imuLastErrorShown && lastError !== 'triggered') {
        logToConsole(`IMU · ${lastError}`, 'error');
    }
    imuLastErrorShown = lastError;

    // Button reflects whether a calibration is currently running.
    if (btn) {
        if (state === 'CALIBRATING') {
            btn.textContent = `Calibrating · ${samples}/${target || '?'}`;
            btn.classList.add('busy');
            btn.disabled = true;
        } else {
            btn.textContent = state === 'CALIBRATED' ? 'Recalibrate' : 'Calibrate';
            btn.classList.remove('busy');
            btn.disabled = false;
        }
    }

    // Poll faster while calibration is in progress so the bar feels live.
    const desired = state === 'CALIBRATING' ? IMU_FAST_RATE_MS : IMU_RATE_MS;
    if (desired !== imuPollMs && imuInterval) {
        clearInterval(imuInterval);
        imuPollMs = desired;
        imuInterval = setInterval(updateImuStatus, imuPollMs);
    }
}

async function updateImuStatus() {
    try {
        const r = await fetch(`${API_BASE}/imu/status`);
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.error) return;
        applyImuStatus(d);
    } catch (_) { /* silent in poll */ }
}

async function triggerImuCalibration() {
    const btn = document.getElementById('imuCalibrateBtn');
    if (btn?.disabled) return;
    logToConsole('IMU calibration · triggered', 'info');
    if (btn) { btn.disabled = true; btn.textContent = 'Triggering…'; }
    try {
        const r = await fetch(`${API_BASE}/imu/calibrate`, { method: 'POST' });
        if (!r.ok) {
            const txt = await r.text();
            setStatus(`IMU calibrate failed: ${txt}`, true);
            if (btn) { btn.disabled = false; btn.textContent = 'Calibrate'; }
            return;
        }
        // Pull fresh status immediately so the UI reflects the new state.
        updateImuStatus();
    } catch (e) {
        setStatus(`IMU calibrate error: ${e.message}`, true);
        if (btn) { btn.disabled = false; btn.textContent = 'Calibrate'; }
    }
}

async function updateTelemetry() {
    try {
        const [stateRes, odomRes] = await Promise.all([
            fetch(`${API_BASE}/get_state`),
            fetch(`${API_BASE}/odom`),
        ]);
        if (stateRes.ok && odomRes.ok) {
            const stateData = await stateRes.json();
            const odomData = await odomRes.json();
            updateStateDisplay(stateData.state);
            applyOdom(odomData);
            if (!isConnected) { updateConnectionStatus(true); logToConsole('Connected to kart API', 'success'); }
            consecutiveErrors = 0;
        } else {
            consecutiveErrors++;
            if (consecutiveErrors > 5) updateConnectionStatus(false);
        }
    } catch (e) {
        consecutiveErrors++;
        if (consecutiveErrors > 5) updateConnectionStatus(false);
    }
}

function applyOdom(o) {
    world.odom = o;

    session.samples++;
    const now = performance.now();
    const dt = Math.max(1, now - session.lastUpdateTs);
    const instRate = 1000 / dt;
    session.rateEMA = session.rateEMA ? (0.85 * session.rateEMA + 0.15 * instRate) : instRate;
    session.lastUpdateTs = now;

    // distance + ground-truth derivatives — integrate from odom positions, since the
    // backend's twist fields (speed, vy) are sometimes missing or stuck at zero.
    trackDrivenDistance(o.x ?? NaN, o.y ?? NaN, now);
    const distance = driven.totalDist;

    // Velocity: prefer backend-supplied value when it looks real (finite, non-zero);
    // otherwise fall back to the position-derived EMA. This keeps the panel useful
    // even if the kart only publishes vx, or publishes nothing.
    const vxBack = Number(o.vx);
    const vyBack = Number(o.vy);
    const vzBack = Number(o.vz);
    const vx = (isFinite(vxBack) && vxBack !== 0) ? vxBack : driven.vxEMA;
    const vy = (isFinite(vyBack) && vyBack !== 0) ? vyBack : driven.vyEMA;
    const vz = isFinite(vzBack) ? vzBack : 0;

    // Speed: prefer backend speed → magnitude of backend twist → derived ground speed.
    const sBack = Number(o.speed);
    let speed;
    if (isFinite(sBack) && sBack !== 0) speed = Math.abs(sBack);
    else if (isFinite(vxBack) && isFinite(vyBack) && (vxBack !== 0 || vyBack !== 0))
        speed = Math.hypot(vxBack, vyBack);
    else speed = driven.speedEMA;

    if (speed > session.peakSpeed) session.peakSpeed = speed;
    session.speedSum += speed;
    const avg = session.speedSum / session.samples;
    setText('distance', formatNum(distance));

    let cte = 0, progress = 0, lap = 1;
    if (world.staticPath.length > 1) {
        cte = nearestCte(world.staticPath, o.x ?? 0, o.y ?? 0);
        session.cteSqSum += cte*cte;
        session.cteSamples++;
        if (world.staticTotalLen > 0) {
            progress = (distance % world.staticTotalLen) / world.staticTotalLen;
            lap = Math.floor(distance / world.staticTotalLen) + 1;
        }
    }
    const cteRms = session.cteSamples ? Math.sqrt(session.cteSqSum / session.cteSamples) : 0;
    setText('lapCount', String(lap));

    setText('speed', speed.toFixed(2));
    setText('speedMph', (speed * 2.2369362921).toFixed(1));
    setText('peakSpeed', session.peakSpeed.toFixed(2));
    setText('avgSpeed', avg.toFixed(2));
    setText('samples', String(session.samples));
    setText('rate', session.rateEMA.toFixed(0));
    setText('uptime', formatUptime((now - session.startTs) / 1000));

    const fill = document.getElementById('speedFill');
    if (fill) {
        const peakRef = Math.max(1, session.peakSpeed);
        fill.style.width = `${Math.min(100, (speed / peakRef) * 100)}%`;
    }

    setText('yaw', ((o.yaw || 0) * 180 / Math.PI).toFixed(0));
    setText('wz', (o.wz || 0).toFixed(2));

    setText('posX', (o.x ?? 0).toFixed(2));
    setText('posY', (o.y ?? 0).toFixed(2));
    setText('posZ', (o.z ?? 0).toFixed(2));
    setText('vx', vx.toFixed(2));
    setText('vy', vy.toFixed(2));
    setText('vz', vz.toFixed(2));

    setText('cte', cte.toFixed(2));
    setText('cteRms', cteRms.toFixed(2));
    setText('progress', (progress * 100).toFixed(0));

    const ring = document.getElementById('progressRing');
    if (ring) ring.style.width = `${(progress * 100).toFixed(1)}%`;

    setText('coordX', (o.x ?? 0).toFixed(2));
    setText('coordY', (o.y ?? 0).toFixed(2));
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

function formatNum(n) {
    if (!isFinite(n)) return '0';
    if (n >= 1000) return n.toFixed(0);
    if (n >= 100) return n.toFixed(1);
    return n.toFixed(2);
}

function formatUptime(s) {
    s = Math.floor(s);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), ss = s % 60;
    if (m < 60) return `${m}m ${ss}s`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h}h ${mm}m`;
}

function updateStateDisplay(state) {
    const pill = document.getElementById('currentState');
    if (pill) {
        pill.textContent = state;
        pill.className = `state-pill ${state}`;
    }
    document.querySelectorAll('.pill[data-state]').forEach(b => {
        b.classList.toggle('active', b.dataset.state === state);
    });
    if (state === 'MANUAL') engageManualLocal();
    else disengageManualLocal();
}

/* ---------------- Controls ---------------- */
function updateMaxValues() {
    const speedInput = document.getElementById('maxSpeed');
    const steeringInput = document.getElementById('maxSteering');
    if (speedInput) MAX_SPEED = parseFloat(speedInput.value) || 50.0;
    if (steeringInput) MAX_STEERING = parseFloat(steeringInput.value) || 10.0;
    logToConsole(`Limits · max speed ${MAX_SPEED} · max steer ${MAX_STEERING}`, 'info');
}

async function setState(newState) {
    logToConsole(`State → ${newState}`, 'info');
    try {
        const r = await fetch(`${API_BASE}/set_state`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: newState }),
        });
        if (r.ok) updateTelemetry();
        else setStatus(`State change failed: ${await r.text()}`, true);
    } catch (e) { setStatus(`State change error: ${e.message}`, true); updateConnectionStatus(false); }
}

async function runTest(idx) {
    const speed = parseFloat(document.getElementById(`speed${idx}`).value);
    const steering = idx === 1 ? 0 : parseFloat(document.getElementById(`steering${idx}`).value);
    logToConsole(`Test ${idx} · speed ${speed} · steer ${steering}`, 'info');
    try {
        const r = await fetch(`${API_BASE}/run_test`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test: idx, speed, steering }),
        });
        if (r.ok) setStatus(`Test ${idx} dispatched`);
        else setStatus(`Test ${idx} failed: ${await r.text()}`, true);
    } catch (e) { setStatus(`Test ${idx} error: ${e.message}`, true); updateConnectionStatus(false); }
}

function engageManualLocal() {
    if (manualMode) return;
    manualMode = true;
    const btn = document.getElementById('manualBtn');
    const status = document.getElementById('manualStatus');
    if (btn) { btn.textContent = 'Disable manual control'; btn.classList.add('active'); }
    if (status) status.textContent = `armed · ↑↓ ±${MAX_SPEED} · ←→ ±${MAX_STEERING}`;
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    setStatus('Manual mode armed');
}

function disengageManualLocal() {
    if (!manualMode) return;
    manualMode = false;
    const btn = document.getElementById('manualBtn');
    const status = document.getElementById('manualStatus');
    if (btn) { btn.textContent = 'Enable manual control'; btn.classList.remove('active'); }
    if (status) status.textContent = 'disabled';
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    activeKeys.clear();
    stopControlLoop();
    setStatus('Manual mode disabled');
}

async function toggleManualMode() {
    if (!manualMode) {
        await setState('MANUAL');  // engage happens via state-change observer
    } else {
        try { await sendControlCommands(true); } catch (_) {}
        await setState('IDLE');    // disengage via observer
    }
}

function handleKeyDown(e) {
    if (!manualMode) return;
    const k = e.key;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) {
        e.preventDefault();
        if (!activeKeys.has(k)) {
            activeKeys.add(k);
            if (!controlInterval) startControlLoop();
        }
    }
}
async function handleKeyUp(e) {
    if (!manualMode) return;
    const k = e.key;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) {
        e.preventDefault();
        activeKeys.delete(k);
        if (activeKeys.size === 0) await stopControlLoop();
    }
}
function startControlLoop() { controlInterval = setInterval(sendControlCommands, 20); }
async function stopControlLoop() {
    if (controlInterval) {
        clearInterval(controlInterval); controlInterval = null;
        await sendControlCommands(true);
    }
}

let lastControlCommand = { speed: 0, steering: 0 };
async function sendControlCommands(forceStop = false) {
    let speed = 0, steering = 0;
    if (!forceStop) {
        if (activeKeys.has('ArrowUp')) speed = MAX_SPEED;
        else if (activeKeys.has('ArrowDown')) speed = 0;
        if (activeKeys.has('ArrowLeft')) steering = -MAX_STEERING;
        else if (activeKeys.has('ArrowRight')) steering = MAX_STEERING;
    }
    if (Math.abs(speed - lastControlCommand.speed) > 0.1 ||
        Math.abs(steering - lastControlCommand.steering) > 0.1) {
        logToConsole(`Control · speed ${speed} · steer ${steering}`, 'info');
        lastControlCommand = { speed, steering };
    }
    try {
        await fetch(`${API_BASE}/manual_control`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speed, steering }),
        });
    } catch (e) { logToConsole(`Manual control error: ${e.message}`, 'error'); }
}

async function getLogs() {
    logToConsole('Fetching telemetry logs…', 'info');
    try {
        const r = await fetch(`${API_BASE}/get_logs`);
        if (!r.ok) { setStatus(`Log fetch failed: ${await r.text()}`, true); return; }
        const data = await r.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `kart_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus('Telemetry downloaded');
    } catch (e) { setStatus(`Log fetch error: ${e.message}`, true); }
}

/* ---------------- Map mode toggle ---------------- */
function setMapMode(mode) {
    view.mode = mode;
    document.getElementById('recenterBtn').classList.toggle('active', mode === 'fit');
    document.getElementById('trackBtn').classList.toggle('active', mode === 'follow');
    if (mode === 'fit') fitView();
}

/* ---------------- Lifecycle ---------------- */
function startTelemetry() {
    if (!telemetryInterval) {
        updateTelemetry();
        telemetryInterval = setInterval(updateTelemetry, TELEMETRY_RATE_MS);
    }
    if (!linesInterval) {
        linesInterval = setInterval(fetchLines, LINES_RATE_MS);
    }
    if (!ecommsInterval) {
        updateEcomms();
        ecommsInterval = setInterval(updateEcomms, ECOMMS_RATE_MS);
    }
    if (!imuInterval) {
        updateImuStatus();
        imuInterval = setInterval(updateImuStatus, imuPollMs);
    }
}

window.addEventListener('load', () => {
    logToConsole('Booting telemetry HUD…', 'info');
    document.getElementById('apiUrl').textContent = API_BASE === '/api' ? 'Proxy mode · /api' : API_BASE;
    updateMaxValues();
    resizeCanvas();
    world.dynamicPath = driven.trail;   // live alias — render reads this
    fetchMap();
    startTelemetry();
    requestAnimationFrame(render);

    document.getElementById('recenterBtn').addEventListener('click', () => setMapMode('fit'));
    document.getElementById('trackBtn').addEventListener('click', () => setMapMode('follow'));
    setMapMode('fit');

    logToConsole('Telemetry · 10 Hz · lines · 4 Hz', 'success');
});

window.addEventListener('resize', () => { resizeCanvas(); });
