const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3456', 10);
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOGS_DIR = path.join(__dirname, 'logs');
const RUNTIME_STATE_FILE = path.join(LOGS_DIR, 'runtime-state.json');
const MAX_LOG_LINES = 500;

// ============ State ============
let config = { projects: [] };
const processes = new Map();   // serviceId -> { child, pid, startedAt, reattached? }
const logBuffers = new Map();  // serviceId -> logEntry[]
const wsClients = new Set();

// ============ Config ============
function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    config = JSON.parse(data);
    if (!config.projects) config.projects = [];
  } catch {
    config = { projects: [] };
    saveConfig();
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============ Helpers ============
function findService(serviceId) {
  for (const project of config.projects) {
    for (const service of (project.services || [])) {
      if (service.id === serviceId) return { project, service };
    }
  }
  return null;
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(data);
  }
}

function addToBuffer(serviceId, entry) {
  const buf = logBuffers.get(serviceId) || [];
  buf.push(entry);
  if (buf.length > MAX_LOG_LINES) buf.shift();
  logBuffers.set(serviceId, buf);
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ============ Runtime State Persistence ============
function saveRuntimeState() {
  try {
    const state = {};
    for (const [serviceId, proc] of processes) {
      state[serviceId] = { pid: proc.pid, startedAt: proc.startedAt };
    }
    ensureLogsDir();
    fs.writeFileSync(RUNTIME_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function restoreRuntimeState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(RUNTIME_STATE_FILE, 'utf-8'));
  } catch {
    return; // no state file or invalid
  }

  let restoredCount = 0;
  for (const [serviceId, info] of Object.entries(state)) {
    // Skip if service no longer exists in config
    if (!findService(serviceId)) continue;
    // Skip if already in processes Map (shouldn't happen on fresh start)
    if (processes.has(serviceId)) continue;

    if (isProcessAlive(info.pid)) {
      // Re-attach: process is still alive from before restart
      processes.set(serviceId, {
        child: null,
        pid: info.pid,
        startedAt: info.startedAt,
        reattached: true,
      });
      const entry = {
        type: 'log', serviceId, stream: 'stderr',
        data: `[Reattached — process was already running (PID ${info.pid}), new log output unavailable. Stop & restart to restore full logging.]`,
        timestamp: Date.now(),
      };
      addToBuffer(serviceId, entry);
      restoredCount++;
    }
  }

  saveRuntimeState(); // persist cleaned-up state (without dead PIDs)
  return restoredCount;
}

// Poll reattached processes for exit (no child.on('exit') available)
function pollReattachedProcesses() {
  let changed = false;
  for (const [serviceId, proc] of processes) {
    if (!proc.reattached) continue;
    if (isProcessAlive(proc.pid)) continue;

    // Process has exited
    processes.delete(serviceId);
    changed = true;
    const status = proc.killing ? 'stopped' : 'error';
    const entry = {
      type: 'log', serviceId, stream: 'stderr',
      data: `[Process exited${proc.killing ? ' — stopped by user' : ' — detected via polling'}]`,
      timestamp: Date.now(),
    };
    broadcast(entry);
    addToBuffer(serviceId, entry);
    broadcast({ type: 'status', serviceId, status, pid: null, timestamp: Date.now() });
  }
  if (changed) saveRuntimeState();
}

// ============ Unmanaged Service Notes ============
const UNMANAGED_NOTES_FILE = path.join(LOGS_DIR, 'unmanaged-notes.json');

function loadUnmanagedNotes() {
  try {
    return JSON.parse(fs.readFileSync(UNMANAGED_NOTES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveUnmanagedNotes(notes) {
  try {
    ensureLogsDir();
    fs.writeFileSync(UNMANAGED_NOTES_FILE, JSON.stringify(notes, null, 2));
  } catch {}
}

// ============ App Icon Extraction ============
const APP_ICON_CACHE_DIR = path.join(__dirname, 'public', 'icons', 'cache');

// Extract the .app bundle path from a full command line, e.g.
// "/Applications/Google Chrome.app/Contents/Frameworks/..." -> "/Applications/Google Chrome.app"
function extractAppPath(commandLine) {
  if (!commandLine) return null;
  const m = commandLine.match(/^"?(.+?\.app)"?\//);
  return m ? m[1] : null;
}

// Convert an app's .icns to a cached 64x64 png under public/icons/cache.
// Returns the static URL path, or null on failure.
function getAppIconUrl(appPath) {
  try {
    const key = crypto.createHash('md5').update(appPath).digest('hex');
    const outFile = path.join(APP_ICON_CACHE_DIR, key + '.png');
    if (!fs.existsSync(outFile)) {
      const plistBase = path.join(appPath, 'Contents', 'Info');
      let iconFile = execFileSync('defaults', ['read', plistBase, 'CFBundleIconFile'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (!iconFile) return null;
      if (!iconFile.endsWith('.icns')) iconFile += '.icns';
      const icnsPath = path.join(appPath, 'Contents', 'Resources', iconFile);
      if (!fs.existsSync(icnsPath)) return null;
      if (!fs.existsSync(APP_ICON_CACHE_DIR)) fs.mkdirSync(APP_ICON_CACHE_DIR, { recursive: true });
      execFileSync('sips', ['-s', 'format', 'png', '-z', '64', '64', icnsPath, '--out', outFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return `/icons/cache/${key}.png`;
  } catch {
    return null;
  }
}

// ============ Unmanaged Service Scanner ============
function scanUnmanagedServices() {
  return new Promise((resolve) => {
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }

      // Collect PIDs managed by us. Service Manager itself (process.pid) is
      // NOT excluded — it appears in the list flagged with isSelf.
      // Services spawn with detached:true, so the tracked PID is a process-group
      // leader; descendants (npm→node, uv→python) share that pgid.
      const managedPids = new Set();
      const managedPgids = new Set();
      for (const [, proc] of processes) {
        managedPids.add(proc.pid);
        managedPgids.add(proc.pid);
      }

      // Build pid -> { pgid, etime, command } map for all processes
      execFile('ps', ['-eo', 'pid=,pgid=,etime=,command='], (psErr, psOut) => {
        const psMap = {};
        if (!psErr && psOut.trim()) {
          for (const line of psOut.trim().split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
            if (m) psMap[m[1]] = { pgid: parseInt(m[2]), etime: m[3], command: m[4].trim() };
          }
        }

        const seen = new Set();
        const entries = [];

        const lines = stdout.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;

          const parts = line.trim().split(/\s+/);
          if (parts.length < 9) continue;

          const command = parts[0];
          const pid = parseInt(parts[1]);
          const user = parts[2];
          const nameField = parts[8];

          const portMatch = nameField.match(/:(\d+)$/);
          if (!portMatch) continue;
          const port = parseInt(portMatch[1]);

          // Filter: skip system processes, our managed ones, and any process
          // inside a managed process group (descendants of managed services)
          if (managedPids.has(pid)) continue;
          const psInfo = psMap[pid];
          if (psInfo && managedPgids.has(psInfo.pgid)) continue;
          if (seen.has(pid)) continue;
          if (user === 'root') continue;
          if (pid < 2) continue;

          seen.add(pid);
          entries.push({
            pid, port, command, user,
            fullCommand: psInfo ? psInfo.command : command,
            etime: psInfo ? psInfo.etime : '',
            isSelf: pid === process.pid,
          });
        }

        // Attach saved notes
        const notes = loadUnmanagedNotes();
        for (const e of entries) e.note = notes[e.pid] || '';

        // Resolve icons: .app bundle icon if the process belongs to an app
        for (const e of entries) {
          const appPath = extractAppPath(e.fullCommand);
          if (appPath) {
            e.appName = path.basename(appPath, '.app');
            const iconUrl = getAppIconUrl(appPath);
            if (iconUrl) e.iconUrl = iconUrl;
          }
        }

        // Sort by port number
        entries.sort((a, b) => a.port - b.port);
        resolve(entries);
      });
    });
  });
}

// ============ Process Management ============
// Check if a TCP port is already being LISTENed on; returns { pid, command } or null
function findPortOccupant(port) {
  try {
    const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-P', '-n', '-t'], { encoding: 'utf-8' });
    const pid = parseInt(out.trim().split('\n')[0]);
    if (!pid) return null;
    let command = '';
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    } catch {}
    return { pid, command };
  } catch {
    return null; // lsof exits 1 when nothing matches
  }
}

function startProcess(serviceId) {
  const result = findService(serviceId);
  if (!result) return { error: 'Service not found' };
  if (processes.has(serviceId)) return { error: 'Already running' };

  const { project, service } = result;

  // Pre-flight: refuse to spawn if the configured port is already occupied,
  // otherwise the new process dies with EADDRINUSE and the squatter (often a
  // leftover orphan) keeps serving — looking like "running" but unmanaged.
  if (service.port) {
    const occupant = findPortOccupant(parseInt(service.port));
    if (occupant) {
      // Is the occupant part of a managed service's process group?
      let managedBy = null;
      try {
        const pgid = parseInt(execFileSync('ps', ['-p', String(occupant.pid), '-o', 'pgid='], { encoding: 'utf-8' }).trim());
        for (const [sid, proc] of processes) {
          if (proc.pid === occupant.pid || proc.pid === pgid) {
            const found = findService(sid);
            managedBy = found ? (found.service.name || found.service.command) : null;
            break;
          }
        }
      } catch {}
      if (managedBy) {
        return { error: `端口 ${service.port} 已被正在运行的服务「${managedBy}」占用` };
      }
      const cmdInfo = occupant.command ? `（${occupant.command}）` : '';
      return { error: `端口 ${service.port} 已被 PID ${occupant.pid}${cmdInfo} 占用，请先在「未管理服务」中停止该进程，或为服务配置其他端口` };
    }
  }

  let cwd = service.cwd || project.path || process.cwd();
  if (!path.isAbsolute(cwd) && project.path) {
    cwd = path.resolve(project.path, cwd);
  }

  const env = { ...process.env, ...(service.env || {}) };

  let child;
  try {
    child = spawn(service.command, {
      cwd,
      shell: true,
      detached: true,
      env,
    });
  } catch (err) {
    return { error: err.message };
  }

  if (!child.pid) {
    return { error: 'Failed to spawn process' };
  }

  const proc = { child, pid: child.pid, startedAt: Date.now() };
  processes.set(serviceId, proc);
  if (!logBuffers.has(serviceId)) logBuffers.set(serviceId, []);
  saveRuntimeState();

  broadcast({ type: 'status', serviceId, status: 'running', pid: child.pid, timestamp: Date.now() });

  // Line-buffered stdout
  let stdoutBuf = '';
  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.substring(0, idx);
      stdoutBuf = stdoutBuf.substring(idx + 1);
      const entry = { type: 'log', serviceId, stream: 'stdout', data: line, timestamp: Date.now() };
      broadcast(entry);
      addToBuffer(serviceId, entry);
    }
  });

  // Line-buffered stderr
  let stderrBuf = '';
  child.stderr.on('data', (data) => {
    stderrBuf += data.toString();
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.substring(0, idx);
      stderrBuf = stderrBuf.substring(idx + 1);
      const entry = { type: 'log', serviceId, stream: 'stderr', data: line, timestamp: Date.now() };
      broadcast(entry);
      addToBuffer(serviceId, entry);
    }
  });

  // Error event (spawn failure)
  child.on('error', (err) => {
    processes.delete(serviceId);
    saveRuntimeState();
    const entry = { type: 'log', serviceId, stream: 'stderr', data: `[Spawn Error: ${err.message}]`, timestamp: Date.now() };
    broadcast(entry);
    addToBuffer(serviceId, entry);
    broadcast({ type: 'status', serviceId, status: 'error', exitCode: -1, pid: null, timestamp: Date.now() });
  });

  // Exit event
  child.on('exit', (code, signal) => {
    // Flush remaining buffers
    if (stdoutBuf) {
      const entry = { type: 'log', serviceId, stream: 'stdout', data: stdoutBuf, timestamp: Date.now() };
      broadcast(entry);
      addToBuffer(serviceId, entry);
      stdoutBuf = '';
    }
    if (stderrBuf) {
      const entry = { type: 'log', serviceId, stream: 'stderr', data: stderrBuf, timestamp: Date.now() };
      broadcast(entry);
      addToBuffer(serviceId, entry);
      stderrBuf = '';
    }

    const wasKilling = proc.killing;
    processes.delete(serviceId);
    saveRuntimeState();
    const status = (code === 0 || wasKilling) ? 'stopped' : 'error';
    const exitMsg = `[Process exited — code ${code}${signal ? `, signal ${signal}` : ''}]`;
    const entry = { type: 'log', serviceId, stream: 'stderr', data: exitMsg, timestamp: Date.now() };
    broadcast(entry);
    addToBuffer(serviceId, entry);
    broadcast({ type: 'status', serviceId, status, exitCode: code, signal, pid: null, timestamp: Date.now() });
  });

  return { success: true, pid: child.pid };
}

// Delayed services: auto-start after a short grace period (1s) so
// dependencies (databases, backends) can come up first.
function scheduleDelayedStart(serviceId, delayMs = 1000) {
  setTimeout(() => {
    if (!processes.has(serviceId)) startProcess(serviceId);
  }, delayMs);
}

function stopProcess(serviceId) {
  const proc = processes.get(serviceId);
  if (!proc) return { error: 'Not running' };

  // Avoid duplicate SIGTERM / SIGKILL timers
  if (proc.killing) return { error: 'Already stopping' };
  proc.killing = true;

  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    processes.delete(serviceId);
    saveRuntimeState();
    broadcast({ type: 'status', serviceId, status: 'stopped', pid: null, timestamp: Date.now() });
    return { success: true };
  }

  // Force kill after 5s (works for both normal and reattached processes)
  setTimeout(() => {
    if (processes.has(serviceId)) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    }
  }, 5000);

  return { success: true };
}

