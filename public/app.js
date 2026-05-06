'use strict';

const token = new URLSearchParams(window.location.search).get('token') || '';
const state = {
  data: null,
  selectedProjects: new Set(),
  selectedThreads: new Set(),
  excludedThreads: new Set(),
  planId: null,
};

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  return fetch(`/api/${path}${separator}token=${encodeURIComponent(token)}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  }).then(async (res) => {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function getOptions() {
  return {
    pinProjects: $('pinProjects').checked,
    pinThreads: $('pinThreads').checked,
    touchTargets: $('touchTargets').checked,
    migrateProvider: $('migrateProvider').checked,
    restoreArchived: $('restoreArchived').checked,
    quitCodex: $('quitCodex').checked,
    launchCodex: $('launchCodex').checked,
  };
}

function setReport(value) {
  $('reportBox').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function showError(message) {
  const box = $('errorBox');
  if (!message) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
}

async function loadState() {
  showError('');
  $('refreshBtn').disabled = true;
  try {
    const data = await api('state');
    state.data = data;
    if (state.selectedProjects.size === 0 && state.selectedThreads.size === 0) {
      for (const project of data.projects) {
        if (project.cwd.endsWith('/algo') || project.cwd.endsWith('/fct')) {
          state.selectedProjects.add(project.cwd);
        }
      }
    }
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function render() {
  const data = state.data;
  if (!data) return;

  $('codexHome').textContent = data.codexHome || '-';
  $('provider').textContent = data.provider || '-';
  $('codexRunning').textContent = data.codexRunning ? '运行中' : '未运行';
  $('sqliteStatus').textContent = data.environment.sqliteAvailable ? '可用' : '缺失';

  if (data.error) showError(data.error);
  else if (!data.environment.ok) showError(`缺少必要的 Codex 文件或工具：${data.environment.missing.join(', ') || 'sqlite3 不可用'}`);
  else showError('');

  renderProjects();
  renderThreads();
  updateSelectionCount();
}

function visibleProjects() {
  const query = $('searchInput').value.trim().toLowerCase();
  const data = state.data;
  if (!data) return [];
  if (!query) return data.projects;
  const threadProjectHits = new Set(
    data.threads
      .filter((thread) => matchesThread(thread, query))
      .map((thread) => thread.cwd),
  );
  return data.projects.filter((project) => project.cwd.toLowerCase().includes(query) || threadProjectHits.has(project.cwd));
}

function matchesThread(thread, query) {
  return [
    thread.id,
    thread.cwd,
    thread.title,
    thread.model_provider,
    thread.model,
  ].some((value) => String(value || '').toLowerCase().includes(query));
}

function renderProjects() {
  const list = $('projectsList');
  const projects = visibleProjects();
  if (!projects.length) {
    list.innerHTML = '<div class="project-row muted">没有找到项目。</div>';
    return;
  }

  list.innerHTML = projects.map((project) => {
    const checked = state.selectedProjects.has(project.cwd) ? 'checked' : '';
    const disabled = project.restorable === 0 && project.archivedRestorable === 0 ? 'disabled' : '';
    return `
      <div class="project-row">
        <div class="project-main">
          <input type="checkbox" data-project="${escapeHtml(project.cwd)}" ${checked} ${disabled}>
          <div class="project-text">
            <div class="project-path">${escapeHtml(project.cwd || '（空项目路径）')}</div>
            <div class="meta">
              <span class="pill good">${project.restorable} 可恢复</span>
              <span class="pill">${project.total} 总会话</span>
              <span class="pill warn">${project.archived} 已归档</span>
              <span class="pill">${project.subagents} 子代理</span>
              ${project.inSidebar ? '<span class="pill good">已在侧边栏</span>' : '<span class="pill">不在侧边栏</span>'}
              ${project.pinned ? '<span class="pill good">已置顶</span>' : ''}
              ${project.existsOnDisk ? '' : '<span class="pill bad">目录不存在</span>'}
              <span>${formatDate(project.lastUpdatedIso)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('input[data-project]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selectedProjects.add(input.dataset.project);
      else state.selectedProjects.delete(input.dataset.project);
      clearThreadOverridesForProject(input.dataset.project);
      state.planId = null;
      $('applyBtn').disabled = true;
      renderThreads();
      updateSelectionCount();
    });
  });
}

function visibleThreads() {
  const data = state.data;
  if (!data) return [];
  const query = $('searchInput').value.trim().toLowerCase();
  const showArchived = $('showArchived').checked || $('restoreArchived').checked;
  return data.threads.filter((thread) => {
    if (!showArchived && thread.archived) return false;
    if (query && !matchesThread(thread, query)) return false;
    if (state.selectedProjects.size > 0 && !state.selectedProjects.has(thread.cwd) && !state.selectedThreads.has(thread.id)) {
      return false;
    }
    return true;
  });
}

function threadSelectable(thread) {
  if (!thread.isVscode || !thread.hasUserEvent) return false;
  if (thread.archived && !$('restoreArchived').checked) return false;
  return true;
}

