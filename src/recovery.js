'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DEFAULT_OPTIONS = {
  pinProjects: true,
  pinThreads: true,
  touchTargets: true,
  migrateProvider: true,
  restoreArchived: false,
  launchCodex: true,
  quitCodex: true,
};

function codexPaths(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  return {
    codexHome,
    configPath: path.join(codexHome, 'config.toml'),
    dbPath: path.join(codexHome, 'state_5.sqlite'),
    globalStatePath: path.join(codexHome, '.codex-global-state.json'),
    sessionIndexPath: path.join(codexHome, 'session_index.jsonl'),
    backupRoot: path.join(codexHome, 'repair_backups'),
  };
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function trySh(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function sqliteAvailable() {
  const result = trySh('sqlite3', ['-version']);
  return result.status === 0;
}

function sqliteJson(paths, sql) {
  const out = sh('sqlite3', ['-json', paths.dbPath, sql], { maxBuffer: 100 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

function sqliteExec(paths, sql) {
  return sh('sqlite3', [paths.dbPath, sql], { maxBuffer: 100 * 1024 * 1024 });
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function unique(items) {
  const output = [];
  const seen = new Set();
  for (const item of items || []) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  return output;
}

function frontUnique(existing, front) {
  const existingIds = Array.isArray(existing) ? existing : [];
  return unique([...(front || []), ...existingIds]);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function threadOrder(ids) {
  return { threadIds: unique(ids) };
}

function threadIdsFromOrder(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.threadIds)) return value.threadIds;
  return [];
}

function shortText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function isoFromMs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function rowUpdatedMs(row) {
  return Number(row.updated_at_ms || (row.updated_at * 1000) || 0);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readCurrentProvider(paths) {
  try {
    const text = fs.readFileSync(paths.configPath, 'utf8');
    const match = text.match(/^model_provider\s*=\s*"([^"]+)"/m);
    return match ? match[1] : 'freecoding';
  } catch {
    return 'freecoding';
  }
}

function codexProcesses() {
  const result = trySh('pgrep', ['-fl', '/Applications/Codex.app|Codex Helper|Codex.app|codex app-server']);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('codex-sidebar-recovery'));
}

function waitUntilNoCodex(deadlineMs) {
  while (Date.now() < deadlineMs) {
    const running = codexProcesses();
    if (running.length === 0) return [];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return codexProcesses();
}

function quitCodexApp() {
  trySh('osascript', ['-e', 'tell application "Codex" to quit']);
  let running = waitUntilNoCodex(Date.now() + 8000);
  if (running.length === 0) return { ok: true, running: [] };

  for (const line of running) {
    const pid = Number(line.split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 1) trySh('kill', ['-TERM', String(pid)]);
  }

  running = waitUntilNoCodex(Date.now() + 5000);
  if (running.length === 0) return { ok: true, running: [] };

  for (const line of running) {
    const pid = Number(line.split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 1) trySh('kill', ['-KILL', String(pid)]);
  }

  running = waitUntilNoCodex(Date.now() + 3000);
  return { ok: running.length === 0, running };
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    trySh('open', [url], { stdio: 'ignore' });
    return;
  }
  if (process.platform === 'win32') {
    trySh('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    return;
  }
  trySh('xdg-open', [url], { stdio: 'ignore' });
}

function launchCodex() {
  if (process.platform === 'darwin') trySh('open', ['-a', 'Codex'], { stdio: 'ignore' });
}

function validateEnvironment(paths) {
  const missing = [];
  if (!fs.existsSync(paths.codexHome)) missing.push(paths.codexHome);
  if (!fs.existsSync(paths.dbPath)) missing.push(paths.dbPath);
  if (!fs.existsSync(paths.globalStatePath)) missing.push(paths.globalStatePath);
  return {
    sqliteAvailable: sqliteAvailable(),
    missing,
    ok: missing.length === 0 && sqliteAvailable(),
  };
}

function getAllThreads(paths) {
  return sqliteJson(paths, `
    SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
           has_user_event, archived, archived_at, first_user_message, agent_nickname,
           agent_role, model, reasoning_effort, created_at_ms, updated_at_ms
    FROM threads
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC
  `).map(normalizeThreadRow);
}

function normalizeThreadRow(row) {
  const source = String(row.source || '');
  const archived = Number(row.archived) === 1;
  const hasUserEvent = Number(row.has_user_event) === 1;
  const isVscode = source === 'vscode';
  const isSubagent = !isVscode;
  const updatedMs = rowUpdatedMs(row);
  return {
    ...row,
    title: shortText(row.title || row.first_user_message || 'Untitled', 220),
    cwd: row.cwd || '',
    source,
    archived,
    hasUserEvent,
    isVscode,
    isSubagent,
    restorable: isVscode && hasUserEvent && !archived,
    archivedRestorable: isVscode && hasUserEvent && archived,
    updatedMs,
    updatedIso: isoFromMs(updatedMs),
    createdIso: isoFromMs(row.created_at_ms || (row.created_at * 1000)),
  };
}

function buildProjectSummary(threads, state) {
  const orders = objectValue(state['sidebar-project-thread-orders']);
  const pinnedProjects = new Set(Array.isArray(state['pinned-project-ids']) ? state['pinned-project-ids'] : []);
  const savedRoots = new Set(Array.isArray(state['electron-saved-workspace-roots']) ? state['electron-saved-workspace-roots'] : []);
  const activeRoots = new Set(Array.isArray(state['active-workspace-roots']) ? state['active-workspace-roots'] : []);
  const byProject = new Map();

  for (const thread of threads) {
    if (!byProject.has(thread.cwd)) {
      byProject.set(thread.cwd, {
        cwd: thread.cwd,
        total: 0,
        active: 0,
        restorable: 0,
        archived: 0,
        archivedRestorable: 0,
        subagents: 0,
        lastUpdatedMs: 0,
      });
    }
    const project = byProject.get(thread.cwd);
    project.total += 1;
    if (!thread.archived) project.active += 1;
    if (thread.restorable) project.restorable += 1;
    if (thread.archived) project.archived += 1;
    if (thread.archivedRestorable) project.archivedRestorable += 1;
    if (thread.isSubagent) project.subagents += 1;
    project.lastUpdatedMs = Math.max(project.lastUpdatedMs, thread.updatedMs);
  }

  return Array.from(byProject.values())
    .map((project) => ({
      ...project,
      lastUpdatedIso: isoFromMs(project.lastUpdatedMs),
      existsOnDisk: project.cwd ? fs.existsSync(project.cwd) : false,
      inSidebar: threadIdsFromOrder(orders[project.cwd]).length > 0,
      pinned: pinnedProjects.has(project.cwd),
      savedWorkspaceRoot: savedRoots.has(project.cwd),
      activeWorkspaceRoot: activeRoots.has(project.cwd),
    }))
    .sort((a, b) => {
      if (a.restorable !== b.restorable) return b.restorable - a.restorable;
      if (a.active !== b.active) return b.active - a.active;
      if (a.lastUpdatedMs !== b.lastUpdatedMs) return b.lastUpdatedMs - a.lastUpdatedMs;
      return a.cwd.localeCompare(b.cwd);
    });
}

function getStateSnapshot(codexHome) {
  const paths = codexPaths(codexHome);
  const environment = validateEnvironment(paths);
  const provider = readCurrentProvider(paths);
  const running = codexProcesses();
  const state = readJson(paths.globalStatePath, {});
  let threads = [];
  let projects = [];
  let error = null;

  if (environment.ok) {
    try {
      threads = getAllThreads(paths);
      projects = buildProjectSummary(threads, state);
    } catch (e) {
      error = e.message;
    }
  }

  return {
    codexHome: paths.codexHome,
    provider,
    platform: process.platform,
    paths: {
      dbPath: paths.dbPath,
      globalStatePath: paths.globalStatePath,
      sessionIndexPath: paths.sessionIndexPath,
      backupRoot: paths.backupRoot,
    },
    environment,
    codexRunning: running.length > 0,
    codexProcesses: running,
    sidebar: summarizeSidebarState(state),
    projects,
    threads,
    error,
  };
}

function summarizeSidebarState(state) {
  return {
    pinnedProjects: Array.isArray(state['pinned-project-ids']) ? state['pinned-project-ids'] : [],
    pinnedThreadIds: threadIdsFromOrder(state['pinned-thread-ids']),
    chatThreadOrderCount: threadIdsFromOrder(state['sidebar-chat-thread-order']).length,
    organizeMode: state['persisted-atom-state']?.['sidebar-organize-mode-v1'] || null,
    workspaceFilter: state['persisted-atom-state']?.['sidebar-workspace-filter-v2'] || null,
  };
}

function normalizeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => typeof value === 'boolean' || typeof value === 'string'),
    ),
  };
}

function resolveSelection(threads, selection = {}, options = {}) {
  const selectedProjects = new Set(Array.isArray(selection.projectCwds) ? selection.projectCwds : []);
  const selectedThreadIds = new Set(Array.isArray(selection.threadIds) ? selection.threadIds : []);
  const restoreArchived = options.restoreArchived === true;

  const included = [];
  const skipped = [];

  for (const thread of threads) {
    const requested = selectedThreadIds.has(thread.id) || selectedProjects.has(thread.cwd);
    if (!requested) continue;

    if (!thread.isVscode) {
      skipped.push({ id: thread.id, cwd: thread.cwd, reason: 'subagent_or_non_vscode' });
      continue;
    }
    if (!thread.hasUserEvent) {
      skipped.push({ id: thread.id, cwd: thread.cwd, reason: 'no_user_event' });
      continue;
    }
    if (thread.archived && !restoreArchived) {
      skipped.push({ id: thread.id, cwd: thread.cwd, reason: 'archived' });
      continue;
    }
    included.push(thread);
  }

  included.sort((a, b) => {
    if (a.cwd !== b.cwd) return a.cwd.localeCompare(b.cwd);
    if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs;
    return b.id.localeCompare(a.id);
  });

  return { included, skipped };
}

function makePreview(codexHome, selection, rawOptions) {
  const paths = codexPaths(codexHome);
  const environment = validateEnvironment(paths);
  if (!environment.ok) {
    throw new Error(`无法读取 Codex 状态：${environment.missing.join(', ') || 'sqlite3 不可用'}`);
  }

  const options = normalizeOptions(rawOptions);
  const provider = readCurrentProvider(paths);
  const state = readJson(paths.globalStatePath, {});
  const threads = getAllThreads(paths);
  const { included, skipped } = resolveSelection(threads, selection, options);
  const selectedIds = included.map((thread) => thread.id);
  const selectedProjects = unique(included.map((thread) => thread.cwd));
  const providerMigrations = options.migrateProvider
    ? included.filter((thread) => thread.model_provider !== provider)
    : [];
  const archivedToRestore = included.filter((thread) => thread.archived);
  const touchTargets = options.touchTargets
    ? included.filter((thread) => !thread.archived || options.restoreArchived)
    : [];
  const orders = objectValue(state['sidebar-project-thread-orders']);
  const missingOrder = included.filter((thread) => !threadIdsFromOrder(orders[thread.cwd]).includes(thread.id));
  const pinnedThreadIds = new Set(threadIdsFromOrder(state['pinned-thread-ids']));
  const pinnedProjectIds = new Set(Array.isArray(state['pinned-project-ids']) ? state['pinned-project-ids'] : []);

  return {
    createdAt: new Date().toISOString(),
    codexHome: paths.codexHome,
    provider,
    options,
    selection: {
      projectCwds: Array.isArray(selection.projectCwds) ? selection.projectCwds : [],
      threadIds: Array.isArray(selection.threadIds) ? selection.threadIds : [],
    },
    selected: {
      projects: selectedProjects,
      threadIds: selectedIds,
      threadCount: included.length,
      threads: included.map((thread) => ({
        id: thread.id,
        cwd: thread.cwd,
        title: thread.title,
        archived: thread.archived,
        modelProvider: thread.model_provider,
        updatedIso: thread.updatedIso,
      })),
    },
    skipped,
    impact: {
      providerMigrations: providerMigrations.length,
      archivedToRestore: archivedToRestore.length,
      touchTargets: touchTargets.length,
      missingProjectOrders: missingOrder.length,
      projectsToPin: options.pinProjects
        ? selectedProjects.filter((project) => !pinnedProjectIds.has(project)).length
        : 0,
      threadsToPin: options.pinThreads
        ? selectedIds.filter((id) => !pinnedThreadIds.has(id)).length
        : 0,
    },
    warnings: buildPreviewWarnings(included, skipped),
  };
}

function buildPreviewWarnings(included, skipped) {
  const warnings = [];
  if (included.length === 0) warnings.push('还没有选择可恢复的会话。');
  if (skipped.some((item) => item.reason === 'archived')) {
    warnings.push('已跳过归档会话。如果要恢复它们，请勾选“恢复已归档”。');
  }
  if (skipped.some((item) => item.reason === 'subagent_or_non_vscode')) {
    warnings.push('子代理或非主会话只作为参考展示，不会恢复到主侧边栏。');
  }
  return warnings;
}

function makeBackup(paths, rows) {
  const backupDir = path.join(paths.backupRoot, `sidebar-recovery-${timestamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(paths.globalStatePath, path.join(backupDir, 'codex-global-state.before.json'));
  if (fs.existsSync(paths.sessionIndexPath)) {
    fs.copyFileSync(paths.sessionIndexPath, path.join(backupDir, 'session_index.before.jsonl'));
  }
  const sqliteBackupPath = path.join(backupDir, 'state_5.before.sqlite');
  sh('sqlite3', [paths.dbPath, `.backup '${sqliteBackupPath.replace(/'/g, "''")}'`]);

  const rolloutBackupDir = path.join(backupDir, 'rollouts');
  for (const row of rows) {
    if (!row.rollout_path || !fs.existsSync(row.rollout_path)) continue;
    fs.mkdirSync(rolloutBackupDir, { recursive: true });
    fs.copyFileSync(row.rollout_path, path.join(rolloutBackupDir, `${row.id}.jsonl`));
  }
  return backupDir;
}

