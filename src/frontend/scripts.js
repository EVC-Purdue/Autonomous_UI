const API_BASE = '/api'; // Use proxy endpoints to avoid CORS
let manualMode = false;
let activeKeys = new Set();
let controlInterval = null;

// Control constants
const MAX_SPEED = 50.0;
const MAX_STEERING = 10.0;

// Telemetry polling
let telemetryInterval = null;
const TELEMETRY_RATE_MS = 100; // Poll at 10Hz
let isConnected = false;
let consecutiveErrors = 0;
const MAX_CONSOLE_ENTRIES = 50;

// Console logging
function logToConsole(message, type = 'info') {
    const console = document.getElementById('consoleLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    entry.innerHTML = `<span class="log-timestamp">[${timestamp}]</span> ${message}`;
    console.appendChild(entry);

    // Keep only last MAX_CONSOLE_ENTRIES
    while (console.children.length > MAX_CONSOLE_ENTRIES) {
        console.removeChild(console.firstChild);
    }

    // Auto-scroll to bottom
    console.scrollTop = console.scrollHeight;
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('connectionText');

    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Connected';
        consecutiveErrors = 0;
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Disconnected';
    }
}

function setStatus(message, isError = false) {
    logToConsole(message, isError ? 'error' : 'success');
}

async function runTest(testIndex) {
    const speed = parseFloat(document.getElementById(`speed${testIndex}`).value);
    const steering = testIndex === 1 ? 0 : parseFloat(document.getElementById(`steering${testIndex}`).value);

    logToConsole(`Starting Test ${testIndex} (speed: ${speed}, steering: ${steering})`, 'info');

    try {
        const response = await fetch(`${API_BASE}/run_test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test: testIndex, 'speed': speed, 'steering': steering })
        });

        if (response.ok) {
            setStatus(`Test ${testIndex} completed successfully`);
        } else {
            const error = await response.text();
            setStatus(`Test ${testIndex} failed: ${error}`, true);
        }
    } catch (error) {
        setStatus(`Test ${testIndex} error: ${error.message}`, true);
        updateConnectionStatus(false);
    }
}

async function toggleManualMode() {
    const btn = document.getElementById('manualBtn');
    const statusDiv = document.getElementById('manualStatus');

    if (!manualMode) {
        // Enable manual mode
        logToConsole('Enabling manual control...', 'info');
        try {
            const response = await fetch(`${API_BASE}/set_state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: 'MANUAL' })
            });

            if (!response.ok) {
                const error = await response.text();
                setStatus(`Manual mode enable failed: ${error}`, true);
                return;
            }

            manualMode = true;
            btn.textContent = 'Disable Manual Mode';
            btn.classList.add('active');
            statusDiv.textContent = 'Arrow keys: ↑↓ speed | ←→ steering';
            document.addEventListener('keydown', handleKeyDown);
            document.addEventListener('keyup', handleKeyUp);
            setStatus('Manual mode ACTIVE - use arrow keys');
        } catch (error) {
            setStatus(`Manual mode error: ${error.message}`, true);
            updateConnectionStatus(false);
        }
    } else {
        // Disable manual mode
        logToConsole('Disabling manual control...', 'info');
        try {
            // Stop the kart first
            await sendControlCommands(true);

            const response = await fetch(`${API_BASE}/set_state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: 'IDLE' })
            });

            if (!response.ok) {
                const error = await response.text();
                setStatus(`Manual mode disable failed: ${error}`, true);
                return;
            }

            manualMode = false;
            btn.textContent = 'Enable Manual Mode';
            btn.classList.remove('active');
            statusDiv.textContent = '';
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            activeKeys.clear();
            await stopControlLoop();
            setStatus('Manual mode disabled');
        } catch (error) {
            setStatus(`Manual mode error: ${error.message}`, true);
            updateConnectionStatus(false);
        }
    }
}

function handleKeyDown(e) {
    if (!manualMode) return;

    const key = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        if (!activeKeys.has(key)) {
            activeKeys.add(key);
            if (!controlInterval) {
                startControlLoop();
            }
        }
    }
}

async function handleKeyUp(e) {
    if (!manualMode) return;

    const key = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        activeKeys.delete(key);
        if (activeKeys.size === 0) {
            await stopControlLoop();
        }
    }
}

function startControlLoop() {
    controlInterval = setInterval(sendControlCommands, 20);
}

async function stopControlLoop() {
    if (controlInterval) {
        clearInterval(controlInterval);
        controlInterval = null;
        // Send stop command (speed:0, steering:0) to ramp down
        await sendControlCommands(true);
    }
}

let lastControlCommand = { speed: 0, steering: 0 };

async function sendControlCommands(forceStop = false) {
    // Calculate absolute target values based on currently pressed keys
    let speed = 0;
    let steering = 0;

    if (!forceStop) {
        // Speed: ArrowUp = forward, ArrowDown = reverse (or stop)
        if (activeKeys.has('ArrowUp')) {
            speed = MAX_SPEED;
        } else if (activeKeys.has('ArrowDown')) {
            speed = 0; // Set to negative value if reverse is supported
        }

        // Steering: ArrowLeft = negative, ArrowRight = positive
        if (activeKeys.has('ArrowLeft')) {
            steering = -MAX_STEERING;
        } else if (activeKeys.has('ArrowRight')) {
            steering = MAX_STEERING;
        }
    }

    // Log only when command changes significantly
    if (Math.abs(speed - lastControlCommand.speed) > 0.1 ||
        Math.abs(steering - lastControlCommand.steering) > 0.1) {
        logToConsole(`Control: speed=${speed}, steering=${steering}`, 'info');
        lastControlCommand = { speed, steering };
    }

    // Send absolute target values to /manual_control
    try {
        const response = await fetch(`${API_BASE}/manual_control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speed: speed, steering: steering })
        });

        if (!response.ok) {
            const error = await response.text();
            logToConsole(`Manual control failed: ${error}`, 'error');
        }
    } catch (error) {
        logToConsole(`Manual control error: ${error.message}`, 'error');
    }
}

