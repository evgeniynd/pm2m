const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let servers = [], processes = [], selected = localStorage.getItem('pm2m-server') || 'local';
let authenticated = false, connected = false, requestId = 0, busy = false, loading = false, gitLoading = false;
let logTarget = null, logStream = 'stdout', logData = {}, logLoading = false, toastTimer;
let processTarget = null, versionsRequest = 0, versionsLoading = false, autoAppPath = '', autoScriptPath = '';

async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-PM2M-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  if (response.status === 401 && path !== '/api/login') showLogin();
  if (response.status === 202) return data;
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}
const endpoint = (path, id = selected) => `${path}?server=${encodeURIComponent(id)}`;
function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function showLogin() {
  authenticated = false; connected = false; requestId++;
  $('#workspace').hidden = true; $('#login-view').hidden = false;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
}
async function enter() {
  await loadServers(); authenticated = true; $('#login-view').hidden = true; $('#workspace').hidden = false;
  await refresh();
}
function navigate(view) {
  const sections = { processes: ['process-view', 'Процессы'], servers: ['servers-view', 'Серверы'], settings: ['settings-view', 'Настройки'] };
  if (!sections[view]) return;
  for (const [name, [id]] of Object.entries(sections)) {
    $('#' + id).hidden = name !== view;
    $('#nav-' + name).classList.toggle('active', name === view);
  }
  $('#breadcrumb').textContent = sections[view][1];
  if (view === 'processes') refresh();
  if (view === 'settings') { loadTelegram().catch(error => toast(error.message, true)); loadAi().catch(error => toast(error.message, true)); loadGithub().catch(error => toast(error.message, true)); }
}
function memory(bytes) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function uptime(ms) {
  const mins = Math.floor(ms / 60000); if (mins >= 1440) return `${Math.floor(mins / 1440)} д ${Math.floor(mins % 1440 / 60)} ч`;
  return mins >= 60 ? `${Math.floor(mins / 60)} ч ${mins % 60} м` : `${mins} м`;
}
const statusName = status => ({ online: 'Работает', stopped: 'Остановлен', errored: 'Ошибка', launching: 'Запускается', stopping: 'Остановка', 'waiting restart': 'Ожидает рестарт' }[status] || status);