function updateProviders(paths, rows, provider) {
  const toChange = rows.filter((row) => row.model_provider !== provider);
  if (!toChange.length) return { dbChanged: 0, fileChanged: 0, fileSkipped: 0 };
  const ids = toChange.map((row) => sqlQuote(row.id)).join(',');
  sqliteExec(paths, `
    UPDATE threads
    SET model_provider = ${sqlQuote(provider)}
    WHERE id IN (${ids});
  `);

  let fileChanged = 0;
  let fileSkipped = 0;
  for (const row of toChange) {
    if (updateRolloutMeta(row.rollout_path, (meta) => {
      if (!meta.payload) return false;
      meta.payload.model_provider = provider;
      return true;
    })) fileChanged += 1;
    else fileSkipped += 1;
  }
  return { dbChanged: toChange.length, fileChanged, fileSkipped };
}

function restoreArchivedThreads(paths, rows) {
  const archived = rows.filter((row) => row.archived);
  if (!archived.length) return { changed: 0 };
  const ids = archived.map((row) => sqlQuote(row.id)).join(',');
  sqliteExec(paths, `
    UPDATE threads
    SET archived = 0, archived_at = NULL
    WHERE id IN (${ids});
  `);
  return { changed: archived.length };
}

function touchThreads(paths, rows) {
  if (!rows.length) return [];
  const sorted = rows.slice().sort((a, b) => {
    if (a.cwd !== b.cwd) return a.cwd.localeCompare(b.cwd);
    if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs;
    return b.id.localeCompare(a.id);
  });
  const nowMs = Date.now();
  const updates = sorted.map((row, index) => {
    const newUpdatedAtMs = nowMs - index * 1000;
    return {
      id: row.id,
      cwd: row.cwd,
      title: row.title,
      oldUpdatedAt: row.updated_at,
      oldUpdatedAtMs: row.updated_at_ms,
      oldUpdatedIso: isoFromMs(rowUpdatedMs(row)),
      newUpdatedAt: Math.floor(newUpdatedAtMs / 1000),
      newUpdatedAtMs,
      newUpdatedIso: new Date(newUpdatedAtMs).toISOString(),
    };
  });

  sqliteExec(paths, `BEGIN IMMEDIATE;\n${updates.map((update) => `
    UPDATE threads
    SET updated_at = ${Number(update.newUpdatedAt)},
        updated_at_ms = ${Number(update.newUpdatedAtMs)}
    WHERE id = ${sqlQuote(update.id)};
  `).join('\n')}\nCOMMIT;`);

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const update of updates) {
    const row = byId.get(update.id);
    updateRolloutMeta(row?.rollout_path, (meta) => {
      meta.timestamp = update.newUpdatedIso;
      meta.payload = objectValue(meta.payload);
      meta.payload.timestamp = update.newUpdatedIso;
      meta.payload.cwd = row.cwd;
      return true;
    });
  }
  return updates;
}

