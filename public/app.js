// ============ State ============
let config = { projects: [] };
let statuses = {};
let appHealth = null;
let ws = null;
const expandedServices = new Set();
let editingProjectId = null;
let editingService = null; // { projectId, serviceId }
let currentProjectIdForService = null;
let hiddenProjectsExpanded = false;
let scanResult = null;

// ============ Icons ============
const ICONS = {
  edit:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  hide:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
  show:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  clear:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><rect x="5" y="6" width="14" height="16" rx="1"/></svg>',
  logs:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  note:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
};

function iconBtn(icon, onclick, title, danger = false) {
  const cls = danger ? 'icon-btn icon-btn-danger' : 'icon-btn';
  return `<button class="${cls}" onclick="${onclick}" title="${title}">${ICONS[icon]}</button>`;
}

// ============ Tech Icon Detection ============
function detectTechIcon(command) {
  const c = (command || '').toLowerCase();
  const rules = [
    ['streamlit', 'streamlit'], ['gradio', 'gradio'],
    ['vite', 'vite'], ['pnpm', 'pnpm'], ['npm', 'npm'], ['yarn', 'yarn'],
    ['bun', 'bun'], ['deno', 'deno'], ['node', 'node'],
    ['react', 'react'], ['vue', 'vue'],
    ['uv ', 'python'], ['uv"', 'python'], ['python', 'python'],
    ['flask', 'flask'], ['django', 'django'], ['gunicorn', 'python'],
    ['uvicorn', 'python'], ['jupyter', 'python'], ['conda', 'python'],
    ['docker', 'docker'], ['nginx', 'nginx'], ['redis', 'redis'],
    ['postgres', 'postgresql'], ['mysql', 'mysql'], ['maria', 'mysql'], ['mongo', 'mongodb'],
    ['go run', 'go'], ['go build', 'go'], ['ruby', 'ruby'], ['rails', 'ruby'],
    ['java', 'java'], ['mvn', 'java'], ['gradle', 'java'],
    ['php', 'php'], ['cargo', 'rust'], ['ffmpeg', 'ffmpeg'],
    ['ollama', 'ollama'], ['chrome', 'chrome'], ['electron', 'electron'],
    ['brew', 'homebrew'],
  ];
  for (const [kw, icon] of rules) {
    if (c.includes(kw)) return `/icons/tech/${icon}.svg`;
  }
  return '/icons/tech/generic.svg';
}

// ============ API ============
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const routeMismatch = /Cannot (GET|POST|PUT|DELETE) \/api\//.test(text);
    data = {
      error: routeMismatch
        ? '当前页面和后台服务版本不一致，请重启 Service Manager 后刷新页面'
        : text || `请求失败 (${res.status})`,
    };
  }
  if (!res.ok && !data.error) data.error = `请求失败 (${res.status})`;
  return data;
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