// ============ Express App ============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config ---
app.get('/api/config', (_req, res) => res.json(config));

app.get('/api/statuses', (_req, res) => {
  const statuses = {};
  for (const [serviceId, proc] of processes) {
    statuses[serviceId] = { status: 'running', pid: proc.pid, startedAt: proc.startedAt, reattached: !!proc.reattached };
  }
  res.json(statuses);
});

// --- Project CRUD ---
app.post('/api/projects', (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const project = { id: crypto.randomUUID(), name, path: projectPath || '', services: [], hidden: false };
  config.projects.push(project);
  saveConfig();
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { name, path: projectPath, hidden } = req.body;
  if (name !== undefined) project.name = name;
  if (projectPath !== undefined) project.path = projectPath;
  if (hidden !== undefined) project.hidden = !!hidden;
  saveConfig();
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Reject deletion if any service is running
  for (const service of (project.services || [])) {
    if (processes.has(service.id)) {
      return res.status(400).json({ error: '项目下有服务正在运行，请先停止' });
    }
  }
  config.projects = config.projects.filter(p => p.id !== req.params.id);
  saveConfig();
  res.json({ success: true });
});

app.post('/api/projects/:id/toggle-hidden', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.hidden = !project.hidden;
  saveConfig();
  res.json({ success: true, hidden: project.hidden });
});