function updateRolloutMeta(file, update) {
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const nl = text.indexOf('\n');
  const first = nl >= 0 ? text.slice(0, nl) : text;
  const rest = nl >= 0 ? text.slice(nl) : '';
  let meta;
  try {
    meta = JSON.parse(first);
  } catch {
    return false;
  }
  if (meta.type !== 'session_meta') return false;
  if (!update(meta)) return false;
  fs.writeFileSync(file, JSON.stringify(meta) + rest, 'utf8');
  return true;
}

function rebuildSessionIndex(paths) {
  const rows = sqliteJson(paths, `
    SELECT id, title, updated_at, updated_at_ms
    FROM threads
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) ASC, id ASC
  `);
  const lines = rows.map((row) => JSON.stringify({
    id: row.id,
    thread_name: row.title || 'Untitled',
    updated_at: isoFromMs(rowUpdatedMs(row)) || new Date().toISOString(),
  }));
  fs.writeFileSync(paths.sessionIndexPath, lines.join('\n') + '\n', 'utf8');
  return rows.length;
}

function setSidebarAtoms(state, projectCwds) {
  const write = (key) => {
    state[key] = objectValue(state[key]);
    state[key]['sidebar-workspace-filter-v2'] = 'all';
    state[key]['sidebar-organize-mode-v1'] = 'project';
    state[key]['sidebar-keep-projects-in-recent-v1'] = true;
    state[key]['projectless-sidebar-chats-first-v1'] = false;
    state[key]['thread-sort-key'] = 'updated_at';
    state[key]['sidebar-move-updated-threads-in-front-v1'] = true;
    state[key]['sidebar-history-show'] = 'all';
    state[key]['sidebar-history-organize'] = 'project';
    state[key]['organize-mode-v1'] = 'project';

    const collapsedGroups = objectValue(state[key]['sidebar-collapsed-groups']);
    for (const project of projectCwds) delete collapsedGroups[project];
    state[key]['sidebar-collapsed-groups'] = collapsedGroups;
    state[key]['sidebar-collapsed-sections-v1'] = {
      ...objectValue(state[key]['sidebar-collapsed-sections-v1']),
      chats: false,
      pinned: false,
      threads: false,
    };
  };

  write('persisted-atom-state');
  write('electron-persisted-atom-state');
}

