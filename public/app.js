// ============ State ============
let config = { projects: [] };
let statuses = {};
let ws = null;
const expandedServices = new Set();
let editingProjectId = null;
let editingService = null; // { projectId, serviceId }
let currentProjectIdForService = null;

// ============ API ============
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ============ Utils ============
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function parseEnv(text) {
  const env = {};
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) env[trimmed.substring(0, idx)] = trimmed.substring(idx + 1);
  }
  return env;
}

function serializeEnv(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 2500);
  setTimeout(() => el.remove(), 3000);
}

// ============ WebSocket ============
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'init':
        if (msg.data.statuses) statuses = { ...statuses, ...msg.data.statuses };
        render();
        // Render buffered logs
        if (msg.data.logs) {
          for (const [serviceId, logs] of Object.entries(msg.data.logs)) {
            const terminal = document.getElementById(`terminal-${serviceId}`);
            if (terminal) {
              terminal.innerHTML = '';
              for (const entry of logs) {
                appendLogEntry(terminal, entry);
              }
              terminal.scrollTop = terminal.scrollHeight;
            }
          }
        }
        break;
      case 'log':
        appendLog(msg.serviceId, msg.data, msg.stream, msg.timestamp);
        break;
      case 'status':
        if (msg.status === 'running') {
          statuses[msg.serviceId] = { status: 'running', pid: msg.pid };
        } else {
          statuses[msg.serviceId] = { status: msg.status, exitCode: msg.exitCode };
        }
        render();
        break;
      case 'clear':
        const terminal = document.getElementById(`terminal-${msg.serviceId}`);
        if (terminal) terminal.innerHTML = '';
        break;
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 2000);
  };
}

// ============ Log Handling ============
function appendLogEntry(terminal, entry) {
  const line = document.createElement('div');
  const streamClass = entry.stream === 'stderr' ? 'stderr' : (entry.data.startsWith('[') && entry.data.endsWith(']') ? 'system' : '');
  line.className = `log-line ${streamClass}`;
  line.innerHTML = `<span class="timestamp">${formatTime(entry.timestamp)}</span>${escapeHtml(entry.data || '')}`;
  terminal.appendChild(line);
  while (terminal.children.length > 1000) terminal.removeChild(terminal.firstChild);
}