async function getLogs() {
    logToConsole('Fetching telemetry logs...', 'info');
    try {
        const response = await fetch(`${API_BASE}/get_logs`);

        if (response.ok) {
            const data = await response.json();
            const logCount = Array.isArray(data) ? data.reduce((sum, batch) => sum + batch.count, 0) : 0;
            setStatus(`Downloaded ${logCount} log entries`);

            // Download as JSON file
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kart_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            const error = await response.text();
            setStatus(`Log fetch failed: ${error}`, true);
        }
    } catch (error) {
        setStatus(`Log fetch error: ${error.message}`, true);
    }
}

// State Management
async function setState(newState) {
    logToConsole(`Setting state to ${newState}...`, 'info');
    try {
        const response = await fetch(`${API_BASE}/set_state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: newState })
        });

        if (response.ok) {
            setStatus(`State → ${newState}`);
            updateTelemetry(); // Refresh immediately
        } else {
            const error = await response.text();
            setStatus(`State change failed: ${error}`, true);
        }
    } catch (error) {
        setStatus(`State change error: ${error.message}`, true);
        updateConnectionStatus(false);
    }
}

// Telemetry Polling
async function updateTelemetry() {
    try {
        // Fetch state and odom data in parallel
        const [stateRes, odomRes] = await Promise.all([
            fetch(`${API_BASE}/get_state`),
            fetch(`${API_BASE}/odom`)
        ]);

        if (stateRes.ok && odomRes.ok) {
            const stateData = await stateRes.json();
            const odomData = await odomRes.json();

            updateStateDisplay(stateData.state);
            updateOdomDisplay(odomData);

            // Connection successful
            if (!isConnected) {
                updateConnectionStatus(true);
                logToConsole('Connected to kart API', 'success');
            }
            consecutiveErrors = 0;
        } else {
            if (consecutiveErrors === 0) {
                const stateError = !stateRes.ok ? await stateRes.text() : '';
                const odomError = !odomRes.ok ? await odomRes.text() : '';
                logToConsole(`API error: ${stateError || odomError}`, 'error');
            }
            consecutiveErrors++;
            if (consecutiveErrors > 5) {
                updateConnectionStatus(false);
            }
        }
    } catch (error) {
        if (consecutiveErrors === 0) {
            logToConsole(`Connection failed: ${error.message}`, 'error');
        }
        consecutiveErrors++;
        if (consecutiveErrors > 5) {
            updateConnectionStatus(false);
        }
    }
}

function updateStateDisplay(state) {
    const stateBadge = document.getElementById('currentState');
    stateBadge.textContent = state;
    stateBadge.className = `state-badge ${state}`;

    // Highlight active state button
    document.querySelectorAll('.state-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = Array.from(document.querySelectorAll('.state-btn'))
        .find(btn => btn.textContent === state);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
}

function updateOdomDisplay(data) {
    // Position
    document.getElementById('posX').textContent = data.x.toFixed(2);
    document.getElementById('posY').textContent = data.y.toFixed(2);

    // Convert yaw from radians to degrees
    const yawDeg = (data.yaw * 180 / Math.PI).toFixed(1);
    document.getElementById('yaw').textContent = yawDeg;

    // Velocity
    document.getElementById('speed').textContent = data.speed.toFixed(2);
    document.getElementById('motor').textContent = data.motor.toFixed(1);
    document.getElementById('steer').textContent = data.steer.toFixed(2);
}

function startTelemetry() {
    if (!telemetryInterval) {
        updateTelemetry(); // Initial update
        telemetryInterval = setInterval(updateTelemetry, TELEMETRY_RATE_MS);
    }
}

function stopTelemetry() {
    if (telemetryInterval) {
        clearInterval(telemetryInterval);
        telemetryInterval = null;
    }
}

// Start telemetry polling when page loads
window.addEventListener('load', () => {
    logToConsole('Initializing kart control interface...', 'info');
    document.getElementById('apiUrl').textContent = API_BASE;
    startTelemetry();
    logToConsole('Telemetry polling started at 10Hz', 'success');
});