function rebuildGlobalState(paths, rows, options) {
  const state = readJson(paths.globalStatePath, {});
  state['sidebar-project-thread-orders'] = objectValue(state['sidebar-project-thread-orders']);
  state['thread-workspace-root-hints'] = objectValue(state['thread-workspace-root-hints']);

  for (const [project, order] of Object.entries(state['sidebar-project-thread-orders'])) {
    state['sidebar-project-thread-orders'][project] = threadOrder(threadIdsFromOrder(order));
  }

  const selectedIds = rows.map((row) => row.id);
  const selectedProjects = unique(rows.map((row) => row.cwd));
  const byProject = new Map();
  for (const row of rows) {
    if (!byProject.has(row.cwd)) byProject.set(row.cwd, []);
    byProject.get(row.cwd).push(row.id);
    state['thread-workspace-root-hints'][row.id] = row.cwd;
  }

  for (const [project, ids] of byProject.entries()) {
    state['sidebar-project-thread-orders'][project] = threadOrder(frontUnique(
      threadIdsFromOrder(state['sidebar-project-thread-orders'][project]),
      ids,
    ));
  }

  if (Array.isArray(state['projectless-thread-ids'])) {
    const selected = new Set(selectedIds);
    state['projectless-thread-ids'] = state['projectless-thread-ids'].filter((id) => !selected.has(id));
  }

  state['sidebar-chat-thread-order'] = threadOrder(frontUnique(
    threadIdsFromOrder(state['sidebar-chat-thread-order']),
    selectedIds,
  ));
  state['sidebar-custom-sections'] = Array.isArray(state['sidebar-custom-sections'])
    ? state['sidebar-custom-sections']
    : [];
  if (options.pinProjects) {
    state['pinned-project-ids'] = frontUnique(state['pinned-project-ids'], selectedProjects);
  } else if (!Array.isArray(state['pinned-project-ids'])) {
    state['pinned-project-ids'] = [];
  }
  if (options.pinThreads) {
    state['pinned-thread-ids'] = threadOrder(frontUnique(
      threadIdsFromOrder(state['pinned-thread-ids']),
      selectedIds,
    ));
  } else {
    state['pinned-thread-ids'] = threadOrder(threadIdsFromOrder(state['pinned-thread-ids']));
  }

  state['electron-saved-workspace-roots'] = frontUnique(state['electron-saved-workspace-roots'], selectedProjects);
  state['active-workspace-roots'] = frontUnique(state['active-workspace-roots'], selectedProjects);
  state['project-order'] = frontUnique(state['project-order'], selectedProjects);
  setSidebarAtoms(state, selectedProjects);

  fs.writeFileSync(paths.globalStatePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return { selectedProjects, selectedIds, byProject: Object.fromEntries(byProject.entries()) };
}

function verifyRestore(paths, selectedRows, options) {
  const state = readJson(paths.globalStatePath, {});
  const orders = objectValue(state['sidebar-project-thread-orders']);
  const hints = objectValue(state['thread-workspace-root-hints']);
  const pinnedThreadIds = new Set(threadIdsFromOrder(state['pinned-thread-ids']));
  const chatOrder = new Set(threadIdsFromOrder(state['sidebar-chat-thread-order']));
  const missingOrder = [];
  const badHint = [];
  const missingChatOrder = [];
  const missingPinned = [];

  for (const row of selectedRows) {
    if (!threadIdsFromOrder(orders[row.cwd]).includes(row.id)) missingOrder.push(row.id);
    if (hints[row.id] !== row.cwd) badHint.push(row.id);
    if (!chatOrder.has(row.id)) missingChatOrder.push(row.id);
    if (options.pinThreads && !pinnedThreadIds.has(row.id)) missingPinned.push(row.id);
  }

  return {
    selectedCount: selectedRows.length,
    pinnedThreadIdsShape: Array.isArray(state['pinned-thread-ids']) ? 'legacy-array' : typeof state['pinned-thread-ids'],
    sidebarChatThreadOrderShape: Array.isArray(state['sidebar-chat-thread-order']) ? 'legacy-array' : typeof state['sidebar-chat-thread-order'],
    missingOrder,
    badHint,
    missingChatOrder,
    missingPinned,
  };
}

function applyPreview(codexHome, preview) {
  const paths = codexPaths(codexHome);
  const environment = validateEnvironment(paths);
  if (!environment.ok) {
    throw new Error(`无法写入 Codex 状态：${environment.missing.join(', ') || 'sqlite3 不可用'}`);
  }

  const options = normalizeOptions(preview.options);
  if (options.quitCodex) {
    const quit = quitCodexApp();
    if (!quit.ok) {
      throw new Error(`尝试退出后 Codex 仍在运行：${quit.running.slice(0, 3).join(' | ')}`);
    }
  } else if (codexProcesses().length > 0) {
    throw new Error('Codex 正在运行。请勾选“写入前退出 Codex”，避免内存状态覆盖修复结果。');
  }

  const freshThreads = getAllThreads(paths);
  const selectedIds = new Set(preview.selected.threadIds);
  const rows = freshThreads.filter((thread) => selectedIds.has(thread.id));
  if (rows.length === 0) throw new Error('执行恢复时没有找到已选择的会话。');

  const provider = readCurrentProvider(paths);
  const backupDir = makeBackup(paths, rows);
  const restoredArchived = options.restoreArchived ? restoreArchivedThreads(paths, rows) : { changed: 0 };
  const providerUpdate = options.migrateProvider ? updateProviders(paths, rows, provider) : { dbChanged: 0, fileChanged: 0, fileSkipped: 0 };
  const timestampUpdate = options.touchTargets ? touchThreads(paths, rows) : [];
  const indexEntries = rebuildSessionIndex(paths);

  const refreshedRows = getAllThreads(paths).filter((thread) => selectedIds.has(thread.id) && !thread.archived);
  const sidebarUpdate = rebuildGlobalState(paths, refreshedRows, options);
  const verification = verifyRestore(paths, refreshedRows, options);
  const runningAfterWrite = codexProcesses();

  const report = {
    completedAt: new Date().toISOString(),
    backupDir,
    codexHome: paths.codexHome,
    provider,
    options,
    selectedThreadCount: rows.length,
    restoredArchived,
    providerUpdate,
    timestampUpdate: {
      enabled: options.touchTargets,
      changed: timestampUpdate.length,
      rows: timestampUpdate,
    },
    sessionIndexEntries: indexEntries,
    sidebarUpdate,
    verification,
    codexProcessesAfterWrite: runningAfterWrite,
  };

  fs.writeFileSync(path.join(backupDir, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (options.launchCodex && runningAfterWrite.length === 0) launchCodex();
  return report;
}

module.exports = {
  DEFAULT_OPTIONS,
  applyPreview,
  codexPaths,
  codexProcesses,
  getStateSnapshot,
  makePreview,
  openBrowser,
  normalizeOptions,
};