function appendLog(serviceId, text, stream, timestamp) {
  const terminal = document.getElementById(`terminal-${serviceId}`);
  if (!terminal) return;

  const wasAtBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 30;
  const empty = terminal.querySelector('.terminal-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  const isSystem = text.startsWith('[') && text.endsWith(']');
  line.className = `log-line ${stream === 'stderr' ? 'stderr' : ''} ${isSystem ? 'system' : ''}`;
  line.innerHTML = `<span class="timestamp">${formatTime(timestamp)}</span>${escapeHtml(text || '')}`;
  terminal.appendChild(line);

  while (terminal.children.length > 1000) terminal.removeChild(terminal.firstChild);
  if (wasAtBottom) terminal.scrollTop = terminal.scrollHeight;
}

// ============ Port Conflict Detection ============
function getPortConflicts() {
  const portMap = {};
  for (const project of config.projects) {
    for (const service of (project.services || [])) {
      if (service.port) {
        if (!portMap[service.port]) portMap[service.port] = [];
        portMap[service.port].push(service.id);
      }
    }
  }
  const conflicts = new Set();
  for (const ids of Object.values(portMap)) {
    if (ids.length > 1) ids.forEach(id => conflicts.add(id));
  }
  return conflicts;
}

// ============ Render ============
function render() {
  const main = document.getElementById('main');

  // Save terminal contents before re-render to prevent log loss
  const savedTerminals = {};
  document.querySelectorAll('.terminal[id^="terminal-"]').forEach(t => {
    if (t.innerHTML.trim() && !t.querySelector('.terminal-empty')) {
      savedTerminals[t.id] = t.innerHTML;
    }
  });

  if (config.projects.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="icon">📦</div>
        <p>还没有项目，点击右上角「添加项目」开始配置</p>
        <button class="btn btn-primary" onclick="showProjectModal()">+ 添加项目</button>
      </div>
    `;
    updateStatusSummary();
    return;
  }

  main.innerHTML = config.projects.map(p => renderProject(p)).join('');

  // Restore terminal contents after re-render
  for (const [id, html] of Object.entries(savedTerminals)) {
    const terminal = document.getElementById(id);
    if (terminal) terminal.innerHTML = html;
  }

  updateStatusSummary();
}

function renderProject(project) {
  const services = (project.services || []);
  const runningCount = services.filter(s => statuses[s.id]?.status === 'running').length;

  const hasRunning = runningCount > 0;
  const hasStopped = services.length > 0 && runningCount < services.length;

  const servicesHtml = services.length
    ? services.map(s => renderService(s, project)).join('')
    : `<div style="padding:20px;color:var(--text-muted);font-size:13px;">还没有服务，点击「添加服务」</div>`;

  return `
    <div class="project-section">
      <div class="project-header">
        <div class="project-title">
          <h2>📁 ${escapeHtml(project.name)}</h2>
          ${runningCount > 0 ? `<span class="status-summary">${runningCount} 个服务运行中</span>` : ''}
          ${project.path ? `<span class="project-path">${escapeHtml(project.path)}</span>` : ''}
        </div>
        <div class="project-actions">
          ${hasStopped ? `<button class="btn btn-sm btn-primary" onclick="startAll('${project.id}')">全部启动</button>` : ''}
          ${hasRunning ? `<button class="btn btn-sm btn-danger" onclick="stopAllInProject('${project.id}')">全部停止</button>` : ''}
          <button class="btn btn-sm" onclick="showServiceModal('${project.id}')">+ 添加服务</button>
          <button class="btn btn-sm" onclick="showProjectModal('${project.id}')">编辑</button>
          <button class="btn btn-sm" onclick="deleteProject('${project.id}')">删除</button>
        </div>
      </div>
      ${servicesHtml}
    </div>
  `;
}

function renderService(service, project) {
  const status = statuses[service.id] || { status: 'stopped' };
  const isRunning = status.status === 'running';
  const isExpanded = expandedServices.has(service.id);

  let envHint = '';
  if (service.env && Object.keys(service.env).length > 0) {
    envHint = ` <span style="color:var(--orange);">[${Object.keys(service.env).length} env vars]</span>`;
  }

  const conflicts = getPortConflicts();
  const hasPortConflict = conflicts.has(service.id);
  let portBadge = '';
  if (service.port) {
    const portUrl = `http://localhost:${service.port}`;
    const conflictClass = hasPortConflict ? 'port-conflict' : '';
    const conflictTitle = hasPortConflict ? ' title="⚠️ 端口与其他服务冲突！"' : '';
    if (isRunning) {
      portBadge = `<a href="${portUrl}" target="_blank" class="service-port ${conflictClass}"${conflictTitle}>🔗 :${service.port}</a>`;
    } else {
      portBadge = `<span class="service-port ${conflictClass}"${conflictTitle}>:${service.port}</span>`;
    }
  }

  return `
    <div class="service-row">
      <div class="service-header">
        <div class="status-dot ${status.status}"></div>
        <span class="service-name">${escapeHtml(service.name)}</span>
        <span class="service-command">${escapeHtml(service.command)}${envHint}</span>
        ${portBadge}
        ${isRunning && status.pid ? `<span class="service-pid">PID ${status.pid}</span>` : ''}
        <div class="service-actions">
          ${isRunning
            ? `<button class="btn btn-sm btn-danger" onclick="stopService('${service.id}')">停止</button>`
            : `<button class="btn btn-sm btn-primary" onclick="startService('${service.id}')">启动</button>`
          }
          <button class="btn btn-sm" onclick="toggleLog('${service.id}')">${isExpanded ? '收起' : '日志'}</button>
          <button class="btn btn-sm" onclick="clearLogs('${service.id}')">清除</button>
          <button class="btn btn-sm" onclick="showServiceModal('${project.id}', '${service.id}')">编辑</button>
          <button class="btn btn-sm" onclick="deleteService('${project.id}', '${service.id}')">删除</button>
        </div>
      </div>
      <div class="terminal ${isExpanded ? 'expanded' : ''}" id="terminal-${service.id}">
        <div class="terminal-empty">暂无日志输出</div>
      </div>
    </div>
  `;
}

function updateStatusSummary() {
  let total = 0, running = 0;
  for (const project of config.projects) {
    for (const service of (project.services || [])) {
      total++;
      if (statuses[service.id]?.status === 'running') running++;
    }
  }
  document.getElementById('statusSummary').textContent = `${running} / ${total} 运行中`;
}

// ============ Actions ============
async function startService(serviceId) {
  const result = await api(`/api/services/${serviceId}/start`, 'POST');
  if (result.error) toast(result.error, 'error');
  else {
    statuses[serviceId] = { status: 'running', pid: result.pid };
    expandedServices.add(serviceId);
    render();
  }
}

async function stopService(serviceId) {
  const result = await api(`/api/services/${serviceId}/stop`, 'POST');
  if (result.error) toast(result.error, 'error');
}

async function startAll(projectId) {
  await api(`/api/projects/${projectId}/start-all`, 'POST');
  toast('正在启动所有服务...', 'success');
}

async function stopAllInProject(projectId) {
  await api(`/api/projects/${projectId}/stop-all`, 'POST');
  toast('正在停止所有服务...', 'info');
}

async function clearLogs(serviceId) {
  await api(`/api/services/${serviceId}/logs`, 'DELETE');
  const terminal = document.getElementById(`terminal-${serviceId}`);
  if (terminal) terminal.innerHTML = '<div class="terminal-empty">暂无日志输出</div>';
}

function toggleLog(serviceId) {
  if (expandedServices.has(serviceId)) expandedServices.delete(serviceId);
  else expandedServices.add(serviceId);
  render();
}

async function deleteProject(projectId) {
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return;

  // Prevent deletion if any service in the project is running
  const runningServices = (project.services || []).filter(s => statuses[s.id]?.status === 'running');
  if (runningServices.length > 0) {
    toast(`项目下有 ${runningServices.length} 个服务正在运行，请先停止后再删除`, 'error');
    return;
  }

  if (!confirm(`确定删除项目「${project.name}」及其所有服务？`)) return;
  const result = await api(`/api/projects/${projectId}`, 'DELETE');
  if (result.error) { toast(result.error, 'error'); return; }
  config.projects = config.projects.filter(p => p.id !== projectId);
  // Clean up statuses
  for (const key of Object.keys(statuses)) {
    if (!findServiceById(key)) delete statuses[key];
  }
  render();
  toast('项目已删除', 'info');
}

async function deleteService(projectId, serviceId) {
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return;
  const service = (project.services || []).find(s => s.id === serviceId);
  if (!service) return;

  // Prevent deletion if service is running
  if (statuses[serviceId]?.status === 'running') {
    toast('服务正在运行中，请先停止后再删除', 'error');
    return;
  }

  if (!confirm(`确定删除服务「${service.name}」？`)) return;
  const result = await api(`/api/projects/${projectId}/services/${serviceId}`, 'DELETE');
  if (result.error) { toast(result.error, 'error'); return; }
  project.services = project.services.filter(s => s.id !== serviceId);
  delete statuses[serviceId];
  expandedServices.delete(serviceId);
  render();
  toast('服务已删除', 'info');
}

function findServiceById(serviceId) {
  for (const project of config.projects) {
    for (const service of (project.services || [])) {
      if (service.id === serviceId) return service;
    }
  }
  return null;
}

// ============ Modals ============
function showProjectModal(projectId = null) {
  editingProjectId = projectId;
  const modal = document.getElementById('projectModal');
  const title = document.getElementById('projectModalTitle');

  if (projectId) {
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return;
    title.textContent = '编辑项目';
    document.getElementById('projectName').value = project.name;
    document.getElementById('projectPath').value = project.path || '';
  } else {
    title.textContent = '添加项目';
    document.getElementById('projectName').value = '';
    document.getElementById('projectPath').value = '';
  }
  modal.classList.add('show');
}

function showServiceModal(projectId, serviceId = null) {
  currentProjectIdForService = projectId;
  editingService = serviceId ? { projectId, serviceId } : null;
  const modal = document.getElementById('serviceModal');
  const title = document.getElementById('serviceModalTitle');

  if (serviceId) {
    const project = config.projects.find(p => p.id === projectId);
    const service = (project?.services || []).find(s => s.id === serviceId);
    if (!service) return;
    title.textContent = '编辑服务';
    document.getElementById('serviceName').value = service.name;
    document.getElementById('serviceCommand').value = service.command;
    document.getElementById('servicePort').value = service.port || '';
    document.getElementById('serviceCwd').value = service.cwd || '';
    document.getElementById('serviceEnv').value = serializeEnv(service.env);
  } else {
    title.textContent = '添加服务';
    document.getElementById('serviceName').value = '';
    document.getElementById('serviceCommand').value = '';
    document.getElementById('servicePort').value = '';
    document.getElementById('serviceCwd').value = '';
    document.getElementById('serviceEnv').value = '';
  }
  modal.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

async function openFolderPicker(targetId) {
  const input = document.getElementById(targetId);
  if (!input) return;
  const currentDir = input.value.trim();
  const url = currentDir ? `/api/folder-picker?dir=${encodeURIComponent(currentDir)}` : '/api/folder-picker';
  toast('请在弹出的 Finder 窗口中选择文件夹...', 'info');
  const result = await api(url);
  if (result.path) {
    input.value = result.path;
  }
}

async function saveProject() {
  const name = document.getElementById('projectName').value.trim();
  const projectPath = document.getElementById('projectPath').value.trim();

  if (!name) { toast('请输入项目名称', 'error'); return; }

  if (editingProjectId) {
    await api(`/api/projects/${editingProjectId}`, 'PUT', { name, path: projectPath });
    const project = config.projects.find(p => p.id === editingProjectId);
    if (project) { project.name = name; project.path = projectPath; }
    toast('项目已更新', 'success');
  } else {
    const result = await api('/api/projects', 'POST', { name, path: projectPath });
    if (result.id) config.projects.push(result);
    toast('项目已添加', 'success');
  }
  closeModal('projectModal');
  render();
}

async function saveService() {
  const name = document.getElementById('serviceName').value.trim();
  const command = document.getElementById('serviceCommand').value.trim();
  const port = document.getElementById('servicePort').value.trim();
  const cwd = document.getElementById('serviceCwd').value.trim();
  const env = parseEnv(document.getElementById('serviceEnv').value);

  if (!name) { toast('请输入服务名称', 'error'); return; }
  if (!command) { toast('请输入启动命令', 'error'); return; }

  const projectId = currentProjectIdForService;
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return;

  if (editingService) {
    await api(`/api/projects/${projectId}/services/${editingService.serviceId}`, 'PUT', { name, command, cwd, env, port });
    const service = (project.services || []).find(s => s.id === editingService.serviceId);
    if (service) { service.name = name; service.command = command; service.cwd = cwd; service.env = env; service.port = port; }
    toast('服务已更新', 'success');
  } else {
    const result = await api(`/api/projects/${projectId}/services`, 'POST', { name, command, cwd, env, port });
    if (result.id) {
      project.services = project.services || [];
      project.services.push(result);
    }
    toast('服务已添加', 'success');
  }
  closeModal('serviceModal');
  render();
}

// ============ Init ============
async function init() {
  config = await api('/api/config');
  statuses = await api('/api/statuses');
  render();
  connectWebSocket();

  // Header buttons
  document.getElementById('addProjectBtn').onclick = () => showProjectModal();

  // Modal save buttons
  document.getElementById('saveProjectBtn').onclick = saveProject;
  document.getElementById('saveServiceBtn').onclick = saveService;

  // Close modal buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.onclick = () => closeModal(btn.dataset.close);
  });

  // Click overlay to close — only if both mousedown AND mouseup happen on the overlay itself
  // This prevents accidental close when dragging to select text and releasing outside the modal
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    let mouseDownOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => {
      mouseDownOnOverlay = (e.target === overlay);
    });
    overlay.addEventListener('mouseup', (e) => {
      if (mouseDownOnOverlay && e.target === overlay) {
        overlay.classList.remove('show');
      }
      mouseDownOnOverlay = false;
    });
  });

  // Folder picker buttons
  document.querySelectorAll('.folder-picker-btn').forEach(btn => {
    btn.onclick = () => openFolderPicker(btn.dataset.target);
  });

  // Quick command chips
  document.querySelectorAll('.chip[data-cmd]').forEach(chip => {
    chip.onclick = () => { document.getElementById('serviceCommand').value = chip.dataset.cmd; };
  });

  // ESC to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    }
  });
}

init();