// --- Service CRUD ---
app.post('/api/projects/:id/services', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { name, command, cwd, env, port, delayed } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });
  const service = { id: crypto.randomUUID(), name: name || '', command, cwd: cwd || '', env: env || {}, port: port || '', delayed: !!delayed };
  project.services = project.services || [];
  project.services.push(service);
  saveConfig();
  res.json(service);
});

app.put('/api/projects/:id/services/:serviceId', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const service = (project.services || []).find(s => s.id === req.params.serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const { name, command, cwd, env, port, delayed } = req.body;
  if (name !== undefined) service.name = name;
  if (command !== undefined) service.command = command;
  if (cwd !== undefined) service.cwd = cwd;
  if (env !== undefined) service.env = env;
  if (port !== undefined) service.port = port;
  if (delayed !== undefined) service.delayed = !!delayed;
  saveConfig();
  res.json(service);
});

app.delete('/api/projects/:id/services/:serviceId', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Reject deletion if service is running
  if (processes.has(req.params.serviceId)) {
    return res.status(400).json({ error: '服务正在运行中，请先停止' });
  }
  project.services = (project.services || []).filter(s => s.id !== req.params.serviceId);
  saveConfig();
  res.json({ success: true });
});

// --- Process Control ---
app.post('/api/services/:serviceId/start', (req, res) => res.json(startProcess(req.params.serviceId)));
app.post('/api/services/:serviceId/stop', (req, res) => res.json(stopProcess(req.params.serviceId)));