function renderThreads() {
  const list = $('threadsList');
  const threads = visibleThreads();
  if (!threads.length) {
    list.innerHTML = '<div class="thread-row muted">没有符合当前筛选条件的会话。</div>';
    return;
  }

  list.innerHTML = threads.map((thread) => {
    const selectable = threadSelectable(thread);
    const checked = isThreadRequested(thread) ? 'checked' : '';
    const disabled = selectable ? '' : 'disabled';
    const statusClass = thread.archived ? 'warn' : thread.isSubagent ? 'bad' : 'good';
    const status = thread.archived ? '已归档' : thread.isSubagent ? '子代理' : '活跃';
    return `
      <div class="thread-row">
        <div class="thread-main">
          <input type="checkbox" data-thread="${escapeHtml(thread.id)}" ${checked} ${disabled}>
          <div class="thread-text">
            <div class="thread-title">${escapeHtml(thread.title || '未命名会话')}</div>
            <div class="meta">
              <span class="pill ${statusClass}">${status}</span>
              <span class="pill">${escapeHtml(thread.model_provider || 'provider?')}</span>
              ${thread.model ? `<span class="pill">${escapeHtml(thread.model)}</span>` : ''}
              <span>${formatDate(thread.updatedIso)}</span>
              <span>${escapeHtml(thread.id)}</span>
            </div>
            <div class="muted">${escapeHtml(thread.cwd)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('input[data-thread]').forEach((input) => {
    input.addEventListener('change', () => {
      const thread = state.data.threads.find((item) => item.id === input.dataset.thread);
      if (input.checked) {
        state.selectedThreads.add(input.dataset.thread);
        state.excludedThreads.delete(input.dataset.thread);
      } else {
        state.selectedThreads.delete(input.dataset.thread);
        if (thread && state.selectedProjects.has(thread.cwd)) state.excludedThreads.add(input.dataset.thread);
      }
      state.planId = null;
      $('applyBtn').disabled = true;
      updateSelectionCount();
    });
  });
}

function effectiveSelection() {
  if (!state.data) return { projectCwds: [], threadIds: [] };
  const extraThreadIds = state.data.threads
    .filter((thread) => isThreadRequested(thread))
    .map((thread) => thread.id);
  return {
    projectCwds: [],
    threadIds: extraThreadIds,
  };
}

function updateSelectionCount() {
  const data = state.data;
  if (!data) return;
  const options = getOptions();
  const projectSet = state.selectedProjects;
  const threadSet = state.selectedThreads;
  const selected = data.threads.filter((thread) => {
    const requested = (projectSet.has(thread.cwd) && !state.excludedThreads.has(thread.id)) || threadSet.has(thread.id);
    if (!requested) return false;
    if (!thread.isVscode || !thread.hasUserEvent) return false;
    if (thread.archived && !options.restoreArchived) return false;
    return true;
  });
  $('selectionCount').textContent = `已选择 ${selected.length} 个`;
}

async function preview() {
  state.planId = null;
  $('applyBtn').disabled = true;
  $('previewBtn').disabled = true;
  setReport('正在生成预览...');
  try {
    const result = await api('preview', {
      method: 'POST',
      body: JSON.stringify({
        selection: effectiveSelection(),
        options: getOptions(),
      }),
    });
    state.planId = result.planId;
    $('applyBtn').disabled = result.preview.selected.threadCount === 0;
    setReport(result.preview);
  } catch (error) {
    showError(error.message);
    setReport(error.message);
  } finally {
    $('previewBtn').disabled = false;
  }
}

async function applyRestore() {
  if (!state.planId) return;
  const ok = window.confirm('确定执行这次恢复吗？工具会先退出 Codex、创建备份，然后写入侧边栏状态。');
  if (!ok) return;
  $('applyBtn').disabled = true;
  $('previewBtn').disabled = true;
  setReport('正在执行恢复...');
  try {
    const result = await api('apply', {
      method: 'POST',
      body: JSON.stringify({ planId: state.planId }),
    });
    state.planId = null;
    setReport(result.report);
    await loadState();
  } catch (error) {
    showError(error.message);
    setReport(error.message);
  } finally {
    $('previewBtn').disabled = false;
  }
}

function bindEvents() {
  $('refreshBtn').addEventListener('click', loadState);
  $('searchInput').addEventListener('input', render);
  $('showArchived').addEventListener('change', renderThreads);
  $('restoreArchived').addEventListener('change', () => {
    $('showArchived').checked = $('showArchived').checked || $('restoreArchived').checked;
    state.planId = null;
    $('applyBtn').disabled = true;
    renderThreads();
    updateSelectionCount();
  });
  for (const id of ['pinProjects', 'pinThreads', 'touchTargets', 'migrateProvider', 'quitCodex', 'launchCodex']) {
    $(id).addEventListener('change', () => {
      state.planId = null;
      $('applyBtn').disabled = true;
      updateSelectionCount();
    });
  }
  $('clearSelectionBtn').addEventListener('click', () => {
    state.selectedProjects.clear();
    state.selectedThreads.clear();
    state.excludedThreads.clear();
    state.planId = null;
    $('applyBtn').disabled = true;
    render();
  });
  $('previewBtn').addEventListener('click', preview);
  $('applyBtn').addEventListener('click', applyRestore);
}

bindEvents();
loadState();

function isThreadRequested(thread) {
  return (state.selectedProjects.has(thread.cwd) && !state.excludedThreads.has(thread.id))
    || state.selectedThreads.has(thread.id);
}

function clearThreadOverridesForProject(project) {
  if (!state.data) return;
  for (const thread of state.data.threads) {
    if (thread.cwd !== project) continue;
    state.selectedThreads.delete(thread.id);
    state.excludedThreads.delete(thread.id);
  }
}
