#!/usr/bin/env node
/**
 * Install/uninstall the local worker as a macOS LaunchAgent.
 * Usage:
 *   node scripts/worker-setup.mjs install   — install and start
 *   node scripts/worker-setup.mjs uninstall — stop and remove
 *   node scripts/worker-setup.mjs status    — check if running
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LABEL = 'com.aksharpith.local-worker';
const PLIST_DIR = resolve(homedir(), 'Library/LaunchAgents');
const PLIST_PATH = resolve(PLIST_DIR, `${LABEL}.plist`);
const LOG_DIR = resolve(ROOT, 'logs');
const NODE_PATH = process.execPath;
const WORKER_PATH = resolve(__dirname, 'local-worker.mjs');

const action = process.argv[2];

if (!action || !['install', 'uninstall', 'status'].includes(action)) {
  console.log('Usage: node scripts/worker-setup.mjs [install|uninstall|status]');
  process.exit(1);
}

if (action === 'status') {
  try {
    const result = execSync(`launchctl list ${LABEL} 2>&1`, { encoding: 'utf-8' });
    if (result.includes('PID')) {
      const pidMatch = result.match(/"PID"\s*=\s*(\d+)/);
      console.log(`[status] Worker is RUNNING (PID: ${pidMatch?.[1] ?? 'unknown'})`);
    } else {
      console.log('[status] Worker is INSTALLED but not running');
    }
  } catch {
    if (existsSync(PLIST_PATH)) {
      console.log('[status] Plist exists but agent is not loaded');
    } else {
      console.log('[status] Worker is NOT installed');
    }
  }
  process.exit(0);
}

if (action === 'uninstall') {
  try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch { /* may not be loaded */ }
  try { unlinkSync(PLIST_PATH); console.log('[uninstall] Removed plist'); } catch { console.log('[uninstall] No plist to remove'); }
  console.log('[uninstall] Worker daemon removed');
  process.exit(0);
}

// ── Install ──────────────────────────────────────────────────────────────────

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(LOG_DIR, { recursive: true });
}

const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${WORKER_PATH}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${resolve(LOG_DIR, 'worker-stdout.log')}</string>

  <key>StandardErrorPath</key>
  <string>${resolve(LOG_DIR, 'worker-stderr.log')}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${dirname(NODE_PATH)}</string>
  </dict>
</dict>
</plist>
`;

// Unload existing if present
try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch { /* ok */ }

writeFileSync(PLIST_PATH, plistContent);
console.log(`[install] Wrote plist to ${PLIST_PATH}`);

execSync(`launchctl load ${PLIST_PATH}`);
console.log('[install] Loaded and started worker daemon');
console.log(`[install] Logs: ${LOG_DIR}/worker-stdout.log`);
console.log('[install] The worker will auto-start on login and restart on crash.');
console.log('[install] Run "npm run worker:status" to check, "npm run worker:stop" to remove.');
