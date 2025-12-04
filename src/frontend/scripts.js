const API_BASE = 'http://127.0.0.1:8080';
let manualMode = false;
let activeKeys = new Set();
let controlInterval = null;

function setStatus(message, isError = false) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = 'status ' + (isError ? 'error' : 'success');
}

async function runTest(testIndex) {
    const speed = parseFloat(document.getElementById(`speed${testIndex}`).value);
    const steering = testIndex === 1 ? 0 : parseFloat(document.getElementById(`steering${testIndex}`).value);

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
        setStatus(`Error: ${error.message}`, true);
    }
}

function toggleManualMode() {
    manualMode = !manualMode;
    const btn = document.getElementById('manualBtn');
    const statusDiv = document.getElementById('manualStatus');

    if (manualMode) {
        btn.textContent = 'Disable Manual Mode';
        btn.classList.add('active');
        statusDiv.textContent = 'Use arrow keys to control';
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
    } else {
        btn.textContent = 'Enable Manual Mode';
        btn.classList.remove('active');
        statusDiv.textContent = '';
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);
        activeKeys.clear();
        stopControlLoop();
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

function handleKeyUp(e) {
    if (!manualMode) return;

    const key = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        activeKeys.delete(key);
        if (activeKeys.size === 0) {
            stopControlLoop();
        }
    }
}

function startControlLoop() {
    controlInterval = setInterval(sendControlCommands, 20);
}

function stopControlLoop() {
    if (controlInterval) {
        clearInterval(controlInterval);
        controlInterval = null;
    }
}

async function sendControlCommands() {
    const endpoints = [];

    if (activeKeys.has('ArrowUp')) endpoints.push('/go_forward');
    if (activeKeys.has('ArrowDown')) endpoints.push('/go_backwards');
    if (activeKeys.has('ArrowLeft')) endpoints.push('/turn_left');
    if (activeKeys.has('ArrowRight')) endpoints.push('/turn_right');

    for (const endpoint of endpoints) {
        try {
            await fetch(`${API_BASE}${endpoint}`, { method: 'POST' });
        } catch (error) {
            console.error(`Error sending ${endpoint}:`, error);
        }
    }
}

async function getLogs() {
    try {
        const response = await fetch(`${API_BASE}/get_data`);

        if (response.ok) {
            const data = await response.text();
            setStatus('Logs retrieved successfully');
            console.log('Logs:', data);
        } else {
            const error = await response.text();
            setStatus(`Failed to get logs: ${error}`, true);
        }
    } catch (error) {
        setStatus(`Error getting logs: ${error.message}`, true);
    }
}