app.post('/api/projects/:id/start-all', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  let started = 0;
  let delayed = 0;
  const failures = [];
  for (const service of (project.services || [])) {
    if (processes.has(service.id)) continue;
    if (service.delayed) { delayed++; scheduleDelayedStart(service.id); continue; }
    const r = startProcess(service.id);
    if (r.error) failures.push({ name: service.name || service.command, error: r.error });
    else started++;
  }
  res.json({ success: true, started, delayed, failures });
});

app.post('/api/projects/:id/stop-all', (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  for (const service of (project.services || [])) {
    if (processes.has(service.id)) stopProcess(service.id);
  }
  res.json({ success: true });
});

app.post('/api/start-all', (_req, res) => {
  let started = 0;
  let delayed = 0;
  const failures = [];
  for (const project of config.projects) {
    if (project.hidden) continue;
    for (const service of (project.services || [])) {
      if (processes.has(service.id)) continue;
      if (service.delayed) { delayed++; scheduleDelayedStart(service.id); continue; }
      const r = startProcess(service.id);
      if (r.error) failures.push({ name: service.name || service.command, error: r.error });
      else started++;
    }
  }
  res.json({ success: true, started, delayed, failures });
});

app.delete('/api/services/:serviceId/logs', (req, res) => {
  logBuffers.delete(req.params.serviceId);
  broadcast({ type: 'clear', serviceId: req.params.serviceId });
  res.json({ success: true });
});