function basename(filePath) {
  return (filePath || '').replace(/\/+$/, '').split('/').pop() || filePath || '';
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
  const projectsList = document.getElementById('projectsList');
  const hiddenProjectsList = document.getElementById('hiddenProjectsList');

  // Save terminal contents before re-render to prevent log loss
  const savedTerminals = {};
  document.querySelectorAll('.terminal[id^="terminal-"]').forEach(t => {
    if (t.innerHTML.trim() && !t.querySelector('.terminal-empty')) {
      savedTerminals[t.id] = t.innerHTML;
    }
  });

  if (config.projects.length === 0) {
    projectsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📦</div>
        <p>还没有项目，点击右上角「添加项目」开始配置</p>
        <button class="btn btn-primary" onclick="showProjectModal()">+ 添加项目</button>
      </div>
    `;
    hiddenProjectsList.innerHTML = '';
    updateStatusSummary();
    return;
  }

  const visibleProjects = config.projects.filter(p => !p.hidden);
  const hiddenProjects = config.projects.filter(p => p.hidden);

  projectsList.innerHTML = visibleProjects.length
    ? visibleProjects.map(p => renderProject(p)).join('')
    : `
      <div class="empty-state compact">
        <p>没有显示中的项目</p>
        <button class="btn btn-primary" onclick="showProjectModal()">+ 添加项目</button>
      </div>
    `;

  if (hiddenProjects.length > 0) {
    const expandIcon = hiddenProjectsExpanded ? '▼' : '▶';
    hiddenProjectsList.innerHTML = `
      <div class="hidden-projects-section">
        <div class="hidden-projects-header" onclick="toggleHiddenProjects()">
          <span class="hidden-projects-toggle">${expandIcon}</span>
          <span class="hidden-projects-title">📦 已隐藏的项目 (${hiddenProjects.length})</span>
          <span class="hidden-projects-hint">${hiddenProjectsExpanded ? '点击折叠' : '点击展开'}</span>
        </div>
        ${hiddenProjectsExpanded ? hiddenProjects.map(p => renderProject(p, true)).join('') : ''}
      </div>
    `;
  } else {
    hiddenProjectsList.innerHTML = '';
  }

  // Restore terminal contents after re-render
  for (const [id, html] of Object.entries(savedTerminals)) {
    const terminal = document.getElementById(id);
    if (terminal) terminal.innerHTML = html;
  }

  updateStatusSummary();
}

function renderProject(project, isHidden = false) {
  const services = (project.services || []);
  const runningCount = services.filter(s => statuses[s.id]?.status === 'running').length;

  const hasRunning = runningCount > 0;
  const hasStopped = services.length > 0 && runningCount < services.length;

  const servicesHtml = services.length
    ? services.map(s => renderService(s, project)).join('')
    : `<div style="padding:20px;color:var(--text-muted);font-size:13px;">还没有服务，点击「添加服务」</div>`;

  return `
    <div class="project-section${isHidden ? ' project-hidden' : ''}">
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
          <span class="action-divider"></span>
          ${iconBtn('edit', `showProjectModal('${project.id}')`, '编辑项目')}
          ${isHidden
            ? iconBtn('show', `unhideProject('${project.id}')`, '显示项目')
            : iconBtn('hide', `hideProject('${project.id}')`, '隐藏项目')
          }
          ${iconBtn('trash', `deleteProject('${project.id}')`, '删除项目', true)}
        </div>
      </div>
      <div class="project-services">${servicesHtml}</div>
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
        <div class="status-dot ${isRunning ? 'running' : 'stopped'}"></div>
        <img class="service-icon" src="${detectTechIcon(service.command)}" alt="" onerror="this.src='/icons/tech/generic.svg'">
        ${service.name ? `<span class="service-name">${escapeHtml(service.name)}</span>` : ''}
        <span class="service-command">${escapeHtml(service.command)}${envHint}</span>
        ${portBadge}
        ${isRunning && status.pid ? `<span class="service-pid">PID ${status.pid}</span>` : ''}
        ${service.delayed ? `<span class="delayed-badge" title="延迟服务：「全部运行」时会延迟 1 秒自动启动">⏳ 延迟</span>` : ''}
        ${isRunning && status.reattached ? `<span class="reattached-badge" title="此进程在服务管理器重启前已在运行，已自动重新接管。停止后重新启动可恢复完整日志捕获。">🔄 重接管</span>` : ''}
        <div class="service-actions">
          ${isRunning
            ? `<button class="btn btn-sm btn-danger" onclick="stopService('${service.id}')">停止</button>`
            : `<button class="btn btn-sm btn-primary" onclick="startService('${service.id}')">启动</button>`
          }
          <button class="btn btn-sm" onclick="toggleLog('${service.id}')">${isExpanded ? '收起' : '日志'}</button>
          <span class="action-divider"></span>
          ${iconBtn('clear', `clearLogs('${service.id}')`, '清除日志')}
          ${iconBtn('edit', `showServiceModal('${project.id}', '${service.id}')`, '编辑服务')}
          ${iconBtn('trash', `deleteService('${project.id}', '${service.id}')`, '删除服务', true)}
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
  const result = await api(`/api/projects/${projectId}/start-all`, 'POST');
  if (result.error) { toast(result.error, 'error'); return; }
  if (result.failures && result.failures.length > 0) {
    toast(`已启动 ${result.started} 个，失败 ${result.failures.length} 个`, 'error');
    for (const f of result.failures) toast(`${f.name}：${f.error}`, 'error');
  } else if (result.delayed > 0) {
    toast(`已启动 ${result.started} 个，${result.delayed} 个延迟服务将在 1 秒后自动启动`, 'success');
  } else {
    toast('正在启动所有服务...', 'success');
  }
}

async function stopAllInProject(projectId) {
  await api(`/api/projects/${projectId}/stop-all`, 'POST');
  toast('正在停止所有服务...', 'info');
}

async function startAllGlobal() {
  const result = await api('/api/start-all', 'POST');
  if (result.error) { toast(result.error, 'error'); return; }
  const failed = result.failures || [];
  const parts = [];
  if (result.started > 0) parts.push(`已启动 ${result.started} 个服务`);
  if (result.delayed > 0) parts.push(`${result.delayed} 个延迟服务将在 1 秒后自动启动`);
  if (failed.length > 0) parts.push(`失败 ${failed.length} 个`);
  if (parts.length === 0) {
    toast('没有需要启动的服务', 'info');
  } else {
    toast(parts.join('，'), failed.length > 0 ? 'error' : 'success');
  }
  for (const f of failed) toast(`${f.name}：${f.error}`, 'error');
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

  if (!confirm(`确定删除服务「${service.name || service.command}」？`)) return;
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

async function hideProject(projectId) {
  const result = await api(`/api/projects/${projectId}/toggle-hidden`, 'POST');
  if (result.error) { toast(result.error, 'error'); return; }
  const project = config.projects.find(p => p.id === projectId);
  if (project) project.hidden = true;
  render();
  toast(`项目「${project?.name || ''}」已隐藏`, 'info');
}

async function unhideProject(projectId) {
  const result = await api(`/api/projects/${projectId}/toggle-hidden`, 'POST');
  if (result.error) { toast(result.error, 'error'); return; }
  const project = config.projects.find(p => p.id === projectId);
  if (project) project.hidden = false;
  render();
  toast(`项目「${project?.name || ''}」已显示`, 'success');
}

function toggleHiddenProjects() {
  hiddenProjectsExpanded = !hiddenProjectsExpanded;
  render();
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
    document.getElementById('serviceDelayed').checked = !!service.delayed;
  } else {
    title.textContent = '添加服务';
    document.getElementById('serviceName').value = '';
    document.getElementById('serviceCommand').value = '';
    document.getElementById('servicePort').value = '';
    document.getElementById('serviceCwd').value = '';
    document.getElementById('serviceEnv').value = '';
    document.getElementById('serviceDelayed').checked = false;
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

async function pickFolder(startDir = '') {
  const url = startDir ? `/api/folder-picker?dir=${encodeURIComponent(startDir)}` : '/api/folder-picker';
  const result = await api(url);
  return result.path || '';
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
  const delayed = document.getElementById('serviceDelayed').checked;

  if (!command) { toast('请输入启动命令', 'error'); return; }

  const projectId = currentProjectIdForService;
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return;

  if (editingService) {
    await api(`/api/projects/${projectId}/services/${editingService.serviceId}`, 'PUT', { name, command, cwd, env, port, delayed });
    const service = (project.services || []).find(s => s.id === editingService.serviceId);
    if (service) { service.name = name; service.command = command; service.cwd = cwd; service.env = env; service.port = port; service.delayed = delayed; }
    toast('服务已更新', 'success');
  } else {
    const result = await api(`/api/projects/${projectId}/services`, 'POST', { name, command, cwd, env, port, delayed });
    if (result.id) {
      project.services = project.services || [];
      project.services.push(result);
    }
    toast('服务已添加', 'success');
  }
  closeModal('serviceModal');
  render();
}

// ============ Project Scanner ============
async function scanProjectFromFolder() {
  toast('请在弹出的 Finder 窗口中选择要扫描的项目文件夹...', 'info');
  const selectedPath = await pickFolder();
  if (!selectedPath) return;

  const result = await api('/api/projects/scan', 'POST', { path: selectedPath });
  if (result.error) { toast(result.error, 'error'); return; }
  scanResult = result;
  showScanModal(result);
}

function showScanModal(result) {
  document.getElementById('scanProjectName').value = result.name || basename(result.path);
  document.getElementById('scanProjectPath').textContent = result.path || '';
  renderScanServices();
  document.getElementById('scanModal').classList.add('show');
}

function renderScanServices() {
  const services = scanResult?.services || [];
  const summary = document.getElementById('scanSummary');
  const list = document.getElementById('scanServices');
  summary.textContent = services.length > 0
    ? `发现 ${services.length} 个可能的服务，请确认后导入`
    : '没有自动识别到服务，可以先导入空项目后手动添加服务';

  if (services.length === 0) {
    list.innerHTML = '<div class="scan-empty">未发现 package.json、Docker Compose、Python、Go、Rust 或 Java 启动入口。</div>';
    return;
  }

  list.innerHTML = services.map((service, index) => `
    <label class="scan-service-row">
      <input type="checkbox" class="scan-service-check" data-index="${index}" checked>
      <img class="service-icon" src="${detectTechIcon(service.command)}" alt="" onerror="this.src='/icons/tech/generic.svg'">
      <span class="scan-service-main">
        <span class="scan-service-name">${escapeHtml(service.name)}</span>
        <code>${escapeHtml(service.command)}</code>
        <small>${escapeHtml(service.reason || '')}</small>
      </span>
      ${service.cwd ? `<span class="scan-service-cwd">${escapeHtml(service.cwd)}</span>` : ''}
      ${service.port ? `<span class="service-port">:${escapeHtml(service.port)}</span>` : ''}
    </label>
  `).join('');
}

async function importScanResult() {
  if (!scanResult) return;
  const name = document.getElementById('scanProjectName').value.trim();
  if (!name) { toast('请输入项目名称', 'error'); return; }

  const selected = [...document.querySelectorAll('.scan-service-check:checked')]
    .map(input => scanResult.services[parseInt(input.dataset.index)])
    .filter(Boolean);

  const result = await api('/api/projects/import-scan', 'POST', {
    name,
    path: scanResult.path,
    services: selected,
  });
  if (result.error) { toast(result.error, 'error'); return; }
  config.projects.push(result);
  closeModal('scanModal');
  scanResult = null;
  render();
  toast(`已导入项目「${name}」`, 'success');
}

// ============ Unmanaged Services ============
let unmanagedServices = [];
let unmanagedExpanded = new Set(); // expanded PIDs
let knownUnmanagedExpanded = false;
let editingNotePid = null; // PID currently being note-edited

async function scanUnmanaged() {
  const list = document.getElementById('unmanagedList');
  list.innerHTML = '<div style="padding:20px;color:var(--text-muted);">扫描中...</div>';
  const result = await api('/api/unmanaged');
  if (result.error) {
    list.innerHTML = `<div style="padding:20px;color:var(--red);">${escapeHtml(result.error)}</div>`;
    return;
  }
  unmanagedServices = result.services || [];
  renderUnmanaged();
}

function renderUnmanaged() {
  const list = document.getElementById('unmanagedList');
  if (unmanagedServices.length === 0) {
    list.innerHTML = '<div style="padding:20px;color:var(--text-muted);">✅ 没有发现未管理的服务</div>';
    return;
  }

  const activeServices = unmanagedServices.filter(s => !s.hidden);
  const knownServices = unmanagedServices.filter(s => s.hidden);
  const summaryHtml = `
    <div class="unmanaged-summary">
      <span>需要关注 ${activeServices.length} 个</span>
      <span>已知 ${knownServices.length} 个</span>
      ${activeServices.length > 0 ? `<button class="btn btn-sm" onclick="hideAllVisibleUnmanaged()">全部折叠为已知</button>` : ''}
    </div>
  `;
  const activeHtml = activeServices.length
    ? activeServices.map(s => renderUnmanagedRow(s)).join('')
    : '<div style="padding:20px;color:var(--text-muted);">没有需要关注的未管理服务</div>';
  const knownHtml = knownServices.length
    ? `
      <div class="known-unmanaged-section">
        <div class="known-unmanaged-header" onclick="toggleKnownUnmanaged()">
          <span class="hidden-projects-toggle">${knownUnmanagedExpanded ? '▼' : '▶'}</span>
          <span class="hidden-projects-title">已知服务 (${knownServices.length})</span>
          <span class="hidden-projects-hint">${knownUnmanagedExpanded ? '点击折叠' : '点击展开'}</span>
        </div>
        ${knownUnmanagedExpanded ? knownServices.map(s => renderUnmanagedRow(s, true)).join('') : ''}
      </div>
    `
    : '';

  list.innerHTML = summaryHtml + activeHtml + knownHtml;

  // Focus the note input when entering edit mode
  if (editingNotePid !== null) {
    const input = document.getElementById(`noteInput-${editingNotePid}`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function renderUnmanagedRow(s, isKnown = false) {
  const isExpanded = unmanagedExpanded.has(s.pid);
  const isEditingNote = editingNotePid === s.pid;
  const portUrl = `http://localhost:${s.port}`;
  const iconUrl = s.iconUrl || detectTechIcon(s.fullCommand || s.command);
  const etimeStr = s.etime ? `<span class="unmanaged-etime">⏱ ${escapeHtml(s.etime)}</span>` : '';
  const selfBadge = s.isSelf ? `<span class="unmanaged-self-badge" title="这是 Service Manager 自身，不可在此停止">本管理器</span>` : '';
  const noteHtml = isEditingNote
    ? `<input class="unmanaged-note-input" id="noteInput-${s.pid}" value="${escapeHtml(s.note || '')}" placeholder="添加备注，回车保存" onclick="event.stopPropagation()" onkeydown="noteKeydown(event, ${s.pid})" onblur="saveUnmanagedNote(${s.pid})">`
    : (s.note ? `<span class="unmanaged-note" title="点击编辑备注" onclick="event.stopPropagation(); editUnmanagedNote(${s.pid})">📝 ${escapeHtml(s.note)}</span>` : '');
  return `
    <div class="unmanaged-row${isKnown ? ' unmanaged-row-known' : ''}">
      <div class="unmanaged-row-header" onclick="toggleUnmanagedDetail(${s.pid})">
        <div class="status-dot running"></div>
        <img class="unmanaged-icon" src="${iconUrl}" alt=""${s.appName ? ` title="${escapeHtml(s.appName)}"` : ''} onerror="this.src='/icons/tech/generic.svg'">
        <span class="unmanaged-name">${escapeHtml(s.command)}</span>
        <a href="${portUrl}" target="_blank" class="unmanaged-port" onclick="event.stopPropagation()">🔗 :${s.port}</a>
        <span class="unmanaged-pid">PID ${s.pid}</span>
        ${etimeStr}
        <span class="unmanaged-user">${escapeHtml(s.user)}</span>
        ${selfBadge}
        ${noteHtml}
        <div class="unmanaged-actions">
          ${iconBtn('note', `editUnmanagedNote(${s.pid}); event.stopPropagation();`, '添加/编辑备注')}
          ${iconBtn('logs', `toggleUnmanagedDetail(${s.pid}); event.stopPropagation();`, isExpanded ? '收起详情' : '查看详情')}
          ${isKnown
            ? iconBtn('show', `setUnmanagedKnown('${s.hiddenKey}', false); event.stopPropagation();`, '放回未管理服务')
            : iconBtn('hide', `setUnmanagedKnown('${s.hiddenKey}', true); event.stopPropagation();`, '折叠到已知服务')
          }
          ${s.isSelf ? '' : `<button class="btn btn-sm btn-danger" onclick="killUnmanaged(${s.pid}); event.stopPropagation();">停止</button>`}
        </div>
      </div>
      ${isExpanded ? `<div class="unmanaged-detail"><label>完整命令</label><code>${escapeHtml(s.fullCommand || s.command)}</code></div>` : ''}
    </div>
  `;
}

function editUnmanagedNote(pid) {
  editingNotePid = pid;
  renderUnmanaged();
}

function noteKeydown(event, pid) {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveUnmanagedNote(pid);
  } else if (event.key === 'Escape') {
    editingNotePid = null;
    renderUnmanaged();
  }
}

async function saveUnmanagedNote(pid) {
  if (editingNotePid !== pid) return; // already saved via Enter
  const input = document.getElementById(`noteInput-${pid}`);
  const note = input ? input.value.trim() : '';
  editingNotePid = null;
  const s = unmanagedServices.find(x => x.pid === pid);
  const oldNote = s ? (s.note || '') : '';
  if (note === oldNote) { renderUnmanaged(); return; }
  const result = await api('/api/unmanaged/note', 'POST', { pid, note });
  if (result.error) { toast(result.error, 'error'); renderUnmanaged(); return; }
  if (s) s.note = note;
  renderUnmanaged();
}

function toggleUnmanagedDetail(pid) {
  if (unmanagedExpanded.has(pid)) unmanagedExpanded.delete(pid);
  else unmanagedExpanded.add(pid);
  renderUnmanaged();
}

function toggleKnownUnmanaged() {
  knownUnmanagedExpanded = !knownUnmanagedExpanded;
  renderUnmanaged();
}

async function setUnmanagedKnown(key, hidden) {
  const result = await api('/api/unmanaged/hidden', 'POST', { key, hidden });
  if (result.error) { toast(result.error, 'error'); return; }
  for (const s of unmanagedServices) {
    if (s.hiddenKey === key) s.hidden = hidden;
  }
  if (!hidden) knownUnmanagedExpanded = true;
  renderUnmanaged();
  toast(hidden ? '已折叠到已知服务' : '已放回未管理服务', hidden ? 'info' : 'success');
}

async function hideAllVisibleUnmanaged() {
  const activeServices = unmanagedServices.filter(s => !s.hidden);
  if (activeServices.length === 0) return;
  if (!confirm(`确定把当前 ${activeServices.length} 个未管理服务全部折叠到已知服务？`)) return;

  let changed = 0;
  for (const s of activeServices) {
    const result = await api('/api/unmanaged/hidden', 'POST', { key: s.hiddenKey, hidden: true });
    if (result.error) {
      toast(result.error, 'error');
      break;
    }
    s.hidden = true;
    changed++;
  }
  knownUnmanagedExpanded = true;
  renderUnmanaged();
  toast(`已折叠 ${changed} 个服务`, 'success');
}

async function killUnmanaged(pid) {
  if (!confirm(`确定停止进程 PID ${pid}？`)) return;
  const result = await api('/api/unmanaged/kill', 'POST', { pid });
  if (result.error) { toast(result.error, 'error'); return; }
  toast(`进程 ${pid} 正在停止...`, 'success');
  // Re-scan after a short delay
  setTimeout(scanUnmanaged, 1000);
}

// ============ Init ============
async function init() {
  appHealth = await api('/api/health');
  if (appHealth.error) toast(appHealth.error, 'error');
  config = await api('/api/config');
  if (config.error) {
    toast(config.error, 'error');
    config = { projects: [] };
  }
  statuses = await api('/api/statuses');
  if (statuses.error) {
    toast(statuses.error, 'error');
    statuses = {};
  }
  render();
  connectWebSocket();

  // Header buttons
  document.getElementById('addProjectBtn').onclick = () => showProjectModal();
  document.getElementById('scanProjectBtn').onclick = () => scanProjectFromFolder();
  document.getElementById('startAllBtn').onclick = () => startAllGlobal();
  document.getElementById('unmanagedRefresh').onclick = () => scanUnmanaged();
  scanUnmanaged();

  // Modal save buttons
  document.getElementById('saveProjectBtn').onclick = saveProject;
  document.getElementById('saveServiceBtn').onclick = saveService;
  document.getElementById('importScanBtn').onclick = importScanResult;

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
