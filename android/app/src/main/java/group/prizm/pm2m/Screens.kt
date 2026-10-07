@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package group.prizm.pm2m

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.util.Locale

private data class Confirm(val title: String, val text: String, val run: () -> Unit)
private val verbs = mapOf("start" to "Старт", "stop" to "Стоп", "restart" to "Рестарт", "reload" to "Reload", "delete" to "Удалить")

@Composable fun Pm2mApp(m: AppModel, biometric: (Boolean) -> Unit, biometricAvailable: () -> Boolean) {
    Pm2mTheme(m.theme) {
        Surface(Modifier.fillMaxSize()) {
            if (!m.unlocked) LockScreen(m, biometric)
            else Workspace(m, biometric, biometricAvailable)
        }
    }
}
@Composable private fun ErrorBanner(m: AppModel) {
    if (m.error.isNotEmpty()) Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) { Text(m.error); TextButton(colors = themeTextButtonColors(), onClick = { m.error = "" }) { Text("Закрыть") } }
    }
    if (m.message.isNotEmpty()) Panel {
        Row(Modifier.padding(12.dp)) { Text(m.message, Modifier.weight(1f)); TextButton(colors = themeTextButtonColors(), onClick = { m.message = "" }) { Text("OK") } }
    }
    if (m.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
}
@Composable private fun Field(label: String, value: String, enabled: Boolean = true, secret: Boolean = false, multiline: Boolean = false,
                              keyboard: KeyboardType = KeyboardType.Text, change: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = change, label = { Text(label) }, enabled = enabled,
        shape = themeInputShape(), colors = themeFieldColors(), modifier = Modifier.fillMaxWidth(), singleLine = !multiline, minLines = if (multiline) 3 else 1,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (secret && keyboard == KeyboardType.Text) KeyboardType.Password else keyboard))
}
@Composable private fun LockScreen(m: AppModel, biometric: (Boolean) -> Unit) {
    var pin by remember { mutableStateOf("") }; var confirm by remember { mutableStateOf("") }; var reset by remember { mutableStateOf(false) }
    Column(Modifier.aurora().safeDrawingPadding().imePadding().fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(40.dp)); Text("pm2m", style = MaterialTheme.typography.displayMedium, color = MaterialTheme.colorScheme.onBackground)
        Text(if (m.initialized) "Доступ к серверам" else "Создайте PIN-код", style = MaterialTheme.typography.headlineSmall)
        Text(if (m.initialized) "Введите PIN для доступа к SSH-подключениям." else "От 6 до 12 цифр. PIN защищает подключения на этом устройстве. После создания можно включить биометрию.")
        Field("PIN", pin, !m.busy, true, keyboard = KeyboardType.NumberPassword) { if (it.length <= 12 && it.all(Char::isDigit)) pin = it }
        if (!m.initialized) Field("Повторите PIN", confirm, !m.busy, true, keyboard = KeyboardType.NumberPassword) { if (it.length <= 12 && it.all(Char::isDigit)) confirm = it }
        Button(shape = themeButtonShape(), onClick = { m.login(pin, confirm); pin = ""; confirm = "" }, enabled = !m.busy && pin.length >= 6, modifier = Modifier.fillMaxWidth()) { Text(if (m.initialized) "Открыть" else "Создать PIN") }
        if (m.biometricEnabled) OutlinedButton(shape = themeButtonShape(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { biometric(false) }, enabled = !m.busy, modifier = Modifier.fillMaxWidth()) { Text("Войти по биометрии") }
        ErrorBanner(m)
        if (m.initialized) TextButton(colors = themeTextButtonColors(), onClick = { reset = true }, enabled = !m.busy) { Text("Забыл PIN") }
        Text("Prizm.Group · Только прямое SSH-подключение", style = MaterialTheme.typography.bodySmall)
    }
    if (reset) AlertDialog(onDismissRequest = { reset = false }, title = { Text("Сбросить локальные данные?") },
        text = { Text("Восстановить PIN нельзя. Будут удалены только сохранённые на телефоне подключения, пароли и ключи. Программы на серверах останутся работать.") },
        confirmButton = { TextButton(colors = themeTextButtonColors(), onClick = { m.reset(); reset = false }) { Text("Удалить данные и PIN") } }, dismissButton = { TextButton(colors = themeTextButtonColors(), onClick = { reset = false }) { Text("Отмена") } })
}
@Composable private fun Workspace(m: AppModel, biometric: (Boolean) -> Unit, biometricAvailable: () -> Boolean) {
    var edit by remember { mutableStateOf<Server?>(null) }; var confirm by remember { mutableStateOf<Confirm?>(null) }
    var security by remember { mutableStateOf(false) }; var newApp by remember { mutableStateOf(false) }
    var logProcess by remember { mutableStateOf<ProcessInfo?>(null) }
    BackHandler(enabled = m.selected != null || security || edit != null) { when { edit != null -> edit = null; security -> security = false; else -> m.back() } }
    LaunchedEffect(m.selected?.id, security, edit, newApp, logProcess) {
        while (m.selected != null && !security && edit == null && !newApp && logProcess == null) { delay(5000); if (!m.busy) m.refresh() }
    }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
        TopAppBar(colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background), title = { Text(if (edit != null) "SSH-сервер" else if (security) "Настройки" else m.selected?.name ?: "pm2m") },
            navigationIcon = { if (m.selected != null || security || edit != null) TextButton(colors = themeTextButtonColors(), onClick = { if (edit != null) edit = null else if (security) security = false else m.back() }, enabled = !m.busy) { Text("Назад") } },
            actions = { TextButton(colors = themeTextButtonColors(), onClick = { m.lock() }) { Text("Закрыть") } })
    }) { padding ->
        Column(Modifier.padding(padding).imePadding().padding(horizontal = 16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ErrorBanner(m)
            when {
                edit != null -> ServerEditor(m, edit!!, saved = { edit = null })
                security -> SecurityScreen(m, biometric)
                m.selected == null -> {
                    PageHeading("Рабочее пространство", "Серверы")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(shape = themeButtonShape(), onClick = { edit = Server() }, enabled = !m.busy) { Text("Добавить сервер") }
                        OutlinedButton(shape = themeButtonShape(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { security = true }) { Text("Настройки") }
                    }
                    if (m.servers.isEmpty()) Text("Добавьте Linux-сервер с установленным PM2. Панель Node.js на сервере не нужна.")
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(m.servers, key = { it.id }) { s -> Panel {
                            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(s.name, style = MaterialTheme.typography.titleLarge); Text("${s.username}@${s.host}:${s.port}")
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(shape = themeButtonShape(), onClick = { m.select(s) }, enabled = !m.busy) { Text("Открыть") }
                                    TextButton(colors = themeTextButtonColors(), onClick = { edit = s }, enabled = !m.busy) { Text("Изменить") }
                                    TextButton(colors = themeTextButtonColors(), onClick = { confirm = Confirm("Удалить подключение?", s.name) { m.removeServer(s) } }, enabled = !m.busy) { Text("Удалить") }
                                }
                            }
                        } }
                    }
                }
                else -> {
                    PageHeading(m.selected?.name ?: "PM2", "Приложения")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(shape = themeButtonShape(), onClick = { newApp = true; m.loadVersions() }, enabled = !m.busy) { Text("Новое приложение") }
                        OutlinedButton(shape = themeButtonShape(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = m::refresh, enabled = !m.busy) { Text("Обновить") }
                        TextButton(colors = themeTextButtonColors(), onClick = { confirm = Confirm("Сохранить список PM2?", "Текущий список заменит сохранённый на ${m.selected?.name}.") { m.savePm2() } }, enabled = !m.busy) { Text("Сохранить PM2") }
                    }
                    var search by remember(m.selected?.id) { mutableStateOf("") }
                    Field("Поиск приложений", search) { search = it }
                    Text(m.refreshError.ifEmpty { "${m.processes.size} приложений · SSH" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(m.processes.filter { it.name.contains(search, true) }, key = { it.id }) { p -> Panel {
                            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(p.name, style = MaterialTheme.typography.titleLarge)
                                Text("#${p.id} · ${p.status} · ${p.mode}", color = if (p.status == "online") MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurface)
                                Text("CPU ${String.format(Locale.ROOT, "%.1f", p.cpu)}% · RAM ${p.memory / 1048576} МБ · рестарты ${p.restarts}")
                                if (p.status == "online") Text("Работает ${maxOf(0, System.currentTimeMillis() - p.uptime) / 60000} мин")
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    TextButton(colors = themeTextButtonColors(), onClick = { logProcess = p }, enabled = !m.busy) { Text("Логи") }
                                    for ((action, label) in verbs) TextButton(colors = themeTextButtonColors(), enabled = !m.busy, onClick = {
                                        confirm = Confirm("$label ${p.name}?", "Сервер: ${m.selected?.name}, процесс #${p.id}." + if (action == "delete") " Удаление из PM2 не удаляет файлы." else "") { m.action(p, action) }
                                    }) { Text(label) }
                                }
                            }
                        } }
                    }
                }
            }
        }
    }
    confirm?.let { c -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text(c.title) }, text = { Text(c.text) },
        confirmButton = { TextButton(colors = themeTextButtonColors(), onClick = { confirm = null; c.run() }) { Text("Подтвердить") } }, dismissButton = { TextButton(colors = themeTextButtonColors(), onClick = { confirm = null }) { Text("Отмена") } }) }
    if (m.offerBiometric) AlertDialog(onDismissRequest = { m.offerBiometric = false }, title = { Text("Вход по биометрии") },
        text = { Text(if (biometricAvailable()) "Разрешить вход по отпечатку или биометрии устройства? PIN останется доступен." else "На устройстве пока нет доступной защищённой биометрии. Её можно настроить в Android и включить здесь позже.") },
        confirmButton = { if (biometricAvailable()) TextButton(colors = themeTextButtonColors(), onClick = { biometric(true) }) { Text("Включить") } },
        dismissButton = { TextButton(colors = themeTextButtonColors(), onClick = { m.offerBiometric = false }) { Text("Позже") } })
    if (newApp) NewAppDialog(m) { newApp = false }
    logProcess?.let { p -> LogsDialog(m, p) { logProcess = null } }
}

