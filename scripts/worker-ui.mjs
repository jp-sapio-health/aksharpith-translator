#!/usr/bin/env node
/**
 * Worker Monitor UI — terminal-style web dashboard for the local worker.
 * Opens in browser, streams worker logs in real-time.
 *
 * Usage: node scripts/worker-ui.mjs
 *        npm run worker:ui
 */

import { createServer } from 'node:http';
import { readFileSync, watchFile, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOG_STDOUT = resolve(ROOT, 'logs/worker-stdout.log');
const LOG_STDERR = resolve(ROOT, 'logs/worker-stderr.log');
const PORT = 3847;

function getWorkerStatus() {
  try {
    const result = execSync('launchctl list com.aksharpith.local-worker 2>&1', { encoding: 'utf-8' });
    const pidMatch = result.match(/"PID"\s*=\s*(\d+)/);
    return pidMatch ? { running: true, pid: pidMatch[1] } : { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

function tailFile(path, lines = 200) {
  try {
    const content = readFileSync(path, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Aksharpith Worker</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #c9d1d9; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 13px; }
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    .header h1 { font-size: 14px; font-weight: 600; color: #e6edf3; letter-spacing: 0.5px; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.on { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
    .dot.off { background: #f85149; }
    .tabs { display: flex; background: #161b22; border-bottom: 1px solid #30363d; }
    .tab { padding: 8px 20px; font-size: 12px; font-weight: 500; color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent; font-family: inherit; background: none; border-top: none; border-left: none; border-right: none; }
    .tab.active { color: #e6edf3; border-bottom-color: #f0883e; }
    .terminal { padding: 16px 20px; min-height: calc(100vh - 90px); white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
    .line { padding: 1px 0; }
    .line:hover { background: rgba(255,255,255,0.03); }
    .timestamp { color: #484f58; }
    .worker { color: #79c0ff; }
    .chunk { color: #d2a8ff; }
    .done { color: #3fb950; }
    .error { color: #f85149; }
    .score { color: #f0883e; }
    .info { color: #8b949e; }
    .bottom-pad { height: 40px; }
    .controls { display: flex; gap: 8px; }
    .btn { padding: 4px 12px; font-size: 11px; font-family: inherit; border-radius: 4px; cursor: pointer; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; }
    .btn:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="header">
    <h1>AKSHARPITH WORKER</h1>
    <div class="status">
      <div class="controls">
        <button class="btn" onclick="toggleScroll()">Auto-scroll: <span id="scroll-status">ON</span></button>
        <button class="btn" onclick="clearTerminal()">Clear</button>
      </div>
      <span id="status-text">checking...</span>
      <div class="dot" id="status-dot"></div>
    </div>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('stdout', this)">Output</button>
    <button class="tab" onclick="switchTab('stderr', this)">Errors</button>
  </div>
  <div class="terminal" id="terminal"></div>
  <div class="bottom-pad"></div>

  <script>
    let autoScroll = true;
    let currentTab = 'stdout';
    let lastContent = '';

    function toggleScroll() {
      autoScroll = !autoScroll;
      document.getElementById('scroll-status').textContent = autoScroll ? 'ON' : 'OFF';
    }

    function clearTerminal() {
      document.getElementById('terminal').innerHTML = '';
      lastContent = '';
    }

    function switchTab(tab, el) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      lastContent = '';
      clearTerminal();
      fetchLogs();
    }

    function colorize(line) {
      let s = line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/(\\[worker\\])/g, '<span class="worker">$1</span>')
        .replace(/(\\[chunk \\d+\\/\\d+\\])/g, '<span class="chunk">$1</span>')
        .replace(/(completed successfully|DONE|done|complete)/gi, '<span class="done">$1</span>')
        .replace(/(error|failed|FAILED)/gi, '<span class="error">$1</span>')
        .replace(/(score:? \\d+%?|\\d+% quality)/g, '<span class="score">$1</span>')
        .replace(/(Translating|Reviewing|Smoothing|Re-review|Extracting|Chunked)/g, '<span class="info">$1</span>');
      return '<div class="line">' + s + '</div>';
    }

    async function fetchLogs() {
      try {
        const res = await fetch('/api/logs?tab=' + currentTab);
        const data = await res.json();

        // Status
        const dot = document.getElementById('status-dot');
        const txt = document.getElementById('status-text');
        if (data.status.running) {
          dot.className = 'dot on';
          txt.textContent = 'PID ' + data.status.pid;
        } else {
          dot.className = 'dot off';
          txt.textContent = 'stopped';
        }

        // Logs
        if (data.logs !== lastContent) {
          lastContent = data.logs;
          const terminal = document.getElementById('terminal');
          terminal.innerHTML = data.logs.split('\\n').map(colorize).join('');
          if (autoScroll) window.scrollTo(0, document.body.scrollHeight);
        }
      } catch (e) { /* retry next cycle */ }
    }

    fetchLogs();
    setInterval(fetchLogs, 1500);
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/logs')) {
    const tab = new URL(req.url, 'http://localhost').searchParams.get('tab') ?? 'stdout';
    const logPath = tab === 'stderr' ? LOG_STDERR : LOG_STDOUT;
    const logs = tailFile(logPath, 500);
    const status = getWorkerStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs, status }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`Worker Monitor: http://localhost:${PORT}`);
  // Open in browser
  try { execSync(`open http://localhost:${PORT}`); } catch { /* ok */ }
});