// --- Folder Picker (macOS Finder) ---
app.get('/api/folder-picker', (req, res) => {
  const startDir = req.query.dir || '';
  let script;
  if (startDir) {
    script = `POSIX path of (choose folder default location POSIX file "${startDir}")`;
  } else {
    script = 'POSIX path of (choose folder)';
  }
  execFile('osascript', ['-e', script], (err, stdout) => {
    if (err) {
      return res.json({ path: null });
    }
    const selectedPath = stdout.trim().replace(/\/$/, '');
    res.json({ path: selectedPath });
  });
});

// --- Unmanaged Services ---
app.get('/api/unmanaged', async (_req, res) => {
  try {
    const services = await scanUnmanagedServices();
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/unmanaged/note', (req, res) => {
  const pidNum = parseInt(req.body.pid);
  if (!pidNum) {
    return res.status(400).json({ error: '无效的 PID' });
  }
  const notes = loadUnmanagedNotes();
  const note = (req.body.note || '').trim();
  if (note) notes[pidNum] = note;
  else delete notes[pidNum];
  saveUnmanagedNotes(notes);
  res.json({ success: true });
});

app.post('/api/unmanaged/kill', (req, res) => {
  const pidNum = parseInt(req.body.pid);
  if (!pidNum) {
    return res.status(400).json({ error: '无效的 PID' });
  }
  // Safety: don't allow killing Service Manager itself
  if (pidNum === process.pid) {
    return res.status(400).json({ error: '不能停止 Service Manager 自身' });
  }
  // Safety: don't allow killing processes managed by us
  for (const [, proc] of processes) {
    if (proc.pid === pidNum) {
      return res.status(400).json({ error: '此进程由 Service Manager 管理，请在项目面板中停止' });
    }
  }
  try {
    process.kill(pidNum, 'SIGTERM');
    // Force kill after 3s if still alive
    setTimeout(() => {
      try {
        process.kill(pidNum, 0);
        process.kill(pidNum, 'SIGKILL');
      } catch {}
    }, 3000);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: `无法停止进程: ${err.message}` });
  }
});

// ============ HTTP + WebSocket Server ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send initial state (statuses + buffered logs)
  const init = { type: 'init', data: { statuses: {}, logs: {} } };
  for (const [serviceId, proc] of processes) {
    init.data.statuses[serviceId] = { status: 'running', pid: proc.pid, startedAt: proc.startedAt, reattached: !!proc.reattached };
  }
  for (const [serviceId, buf] of logBuffers) {
    init.data.logs[serviceId] = buf;
  }
  ws.send(JSON.stringify(init));

  ws.on('close', () => wsClients.delete(ws));
});

// ============ Cleanup ============
function cleanup() {
  for (const [, proc] of processes) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  }
  // Clear runtime state so next startup doesn't try to re-attach killed processes
  try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ============ Start ============
loadConfig();
const restored = restoreRuntimeState();
setInterval(pollReattachedProcesses, 3000);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with another port, for example: PORT=3457 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚡ Service Manager running at http://${HOST}:${PORT}`);
  if (restored) {
    console.log(`  🔄 Re-attached ${restored} running process(es) from previous session\n`);
  } else {
    console.log();
  }
});