async function loadServers() {
  ({ servers } = await api('/api/servers'));
  if (!servers.some(s => s.id === selected)) selected = servers[0]?.id || '';
  localStorage.setItem('pm2m-server', selected);
  $('#server-select').innerHTML = servers.map(s => `<option value="${escape(s.id)}">${escape(s.name)} · ${s.type === 'ssh' ? 'SSH' : 'Local'}</option>`).join('');
  $('#server-select').value = selected;
  renderServers();
}
function renderServers() {
  $('#server-cards').innerHTML = servers.length ? servers.map(s => `<article class="server-card"><h2>${escape(s.name)}</h2><span class="badge neutral">${s.type === 'ssh' ? 'SSH · Linux' : 'Локальный PM2'}</span><p>${s.type === 'ssh' ? `${escape(s.username)}@${escape(s.host)}:${s.port}<br>${s.auth === 'key' ? 'Вход по ключу' : 'Вход по паролю'} · PM2: ${escape(s.pm2Path)}` : 'Пользователь и окружение панели'}<br>Приложения: ${escape(s.appRoot || '/Projects')}</p><div class="card-actions"><button data-server-action="open" data-id="${s.id}">Открыть →</button><button data-server-action="test" data-id="${s.id}">Проверить</button><button data-server-action="edit" data-id="${s.id}">Изменить</button><button data-server-action="delete" data-id="${s.id}">Удалить</button></div></article>`).join('') : '<div class="empty"><strong>Добавьте первый сервер</strong><p>Выберите локальный PM2 или подключение по SSH.</p></div>';
}
function renderProcesses() {
  const query = $('#search').value.toLowerCase(); const status = $('#status-filter').value;
  const filtered = processes.filter(p => p.name.toLowerCase().includes(query) && (status === 'all' || p.status === status));
  $('#process-count').textContent = processes.length;
  $('#process-rows').innerHTML = filtered.map(p => `<tr><td><div class="app-cell"><span class="app-icon">&gt;_</span><div><div class="app-name">${escape(p.name)}</div><div class="app-meta">#${p.id} · ${escape(p.mode === 'cluster_mode' ? 'cluster' : 'fork')} · PID ${p.pid || '—'}</div></div></div></td><td><span class="badge ${['online','stopped','errored'].includes(p.status) ? p.status : 'neutral'}">● &nbsp;${escape(statusName(p.status))}</span></td><td><div class="cpu">${Number(p.cpu).toFixed(1)}%</div><div class="ram">${memory(p.memory)}</div></td><td>${p.status === 'online' ? uptime(p.uptime) : '—'}</td><td>${p.restarts}</td><td><div class="row-actions"><button data-action="logs" data-id="${p.id}" title="Логи">Логи</button><button data-action="update" data-id="${p.id}" title="Обновить из GitHub">↥ Git</button>${p.status === 'online' ? `<button data-action="restart" data-id="${p.id}" title="Перезапустить" aria-label="Перезапустить ${escape(p.name)}">↻</button><button data-action="reload" data-id="${p.id}" title="Reload: плавная перезагрузка в cluster mode">Reload</button><button data-action="stop" data-id="${p.id}" title="Остановить" aria-label="Остановить ${escape(p.name)}">Ⅱ</button>` : `<button data-action="start" data-id="${p.id}" title="Запустить" aria-label="Запустить ${escape(p.name)}">▷</button>`}<button class="delete" data-action="delete" data-id="${p.id}" title="Удалить из PM2" aria-label="Удалить ${escape(p.name)}">×</button></div></td></tr>`).join('');
  filtered.forEach(p => { const button = document.querySelector(`[data-action="update"][data-id="${p.id}"]`); if (!button) return; const git = p.git; if (!git?.available) { button.dataset.action = 'add-git'; button.textContent = '＋ Git'; button.title = 'Указать URL GitHub-репозитория'; return; } if (git.error) { button.dataset.action = 'add-git'; button.textContent = '↻ Git'; button.title = git.error; return; } if (git.updateAvailable !== true) { button.outerHTML = '<span class="git-current">✓ Актуально</span>'; return; } button.dataset.updateAvailable = 'true'; button.classList.add('git-update'); button.textContent = '↥ Обновить'; button.title = 'Есть обновление из GitHub'; });
  $('#empty-state').hidden = filtered.length > 0;
  updateControls();
}
function updateControls() {
  $('#add-process').disabled = !connected || busy;
  $('#save-processes').disabled = !connected || busy;
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = !connected || busy || (button.dataset.action === 'update' && button.dataset.updateAvailable !== 'true'); });
}
async function refreshGitUpdates(target = selected) {
  if (!authenticated || !connected || gitLoading || target !== selected) return;
  gitLoading = true;
  try {
    const { updates } = await api(endpoint('/api/processes/git-updates', target));
    if (target !== selected) return;
    processes = processes.map(p => ({ ...p, git: updates[String(p.id)] || undefined })); renderProcesses();
  } catch {} finally { gitLoading = false; }
}
async function refresh() {
  const current = ++requestId; const target = selected;
  if (!target) {
    connected = false; processes = []; renderProcesses(); $('#connection').textContent = 'Нет серверов';
    for (const id of ['total','online','cpu','memory']) $(`#stat-${id}`).textContent = '—';
    $('#stat-stopped').textContent = '—'; $('#host-info').textContent = 'Добавьте сервер в настройках';
    $('#updated').textContent = 'Ожидание данных'; $('#process-error').hidden = true; $('#demo-banner').hidden = true;
    return;
  }
  loading = true;
  try {
    const data = await api(endpoint('/api/processes', target));
    if (current !== requestId || !authenticated) return;
    connected = true;
    const previousGit = new Map(processes.map(process => [process.id, process.git]));
    processes = data.processes.map(process => ({ ...process, git: previousGit.get(process.id) }));
    $('#connection').textContent = '● Подключено'; $('#connection').className = 'badge online';
    $('#process-error').hidden = true; $('#demo-banner').hidden = !data.demo;
    $('#stat-total').textContent = processes.length;
    const online = processes.filter(p => p.status === 'online').length;
    $('#stat-online').textContent = online; $('#stat-stopped').textContent = `${processes.length - online} не работают`;
    $('#stat-cpu').textContent = `${processes.reduce((sum, p) => sum + p.cpu, 0).toFixed(1)}%`;
    const processMemory = processes.reduce((sum, p) => sum + p.memory, 0);
    $('#stat-memory').textContent = `${memory(processMemory)} / ${data.system?.totalMemory ? memory(data.system.totalMemory) : '—'}`;
    $('#updated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
    $('#host-info').textContent = `${data.host} · ${data.platform}${data.demo ? ' · DEMO' : ''}`;
    renderProcesses();
    void refreshGitUpdates(target);
  } catch (error) {
    if (current !== requestId) return;
    connected = false; $('#connection').textContent = 'Нет соединения'; $('#connection').className = 'badge errored';
    $('#process-error').textContent = error.message; $('#process-error').hidden = false; updateControls();
  } finally { if (current === requestId) loading = false; }
}
async function selectServer(id) {
  selected = id; localStorage.setItem('pm2m-server', id); $('#server-select').value = id;
  connected = false; processes = []; renderProcesses(); $('#connection').textContent = 'Подключение…'; $('#connection').className = 'badge neutral';
  for (const key of ['total','online','cpu','memory']) $(`#stat-${key}`).textContent = '—';
  $('#stat-stopped').textContent = '—'; $('#host-info').textContent = '—'; $('#updated').textContent = 'Ожидание данных'; $('#demo-banner').hidden = true;
  $('#logs-dialog').close(); await refresh();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { password: event.target.elements.password.value }); event.target.reset(); await enter(); }
  catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#logout').onclick = async () => { try { await api('/api/logout', {}); showLogin(); } catch (error) { toast(error.message, true); } };