@Composable private fun ServerEditor(m: AppModel, initial: Server, saved: () -> Unit) {
    var s by remember(initial.id) { mutableStateOf(initial) }
    var port by remember { mutableStateOf(initial.port.toString()) }
    var keyAuth by remember { mutableStateOf(initial.privateKey.isNotBlank()) }
    var verified by remember { mutableStateOf(initial.fingerprint.isNotBlank()) }
    Column(Modifier.verticalScroll(rememberScrollState()).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Field("Название", s.name, !m.busy) { s = s.copy(name = it) }
        Field("Адрес сервера", s.host, !m.busy) { s = s.copy(host = it, fingerprint = ""); verified = false }
        Field("Порт", port, !m.busy, keyboard = KeyboardType.Number) { port = it; s = s.copy(port = it.toIntOrNull() ?: 0, fingerprint = ""); verified = false }
        Field("Пользователь", s.username, !m.busy) { s = s.copy(username = it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !keyAuth, onClick = { keyAuth = false }, label = { Text("Пароль") }, enabled = !m.busy)
            FilterChip(selected = keyAuth, onClick = { keyAuth = true }, label = { Text("SSH-ключ") }, enabled = !m.busy)
        }
        if (keyAuth) {
            Field("Приватный ключ (PEM / OpenSSH)", s.privateKey, !m.busy, secret = true, multiline = true) { s = s.copy(privateKey = it) }
            Field("Пароль ключа", s.passphrase, !m.busy, secret = true) { s = s.copy(passphrase = it) }
        } else Field("Пароль SSH", s.password, !m.busy, secret = true) { s = s.copy(password = it) }
        Field("PM2: имя или абсолютный путь", s.pm2Path, !m.busy) { s = s.copy(pm2Path = it) }
        Field("PM2_HOME (необязательно)", s.pm2Home, !m.busy) { s = s.copy(pm2Home = it) }
        OutlinedButton(shape = themeButtonShape(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { m.probe(s) { s = s.copy(fingerprint = it); verified = false } }, enabled = !m.busy) { Text("Получить отпечаток SSH") }
        if (s.fingerprint.isNotBlank()) {
            SelectionContainer { Text(s.fingerprint, fontFamily = TerminalFont) }
            Text("Сверьте SHA256 с ключом сервера через доверенный канал (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Тип ключа на сервере должен соответствовать согласованному SSH-ключу.", style = MaterialTheme.typography.bodySmall)
            Row { Checkbox(checked = verified, onCheckedChange = { verified = it }, enabled = !m.busy); Text("Отпечаток проверен", Modifier.padding(top = 12.dp)) }
        }
        Button(shape = themeButtonShape(), onClick = { m.saveServer(if (keyAuth) s.copy(password = "") else s.copy(privateKey = "", passphrase = ""), saved) }, enabled = verified && !m.busy, modifier = Modifier.fillMaxWidth()) { Text("Сохранить сервер") }
        Spacer(Modifier.height(24.dp))
    }
}
@Composable private fun NewAppDialog(m: AppModel, close: () -> Unit) {
    var name by remember { mutableStateOf("") }; var script by remember { mutableStateOf("") }; var cwd by remember { mutableStateOf("") }; var node by remember { mutableStateOf("") }
    LaunchedEffect(m.versions) { if (m.versions.none { it.path == node }) node = m.versions.firstOrNull()?.path ?: "" }
    AlertDialog(onDismissRequest = { if (!m.busy) close() }, title = { Text("Новое приложение") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Field("Имя", name, !m.busy) { name = it }; Field("Путь к скрипту", script, !m.busy) { script = it }; Field("Рабочая папка (пусто = папка скрипта)", cwd, !m.busy) { cwd = it }
            Text("Версия Node.js на сервере")
            for (v in m.versions) Row { RadioButton(selected = node == v.path, onClick = { node = v.path }, enabled = !m.busy); Text("${v.version}\n${v.path}", Modifier.padding(top = 8.dp)) }
            if (m.versions.isEmpty()) Text(if (m.busy) "Поиск версий…" else "Версии не найдены")
            TextButton(colors = themeTextButtonColors(), onClick = m::loadVersions, enabled = !m.busy) { Text("Проверить версии") }; ErrorBanner(m)
        }
    }, confirmButton = { TextButton(colors = themeTextButtonColors(), enabled = !m.busy && node.isNotEmpty(), onClick = { m.start(name, script, cwd.ifBlank { script.substringBeforeLast('/', "/").ifBlank { "/" } }, node, close) }) { Text("Запустить") } },
        dismissButton = { TextButton(colors = themeTextButtonColors(), onClick = close, enabled = !m.busy) { Text("Отмена") } })
}
@Composable private fun LogsDialog(m: AppModel, p: ProcessInfo, close: () -> Unit) {
    var stderr by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var text by remember(p.id, stderr) { mutableStateOf("") }
    var issue by remember(p.id, stderr) { mutableStateOf("") }
    var loaded by remember(p.id, stderr) { mutableStateOf(false) }
    var tail by remember(p.id, stderr) { mutableStateOf(true) }
    var scrollRequest by remember { mutableIntStateOf(0) }
    val scroll = rememberScrollState()
    LaunchedEffect(p.id, stderr, reload) {
        while (true) {
            try {
                val result = m.readLogs(p, stderr)
                val follow = followLogTail(loaded, scroll.value, scroll.maxValue)
                text = result; loaded = true; issue = ""; tail = follow
                if (follow) scrollRequest++
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { issue = e.message ?: "Не удалось обновить лог" }
            delay(10_000)
        }
    }
    LaunchedEffect(scrollRequest, scroll.maxValue) {
        if (loaded && tail) scroll.scrollTo(scroll.maxValue)
    }
    AlertDialog(onDismissRequest = close, title = { Text("Логи: ${p.name}") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !stderr, onClick = { stderr = false }, label = { Text("stdout") })
                FilterChip(selected = stderr, onClick = { stderr = true }, label = { Text("stderr") })
            }
            Text("Последние 200 строк · обновление 10 с", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (issue.isNotEmpty()) Text(issue, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            Panel(terminal = true) {
                SelectionContainer {
                    Text(if (loaded) text.ifEmpty { "Лог пуст" } else "Загрузка…",
                        Modifier.fillMaxWidth().heightIn(max = 400.dp).verticalScroll(scroll).padding(16.dp),
                        fontFamily = TerminalFont, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }, confirmButton = { TextButton(colors = themeTextButtonColors(), onClick = { reload++ }) { Text("Обновить") } },
        dismissButton = { TextButton(colors = themeTextButtonColors(), onClick = close) { Text("Закрыть") } })
}
@Composable private fun SecurityScreen(m: AppModel, biometric: (Boolean) -> Unit) {
    var old by remember { mutableStateOf("") }; var pin by remember { mutableStateOf("") }; var confirm by remember { mutableStateOf("") }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Тема оформления", style = MaterialTheme.typography.titleLarge)
        for (theme in AppTheme.entries) {
            Row(Modifier.fillMaxWidth().selectable(selected = m.theme == theme, role = androidx.compose.ui.semantics.Role.RadioButton, onClick = { m.chooseTheme(theme) }).padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                RadioButton(selected = m.theme == theme, onClick = null,
                    colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
                Column(Modifier.weight(1f)) {
                    Text(theme.title, style = MaterialTheme.typography.titleMedium)
                    Text(theme.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        HorizontalDivider()
        Text("Безопасность", style = MaterialTheme.typography.titleLarge)
        Text("При уходе в фон приложение блокируется. Скриншоты и резервное копирование секретов отключены.")
        OutlinedButton(shape = themeButtonShape(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { if (m.biometricEnabled) m.disableBiometric() else biometric(true) }, enabled = !m.busy) { Text(if (m.biometricEnabled) "Выключить биометрию" else "Включить биометрию") }
        Text("Изменить PIN", style = MaterialTheme.typography.titleMedium)
        Field("Текущий PIN", old, !m.busy, true, keyboard = KeyboardType.NumberPassword) { old = it }
        Field("Новый PIN", pin, !m.busy, true, keyboard = KeyboardType.NumberPassword) { pin = it }
        Field("Повторите PIN", confirm, !m.busy, true, keyboard = KeyboardType.NumberPassword) { confirm = it }
        Button(shape = themeButtonShape(), onClick = { m.changePin(old, pin, confirm); old = ""; pin = ""; confirm = "" }, enabled = !m.busy) { Text("Изменить PIN") }
        HorizontalDivider(); Text("pm2m · 1.0.2\nРазработчик: Prizm.Group", style = MaterialTheme.typography.titleMedium)
        SelectionContainer { Text("Поддержка и конфиденциальность: info@filnet.ru") }
        Text("Конфиденциальность", style = MaterialTheme.typography.titleMedium)
        Text("Подключения, пароли и SSH-ключи хранятся зашифрованными только на этом устройстве. Соединения идут напрямую к указанным вами серверам. Prizm.Group не получает эти данные. В приложении нет рекламы, аналитики и Telegram. Биометрические данные обрабатывает Android; приложение их не получает. Удалите подключение, чтобы убрать его из локального хранилища. Сброс PIN удаляет все локальные подключения.")
        Text("Компоненты: AndroidX (Apache 2.0), Kotlin (Apache 2.0), JSch (BSD), Bouncy Castle (MIT). Полные лицензии включены в assets/licenses.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(24.dp))
    }
}
