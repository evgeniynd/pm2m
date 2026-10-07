import { analyzeGroq, redact } from './ai.js';
import { randomBytes } from 'node:crypto';

const verbs = { start: '▶️ Старт', stop: '⏹️ Стоп', restart: '🔄 Рестарт', reload: '♻️ Перезагрузить', delete: '🗑️ Удалить из PM2' };
const identity = p => JSON.stringify([p.name, p.script || '']);
export const lastLines = text => String(text || '').replace(/\r/g, '').replace(/\n$/, '').split('\n').slice(-30).join('\n') || 'Нет записей';

// The transport never includes a bot token or Telegram response body in errors.
export async function telegramRequest(token, method, body, signal) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(35000)])
    });
    const result = await response.json();
    if (result.ok) return result.result;
    const error = new Error(`Telegram: ошибка ${result.error_code || response.status}. Проверьте токен, доступ бота и отсутствие другого экземпляра.`);
    error.retryAfter = Number(result.parameters?.retry_after) || 0;
    throw error;
  } catch (error) {
    if (error.message.startsWith('Telegram:')) throw error;
    throw new Error('Telegram недоступен: проверьте соединение с api.telegram.org');
  }
}

export function createTelegram({ settings, resolveManager, request = telegramRequest, analyze = analyzeGroq }) {
  let current, pollTimer, monitorTimer, revision = 0;
  let analyzing = false;
  const analysisTimes = new Map();
  let status = { running: false, error: '', username: '' };
  const buttons = new Map(), snapshots = new Map(), availability = new Map(), logCursors = new Map();
  const valid = ctx => ctx === current && !ctx.controller.signal.aborted;
  const call = (ctx, method, body) => {
    if (!valid(ctx)) throw new Error('Настройки Telegram изменились');
    return request(ctx.config.token, method, body, ctx.controller.signal);
  };
  const send = (ctx, chat, text, rows = []) => call(ctx, 'sendMessage', {
    chat_id: chat, text: String(text).slice(0, 4000), reply_markup: { inline_keyboard: rows }
  });
  function button(user, text, data) {
    const now = Date.now();
    for (const [key, value] of buttons) if (value.expires < now) buttons.delete(key);
    if (buttons.size >= 5000) buttons.delete(buttons.keys().next().value);
    let key = randomBytes(12).toString('hex');
    if (data.type === 'analyze' && data.serverId && Number.isSafeInteger(data.analysis?.processId)) {
      const persistent = `analyze:${encodeURIComponent(data.serverId)}:${data.analysis.processId}`;
      if (persistent.length <= 64) key = persistent;
    }
    buttons.set(key, { ...data, user, expires: now + (data.type === 'analyze' ? 24 * 60 : 15) * 60000 });
    return { text: String(text).slice(0, 64), callback_data: key };
  }
  const manager = async id => resolveManager(settings.get(id));
  async function servers(ctx, user, page = 0) {
    const all = settings.list();
    const rows = all.slice(page * 20, page * 20 + 20).map(s => [button(user, `🖥️ ${s.name}`, { type: 'server', serverId: s.id })]);
    if (page) rows.push([button(user, '⬅️ Назад', { type: 'servers', page: page - 1 })]);
    if (all.length > (page + 1) * 20) rows.push([button(user, 'Далее ➡️', { type: 'servers', page: page + 1 })]);
    await send(ctx, user, '🖥️ Серверы PM2M' + (all.length ? '' : '\nℹ️ Серверы ещё не добавлены.'), rows);
  }
  async function apps(ctx, user, serverId, page = 0) {
    const target = settings.get(serverId), list = await (await manager(serverId)).list();
    const rows = list.slice(page * 20, page * 20 + 20).map(p => [button(user, `${p.status === 'online' ? '🟢' : '⚪'} ${p.name} #${p.id}`, {
      type: 'app', serverId, id: p.id, identity: identity(p)
    })]);
    if (page) rows.push([button(user, '⬅️ Назад', { type: 'server', serverId, page: page - 1 })]);
    if (list.length > (page + 1) * 20) rows.push([button(user, 'Далее ➡️', { type: 'server', serverId, page: page + 1 })]);
    rows.push([button(user, '💾 Сохранить список PM2', { type: 'confirmSave', serverId })]);
    rows.push([button(user, '🔄 Обновить', { type: 'server', serverId, page }), button(user, '⬅️ Серверы', { type: 'servers' })]);
    await send(ctx, user, `🖥️ ${target.name}\n📦 Приложения: ${list.length}`, rows);
  }
  async function findApp(data) {
    const m = await manager(data.serverId), p = (await m.list()).find(p => p.id === data.id);
    if (!p || identity(p) !== data.identity) throw new Error('Приложение изменилось или удалено. Откройте список заново.');
    return { m, p };
  }
  async function app(ctx, user, data) {
    const { p } = await findApp(data);
    const actions = Object.entries(verbs).map(([action, label]) => button(user, label, { ...data, type: 'confirm', action }));
    await send(ctx, user, `📦 ${settings.get(data.serverId).name} / ${p.name} #${p.id}\n📊 Статус: ${p.status}\n⚙️ CPU: ${Number(p.cpu).toFixed(1)}% · 💾 RAM: ${(p.memory / 1024 ** 2).toFixed(1)} MB\n🔁 Рестарты: ${p.restarts}`, [
      actions.slice(0, 3), actions.slice(3),
      [button(user, '📜 Лог: 30 строк stdout', { ...data, type: 'logs', stream: 'stdout' })],
      [button(user, '⚠️ Ошибки: 30 строк stderr', { ...data, type: 'logs', stream: 'stderr' })],
      [button(user, '🔄 Обновить', { ...data, type: 'app' }), button(user, '⬅️ Приложения', { type: 'server', serverId: data.serverId })]
    ]);
  }
  async function handle(update, ctx = current) {
    if (!ctx || !valid(ctx)) return;
    const query = update.callback_query, message = query?.message || update.message;
    const user = String(query?.from?.id || message?.from?.id || '');
    if (!message || message.chat?.type !== 'private' || String(message.chat.id) !== user) return;
    if (!query && /^\/(id|start)(?:\s|$)/.test(message.text || '') && !ctx.config.userIds.includes(user)) {
      await send(ctx, user, `Ваш Telegram ID: ${user}\nДобавьте этот ID в настройках PM2M для доступа.`); return;
    }
    if (!ctx.config.userIds.includes(user)) {
      if (query) await call(ctx, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Нет доступа' });
      return;
    }
    try {
      if (!query) {
        if ((message.text || '').startsWith('/id')) await send(ctx, user, `Ваш Telegram ID: ${user}`);
        else await servers(ctx, user);
        return;
      }
      let data = buttons.get(query.data);
      if (!data) {
        const persistent = /^analyze:([^:]+):(\d+)$/.exec(query.data || '');
        if (persistent && settings.ai().enabled) {
          const processId = Number(persistent[2]);
          if (Number.isSafeInteger(processId)) data = { type: 'analyze', serverId: decodeURIComponent(persistent[1]), processId, user, expires: Date.now() + 15 * 60000 };
        }
      }
      await call(ctx, 'answerCallbackQuery', { callback_query_id: query.id, text: !data || data.user !== user || data.expires < Date.now() ? 'Меню устарело. Отправьте /start' : undefined });
      if (!data || data.user !== user || data.expires < Date.now()) return;
      if (data.type === 'analyze') {
        const config = settings.ai(true);
        if (!config.enabled || !config.apiKey) throw new Error('Groq выключен. Включите его в настройках панели.');
        settings.get(data.serverId); // A removed server must not be analyzed through an old menu.
        if (!data.analysis) {
          const target = settings.get(data.serverId), m = await manager(data.serverId);
          if (typeof m.logs !== 'function') throw new Error('Меню устарело. Отправьте /start и дождитесь нового уведомления stderr.');
          const logs = await m.logs(data.processId), stderr = String(logs.stderr || '');
          if (!stderr.trim()) throw new Error('В stderr больше нет записей для анализа.');
          const process = (await m.list()).find(item => item.id === data.processId);
          const secrets = [config.apiKey, target.password, target.passphrase];
          data.analysis = { serverId: data.serverId, label: redact(`${target.name} / ${process?.name || `процесс #${data.processId}`}`, secrets), context: redact(JSON.stringify({
            server: target.name, capturedAt: new Date().toISOString(),
            processes: process && [{ name: process.name, id: process.id, status: process.status, restarts: process.restarts }],
            stderr: stderr.split('\n').slice(-100).join('\n')
          }), secrets).slice(-12000) };
        }
        if (data.analysis.answer) {
          for (let i = 0; i < data.analysis.answer.length; i += 3500) await send(ctx, user, data.analysis.answer.slice(i, i + 3500));
          return;
        }
        if (analyzing) throw new Error('Анализ уже выполняется. Повторите нажатие после ответа.');
        if (Date.now() - (analysisTimes.get(user) || 0) < 60000) throw new Error('Не более одного анализа в минуту. Повторите позже.');
        analyzing = true; analysisTimes.set(user, Date.now());
        try {
        await send(ctx, user, '🔎 Анализирую stderr через Groq…');
          const answer = await analyze(config, data.analysis.context, ctx.controller.signal);
          if (!valid(ctx)) return;
          data.analysis.answer = 'Анализ ИИ · ' + data.analysis.label + '\n\n' + redact(answer, [config.apiKey, ctx.config.token]) + '\n\nЭто предположение ИИ. Команды автоматически не выполнялись.';
          for (let i = 0; i < data.analysis.answer.length; i += 3500) await send(ctx, user, data.analysis.answer.slice(i, i + 3500));
        } finally { analyzing = false; }
        return;
      }
      if (data.type === 'servers') return await servers(ctx, user, data.page);
      if (data.type === 'server') return await apps(ctx, user, data.serverId, data.page);
      if (data.type === 'app') return await app(ctx, user, data);
      if (data.type === 'confirmSave') return await send(ctx, user, `💾 Сохранить текущий список PM2 на «${settings.get(data.serverId).name}»?`, [[
        button(user, '✅ Да, сохранить', { ...data, type: 'save' }), button(user, '❌ Отмена', { type: 'server', serverId: data.serverId })
      ]]);
      if (data.type === 'save') {
        buttons.delete(query.data);
        const m = await manager(data.serverId);
        if (!valid(ctx)) return;
        await m.save(); await send(ctx, user, 'Список PM2 сохранён.'); return;
      }
      const { m, p } = await findApp(data);
      if (!valid(ctx)) return;
        if (data.type === 'logs') {
        const logs = await m.logs(p.id), text = lastLines(logs[data.stream]);
        // Plain text avoids interpreting application output as Telegram markup.
        await send(ctx, user, `📜 ${p.name} · ${data.stream} · последние 30 строк`);
        for (let i = 0; i < text.length; i += 3500) await send(ctx, user, text.slice(i, i + 3500));
      } else if (data.type === 'confirm') {
        await send(ctx, user, `${verbs[data.action]} «${p.name}» (#${p.id}) на «${settings.get(data.serverId).name}»?`, [[
          button(user, '✅ Подтвердить', { ...data, type: 'action' }), button(user, '❌ Отмена', { ...data, type: 'app' })
        ]]);
      } else if (data.type === 'action' && verbs[data.action]) {
        buttons.delete(query.data); // Single-use confirmation; duplicate updates cannot repeat a mutation.
        await m.action(p.id, data.action);
        await send(ctx, user, `✅ ${verbs[data.action]}: ${p.name} — выполнено.`);
        await apps(ctx, user, data.serverId);
      }
    } catch (error) {
      if (valid(ctx)) await send(ctx, user, error.message.replaceAll(ctx.config.token, '[скрыто]'));
    }
  }
  async function notify(ctx, text, analysis) {
    let failed;
    for (const user of ctx.config.userIds) {
      try { await send(ctx, user, text, analysis && settings.ai?.().enabled ? [[button(user, '🔎 ПРОАНАЛИЗИРОВАТЬ', { type: 'analyze', serverId: analysis.serverId, analysis })]] : []); status.lastNotificationAt = new Date().toISOString(); } catch (error) { failed = error; }
    }
    if (failed) throw failed;
  }
  async function monitor(ctx = current) {
    if (!ctx || !valid(ctx)) return;
    const errors = [];
    const grouped = Map.groupBy(ctx.config.subscriptions, s => s.serverId);
    for (const [serverId, subscriptions] of grouped) {
      if (!valid(ctx)) return;
      try {
      let target, list;
      try { target = settings.get(serverId); } catch { continue; }
      const m = await manager(serverId);
      try { list = await m.list(); }
      catch {
        if (availability.get(serverId) !== false) await notify(ctx, `⚠ ${target.name}: нет подключения к PM2.`);
        availability.set(serverId, false); continue;
      }
      if (availability.get(serverId) === false) await notify(ctx, `✓ ${target.name}: подключение к PM2 восстановлено.`);
      availability.set(serverId, true);
      for (const subscription of subscriptions) {
        const key = JSON.stringify(subscription);
        const matching = list.filter(p => identity(p) === identity(subscription));
        const next = matching.map(p => ({ id: p.id, status: p.status, restarts: p.restarts })).sort((a, b) => a.id - b.id);
        const previous = snapshots.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
          const detail = next.length ? next.map(p => `#${p.id}: ${p.status}, рестарты ${p.restarts}`).join('\n') : 'Приложение удалено из PM2';
          await notify(ctx, `PM2 · ${target.name} / ${subscription.name}\n${detail}`);
        }
        snapshots.set(key, next);
      }
      const selected = list.filter(p => subscriptions.some(s => identity(s) === identity(p)));
      const cursors = logCursors.get(serverId) || {};
      const entries = await m.errorLogs(selected.map(p => p.id), cursors);
      if (!valid(ctx)) return;
      for (const entry of entries) {
        if (entry.stream && entry.stream !== 'stderr') continue;
        if (entry.error) { errors.push(`${target.name}: ${entry.error}`); continue; }
        try {
          const text = entry.text;
          if (text) {
            const names = selected.filter(p => entry.ids.includes(p.id)).map(p => `${p.name} #${p.id}`).join(', ');
            const lines = lastLines(text);
            const excerpt = lines.length > 3000 ? '…' + lines.slice(-3000) : lines;
            const config = settings.ai?.(true);
            const secretValues = [config?.apiKey, ctx.config.token, target.password, target.passphrase];
            const analysis = {
              serverId, processId: entry.ids[0], label: redact(`${target.name} / ${names}`, secretValues),
              context: redact(JSON.stringify({ server: target.name, capturedAt: new Date().toISOString(),
                processes: selected.filter(p => entry.ids.includes(p.id)).map(p => ({ name: p.name, id: p.id, status: p.status, restarts: p.restarts })),
                stderr: String(text).split('\n').slice(-100).join('\n') }), secretValues).slice(-12000)
            };
            await notify(ctx, `⚠ ${entry.stream || 'stderr'} · ${target.name} / ${names}\nНовые ошибки (до 30 последних строк${entry.truncated || lines.length > 3000 ? ', сокращено' : ''}):\n${excerpt}`, analysis);
          }
          // Advance only after delivery, so a temporary Telegram failure is retried.
          cursors[entry.file] = entry.cursor;
        } catch (error) { errors.push(error.message); }
      }
      const activeFiles = new Set(entries.map(entry => entry.file));
      for (const file of Object.keys(cursors)) if (!activeFiles.has(file)) delete cursors[file];
      logCursors.set(serverId, cursors);
      } catch (error) { errors.push(error.message); }
    }
    if (valid(ctx)) status.lastCheckAt = new Date().toISOString();
    if (errors.length) throw new Error(errors[0]);
  }
  async function poll(ctx) {
    let delay = 1000;
    try {
      const updates = await call(ctx, 'getUpdates', { offset: ctx.config.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        if (!valid(ctx)) return;
        // Persist before dispatch: a crash may lose a command, but never replay it on restart.
        ctx.config.offset = update.update_id + 1;
        await settings.telegramOffset(ctx.config.token, ctx.config.offset);
        await handle(update, ctx);
      }
      if (valid(ctx)) status.pollError = '';
    } catch (error) {
      delay = Math.max(5000, (error.retryAfter || 0) * 1000);
      if (valid(ctx)) status.pollError = error.message;
    } finally {
      if (valid(ctx)) pollTimer = setTimeout(() => poll(ctx), delay).unref();
    }
  }
  async function watch(ctx) {
    try { await monitor(ctx); if (valid(ctx)) status.monitorError = ''; }
    catch (error) { if (valid(ctx)) status.monitorError = `${error.message} Повтор проверки через 30 секунд.`; }
    finally { if (valid(ctx)) monitorTimer = setTimeout(() => watch(ctx), 30000).unref(); }
  }
  function stop() {
    revision++; current?.controller.abort(); current = undefined;
    clearTimeout(pollTimer); clearTimeout(monitorTimer); buttons.clear(); snapshots.clear(); availability.clear(); logCursors.clear();
    status = { running: false, error: '', username: '' };
  }
  async function start({ background = true } = {}) {
    stop(); const rev = revision, config = settings.telegram(true);
    if (!config.enabled || !config.token) return;
    const ctx = { config, controller: new AbortController() }; current = ctx;
    status = { running: false, connecting: true, error: '', username: '' };
    try {
      const me = await call(ctx, 'getMe', {});
      const webhook = await call(ctx, 'getWebhookInfo', {});
      if (webhook.url) throw new Error('У бота включён webhook. Используйте отдельного бота без webhook для PM2M.');
      if (rev !== revision) return;
      status = { running: true, error: '', username: me.username };
      if (background) { void poll(ctx); void watch(ctx); }
    } catch (error) {
      if (rev === revision) {
        status.connecting = false;
        status.error = error.message;
        if (background) pollTimer = setTimeout(() => start(), 30000).unref();
      }
    }
  }
  return { start, stop, handle, monitor, status: () => ({ ...status, error: status.error || status.monitorError || status.pollError || '' }) };
}