$('#logout-mobile').onclick = $('#logout').onclick;
$('#nav-processes').onclick = () => navigate('processes'); $('#nav-settings').onclick = () => navigate('settings');
$('#nav-servers').onclick = () => navigate('servers');
$('#server-select').onchange = event => selectServer(event.target.value);
$('#refresh').onclick = () => refresh(); $('#search').oninput = renderProcesses; $('#status-filter').onchange = renderProcesses;
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });

$('#process-rows').onclick = async event => {
  const button = event.target.closest('[data-action]'); if (!button || busy) return;
  const id = Number(button.dataset.id), action = button.dataset.action, target = selected;
  const p = processes.find(p => p.id === id); if (!p) return;
  if (action === 'logs') { logTarget = { id, server: target }; logStream = 'stdout'; logData = {}; $('#logs-title').textContent = p.name; $('#log-output').textContent = 'Загрузка…'; $('#log-analysis').hidden = true; $('#log-analysis').textContent = ''; $('#logs-dialog').showModal(); setLogStream('stdout'); await refreshLogs(); return; }
  if (action === 'add-git') {
    const repository = prompt(`URL GitHub-репозитория для «${p.name}» на сервере «${servers.find(s => s.id === target)?.name}»:`, 'https://github.com/owner/repository.git');
    if (!repository?.trim()) return;
    busy = true; updateControls();
    try { const result = await api(endpoint(`/api/processes/${id}/git`, target), { repository: repository.trim() }); processes = processes.map(item => item.id === id ? { ...item, git: result.git } : item); renderProcesses(); toast('Git-репозиторий добавлен'); await refresh(); }
    catch (error) { toast(error.message, true); } finally { busy = false; updateControls(); }
    return;
  }
  if (action === 'update') {
    busy = true; updateControls();
    const dialog = $('#git-update-dialog'); const confirmButton = $('#git-update-confirm'); const cancelButton = $('#git-update-cancel');
    $('#git-update-title').textContent = `Обновление · ${p.name}`; $('#git-update-status').textContent = 'Получаем список изменений…'; $('#git-update-changes').hidden = true; $('#git-update-changes').textContent = ''; confirmButton.disabled = true; cancelButton.disabled = false; dialog.oncancel = event => event.preventDefault(); dialog.showModal();
    try {
      const data = await api(endpoint(`/api/processes/${id}/git-changes`, target));
      if (data.error) throw new Error(data.error);
      if (!data.commits?.length) { $('#git-update-status').textContent = 'Новых коммитов не найдено.'; await new Promise(resolve => setTimeout(resolve, 1200)); return; }
      const changes = data.commits.map(commit => {
        const date = commit.date ? new Date(commit.date).toLocaleString('ru-RU') : '';
        return `• ${commit.subject || 'Без сообщения'}\n  ${commit.hash || ''} · ${commit.author || 'Неизвестный автор'}${date ? ` · ${date}` : ''}`;
      }).join('\n');
      $('#git-update-status').textContent = 'Проверьте изменения перед обновлением.'; $('#git-update-changes').textContent = changes; $('#git-update-changes').hidden = false; confirmButton.disabled = false;
      const approved = await new Promise(resolve => { const finish = value => { confirmButton.onclick = null; cancelButton.onclick = null; resolve(value); }; confirmButton.onclick = () => finish(true); cancelButton.onclick = () => finish(false); });
      if (!approved) return;
      confirmButton.disabled = true; cancelButton.disabled = true; $('#git-update-status').textContent = 'Устанавливаем изменения и перезапускаем приложение…';
      await api(endpoint(`/api/processes/${id}/update`, target), {});
      processes = processes.map(item => item.id === id ? { ...item, git: { ...(item.git || {}), available: true, updateAvailable: false, error: undefined } } : item);
      renderProcesses(); toast('Приложение обновлено'); await refresh();
    } catch (error) { toast(error.message, true); } finally { if (dialog.open) dialog.close(); dialog.oncancel = null; busy = false; updateControls(); }
    return;
  }
  const verbs = { update: 'Обновить из GitHub', stop: 'Остановить', restart: 'Перезапустить', reload: 'Перезагрузить', delete: 'Удалить из PM2' };
  if (verbs[action] && !confirm(`${verbs[action]} «${p.name}» на сервере «${servers.find(s => s.id === target)?.name}»?`)) return;
  busy = true; updateControls();
  try { await api(endpoint(`/api/processes/${id}/${action}`, target), {}); toast('Действие выполнено'); await refresh(); }
  catch (error) { toast(error.message, true); } finally { busy = false; updateControls(); }
};
$('#save-processes').onclick = async () => {
  if (!confirm('Сохранить текущий список PM2 на выбранном сервере? Предыдущий сохранённый список будет заменён.')) return;
  busy = true; updateControls();
  try { await api(endpoint('/api/save'), {}); toast('Список PM2 сохранён'); } catch (error) { toast(error.message, true); }
  finally { busy = false; updateControls(); }
};
async function loadNodeVersions() {
  const target = processTarget; const request = ++versionsRequest;
  const select = $('#node-version'); const previous = select.value;
  versionsLoading = true; select.disabled = true; $('#start-process').disabled = true; $('#reload-node-versions').disabled = true;
  select.innerHTML = '<option value="">Проверяем установленные версии…</option>';
  $('#node-version-status').textContent = 'Поиск Node.js на выбранном сервере…';
  try {
    const { versions } = await api(endpoint('/api/node-versions', target));
    if (request !== versionsRequest || target !== processTarget) return;
    select.innerHTML = versions.length ? versions.map(node => `<option value="${escape(node.path)}">${escape(node.version)}${node.default ? ' · по умолчанию' : ''} — ${escape(node.path)}</option>`).join('') : '<option value="">Node.js не найден</option>';
    if (versions.some(node => node.path === previous)) select.value = previous;
    select.disabled = !versions.length; $('#start-process').disabled = !versions.length;
    $('#node-version-status').textContent = versions.length ? `Найдено версий: ${versions.length}. Для запуска будет использован выбранный исполняемый файл.` : 'Установленные версии Node.js не найдены в PATH и стандартных папках менеджеров версий.';
  } catch (error) {
    if (request !== versionsRequest || target !== processTarget) return;
    select.innerHTML = '<option value="">Не удалось получить версии</option>';
    $('#node-version-status').textContent = error.message;
  } finally {
    if (request === versionsRequest) { versionsLoading = false; $('#reload-node-versions').disabled = false; }
  }
}
$('#add-process').onclick = () => {
  processTarget = selected; autoAppPath = ''; autoScriptPath = ''; $('#process-form').reset(); $('#process-form .error').textContent = '';
  $('#process-target').textContent = `Сервер: ${servers.find(s => s.id === processTarget)?.name}. Все пути относятся к этому серверу.`;
  $('#process-dialog').showModal(); loadNodeVersions();
};
$('#reload-node-versions').onclick = loadNodeVersions;
$('#process-dialog').addEventListener('close', () => { processTarget = null; versionsRequest++; });
function formData(form) { return Object.fromEntries(new FormData(form)); }
async function submitForm(event, work) {
  event.preventDefault(); const form = event.target; const button = event.submitter; button.disabled = true; form.querySelector('.error').textContent = '';
  try { await work(formData(form)); form.closest('dialog').close(); form.reset(); } catch (error) { form.querySelector('.error').textContent = error.message; }
  finally { button.disabled = false; }
}
$('#process-form').onsubmit = event => {
  if (versionsLoading || !processTarget || !$('#node-version').value) { event.preventDefault(); return; }
  const target = processTarget;
  return submitForm(event, async data => {
    $('#reload-node-versions').disabled = true;
    try { await api(endpoint('/api/processes', target), data); toast('Приложение запущено'); await refresh(); }
    finally { $('#reload-node-versions').disabled = false; }
  });
};
function serverFields() {
  const form = $('#server-form'); const ssh = form.elements.type.value === 'ssh'; const key = form.elements.auth.value === 'key';
  $('#ssh-fields').hidden = !ssh; $('#local-hint').hidden = ssh; $('#password-field').hidden = key; $('#key-fields').hidden = !key;
}
function editServer(server) {
  const form = $('#server-form'); form.reset(); form.querySelector('.error').textContent = '';
  form.elements.appRoot.value = server?.appRoot || '/Projects';
  if (server) for (const [key, value] of Object.entries(server)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  $('#server-dialog-title').textContent = server ? 'Изменить сервер' : 'Добавить сервер'; serverFields(); $('#server-dialog').showModal();
}
$('#add-server').onclick = () => editServer(); $('#server-form').elements.type.onchange = serverFields; $('#server-form').elements.auth.onchange = serverFields;
for (const name of ['host','port']) $('#server-form').elements[name].addEventListener('input', () => { $('#server-form').elements.fingerprint.value = ''; });
$('#probe-ssh').onclick = async event => {
  const form = $('#server-form'); const button = event.target; const config = formData(form); button.disabled = true; form.querySelector('.error').textContent = '';
  try {
    const data = await api('/api/ssh/probe', config);
    if (config.host !== form.elements.host.value || config.port !== form.elements.port.value) throw new Error('Адрес изменился. Получите отпечаток повторно.');
    form.elements.fingerprint.value = data.fingerprint; toast('Отпечаток получен. Сверьте его с ключом сервера.');
  } catch (error) { form.querySelector('.error').textContent = error.message; } finally { button.disabled = false; }
};
$('#server-form').onsubmit = event => submitForm(event, async data => {
  const result = await api('/api/servers', data); await loadServers(); await selectServer(result.server.id); toast('Настройки сервера сохранены');
});
$('#server-cards').onclick = async event => {
  const button = event.target.closest('[data-server-action]'); if (!button) return;
  const server = servers.find(s => s.id === button.dataset.id); if (!server) return;
  const action = button.dataset.serverAction;
  if (action === 'edit') return editServer(server);
  if (action === 'open') { await selectServer(server.id); navigate('processes'); return; }
  if (action === 'delete' && !confirm(`Удалить подключение «${server.name}» из настроек? Процессы на сервере останутся работать.`)) return;
  button.disabled = true;
  try {
    await api(`/api/servers/${server.id}/${action}`, {});
    if (action === 'delete') { await loadServers(); await selectServer(selected); toast('Подключение удалено'); }
    else toast('Подключение к PM2 работает');
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
};
function setLogStream(stream) {
  logStream = stream; $('#stdout-tab').classList.toggle('active', stream === 'stdout'); $('#stderr-tab').classList.toggle('active', stream === 'stderr');
  $('#log-output').textContent = logData[stream] || 'Нет записей';
  const analyze = $('#analyze-log');
  analyze.disabled = stream !== 'stderr' || !String(logData.stderr || '').trim() || logLoading;
}
$('#stdout-tab').onclick = () => setLogStream('stdout'); $('#stderr-tab').onclick = () => setLogStream('stderr');
$('#logs-dialog').addEventListener('close', () => { logTarget = null; });
$('#analyze-log').onclick = async () => {
  if (!logTarget || logStream !== 'stderr' || !String(logData.stderr || '').trim()) return;
  const button = $('#analyze-log'), output = $('#log-analysis');
  button.disabled = true; button.textContent = '🔎 Анализирую…'; output.hidden = false; output.textContent = 'Запрос отправлен в Groq…';
  try {
    const result = await api(endpoint('/api/ai/analyze', logTarget.server), { processId: logTarget.id });
    output.textContent = `Анализ Groq\n\n${result.answer}`;
  } catch (error) { output.textContent = `Не удалось выполнить анализ\n\n${error.message}`; }
  finally { button.textContent = '🔎 Проанализировать'; setLogStream(logStream); }
};
$('#process-form').elements.name.addEventListener('input', event => {
  const root = servers.find(server => server.id === processTarget)?.appRoot || '/Projects'; const separator = root.includes('\\') ? '\\' : '/'; const next = `${root.replace(/[\\/]+$/, '')}${separator}${event.target.value.trim()}`;
  const destination = $('#process-form').elements.destination; const cwd = $('#process-form').elements.cwd; const script = $('#process-form').elements.script; const nextScript = `${next}${separator}index.js`;
  if (!destination.value || destination.value === autoAppPath) destination.value = next;
  if (!cwd.value || cwd.value === autoAppPath) cwd.value = next;
  if (!script.value || script.value === autoScriptPath) script.value = nextScript;
  autoAppPath = next; autoScriptPath = nextScript;
});
async function refreshLogs() {
  if (!logTarget || logLoading) return;
  const target = logTarget; logLoading = true;
  try {
    const data = await api(endpoint(`/api/processes/${target.id}/logs`, target.server));
    if (target !== logTarget) return;
    logData = data; const pre = $('#log-output'); const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    setLogStream(logStream); if (atBottom) pre.scrollTop = pre.scrollHeight;
    $('#log-status').textContent = `Последние 200 строк · ${new Date().toLocaleTimeString('ru-RU')}`;
  } catch (error) { if (target === logTarget) $('#log-status').textContent = error.message; } finally { logLoading = false; if (target === logTarget) setLogStream(logStream); }
}
setInterval(() => { if (!authenticated || document.hidden) return; if (!$('#process-view').hidden && !loading && !busy) refresh(); if (logTarget) refreshLogs(); }, 5000);
setInterval(() => { if (!authenticated || document.hidden || $('#process-view').hidden || busy) return; void refreshGitUpdates(); }, 30000);
let telegramSubscriptions = [], telegramChoices = [], telegramLoaded = false;
const subscriptionKey = s => JSON.stringify([s.serverId, s.name, s.script]);
function telegramStatus(status) {
  $('#telegram-status').textContent = status?.error || (status?.connecting ? 'Подключение к Telegram…' : status?.running ? `Бот @${status.username} подключён. Команда /start — список серверов.` : 'Бот выключен.');
}
function renderTelegramApps() {
  $('#telegram-apps').innerHTML = telegramChoices.map((s, index) => `<label class="check-label"><input type="checkbox" data-telegram-app="${index}" ${telegramSubscriptions.some(saved => subscriptionKey(saved) === subscriptionKey(s)) ? 'checked' : ''}><span>${escape(servers.find(server => server.id === s.serverId)?.name || 'Удалённый сервер')} / ${escape(s.name)}<small>${escape(s.script || '')}</small></span></label>`).join('');
}
async function loadTelegram() {
  telegramLoaded = false;
  const form = $('#telegram-form'); form.querySelector('button[type="submit"]').disabled = true;
  try {
    const { config, status } = await api('/api/telegram');
    $('#telegram-enabled').checked = config.enabled;
    $('#telegram-users').value = config.userIds.join(', ');
    $('#telegram-token').value = ''; $('#telegram-clear-token').checked = false;
    $('#telegram-token-hint').textContent = config.hasToken ? 'Токен сохранён. Оставьте поле пустым, чтобы сохранить прежний.' : 'Создайте отдельного бота в @BotFather и вставьте токен.';
    telegramSubscriptions = config.subscriptions.filter(s => servers.some(server => server.id === s.serverId));
    telegramChoices = [...telegramSubscriptions]; renderTelegramApps(); telegramStatus(status); telegramLoaded = true;
  } finally { form.querySelector('button[type="submit"]').disabled = !telegramLoaded; }
}
$('#telegram-apps').onchange = event => {
  const index = event.target.dataset.telegramApp; if (index === undefined) return;
  const item = telegramChoices[Number(index)];
  telegramSubscriptions = telegramSubscriptions.filter(s => subscriptionKey(s) !== subscriptionKey(item));
  if (event.target.checked) telegramSubscriptions.push(item);
};
$('#telegram-load-apps').onclick = async event => {
  const button = event.target; button.disabled = true;
  const found = [...telegramSubscriptions], errors = [];
  try {
    for (const server of servers) {
      try {
        const data = await api(endpoint('/api/processes', server.id));
        for (const p of data.processes) {
          const item = { serverId: server.id, name: p.name, script: p.script || '' };
          if (!found.some(s => subscriptionKey(s) === subscriptionKey(item))) found.push(item);
        }
      } catch { errors.push(server.name); }
    }
    telegramChoices = found; renderTelegramApps();
    $('#telegram-form .error').textContent = errors.length ? `Не удалось загрузить: ${errors.join(', ')}. Сохранённый выбор оставлен.` : '';
  } finally { button.disabled = false; }
};
$('#telegram-form').onsubmit = async event => {
  event.preventDefault(); if (!telegramLoaded) return;
  event.submitter.disabled = true; $('#telegram-form .error').textContent = '';
  try {
    await api('/api/telegram', { enabled: $('#telegram-enabled').checked, token: $('#telegram-token').value,
      clearToken: $('#telegram-clear-token').checked,
      userIds: $('#telegram-users').value.split(/[,;\s]+/).filter(Boolean), subscriptions: telegramSubscriptions });
    await loadTelegram(); toast('Настройки Telegram сохранены');
  } catch (error) { $('#telegram-form .error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
};
setInterval(async () => {
  if (!authenticated || document.hidden || $('#settings-view').hidden || !telegramLoaded) return;
  try { telegramStatus((await api('/api/telegram')).status); } catch {}
}, 5000);
enter().catch(() => showLogin());

let aiLoaded = false;
async function loadAi() {
  aiLoaded = false;
  const submit = $('#ai-form button[type="submit"]'); submit.disabled = true;
  try {
    const { config } = await api('/api/ai');
    $('#ai-enabled').checked = config.enabled; $('#ai-model').value = config.model;
    $('#ai-key').value = ''; $('#ai-clear-key').checked = false;
    $('#ai-key-hint').textContent = config.hasKey ? 'Ключ сохранён. Пустое поле сохраняет прежний ключ.' : 'Введите ключ из Groq Console.';
    aiLoaded = true;
  } finally { submit.disabled = !aiLoaded; }
}
$('#ai-form').onsubmit = async event => {
  event.preventDefault(); if (!aiLoaded) return;
  event.submitter.disabled = true; $('#ai-form .error').textContent = '';
  try {
    await api('/api/ai', { enabled: $('#ai-enabled').checked, apiKey: $('#ai-key').value,
      clearKey: $('#ai-clear-key').checked, model: $('#ai-model').value });
    await loadAi(); toast('Настройки Groq сохранены');
  } catch (error) { $('#ai-form .error').textContent = error.message; }
  finally { event.submitter.disabled = !aiLoaded; }
};
let githubLoaded = false;
async function loadGithub() {
  const { config } = await api('/api/github'); githubLoaded = true;
  $('#github-disconnect').hidden = !config.hasToken;
  $('#github-token').value = '';
  $('#github-status').textContent = config.hasToken ? '✅ GitHub подключён. Приватные репозитории доступны для clone и update.' : 'GitHub не подключён.';
}
$('#github-save').onclick = async event => {
  const token = $('#github-token').value.trim(); if (!token) return;
  event.currentTarget.disabled = true; $('#github-status').textContent = 'Проверяем токен через GitHub…';
  try { const data = await api('/api/github/token', { token }); await loadGithub(); toast(`GitHub подключён: ${data.login}`); }
  catch (error) { $('#github-status').textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};
$('#github-disconnect').onclick = async event => {
  event.currentTarget.disabled = true;
  try { await api('/api/github/disconnect', {}); await loadGithub(); toast('GitHub отключён'); }
  catch (error) { $('#github-status').textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};
