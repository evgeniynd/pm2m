package group.prizm.pm2m

import android.app.Application
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import javax.crypto.Cipher

class AppModel(app: Application) : AndroidViewModel(app) {
    private val appearance = app.getSharedPreferences("appearance", android.content.Context.MODE_PRIVATE)
    var theme by mutableStateOf(AppTheme.fromId(appearance.getString("theme", null))); private set
    fun chooseTheme(value: AppTheme) {
        appearance.edit().putString("theme", value.id).apply()
        theme = value
    }
    val vault = Vault(app)
    private val ssh = SshClient()
    private var master: ByteArray? = null
    private var work: Job? = null
    private var polling: Job? = null
    private val biometricEntry = BiometricEntryGate()
    fun claimAutoBiometric() = biometricEntry.claim(epoch, biometricEnabled, unlocked, busy)
    var epoch = 0; private set
    var initialized by mutableStateOf(vault.exists); private set
    var unlocked by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf("")
    var message by mutableStateOf("")
    var offerBiometric by mutableStateOf(false)
    var biometricEnabled by mutableStateOf(runCatching { vault.biometricEnabled }.getOrDefault(false)); private set
    var servers by mutableStateOf<List<Server>>(emptyList()); private set
    var selected by mutableStateOf<Server?>(null); private set
    var processes by mutableStateOf<List<ProcessInfo>>(emptyList()); private set
    var versions by mutableStateOf<List<NodeVersion>>(emptyList()); private set
    var logs by mutableStateOf(""); private set
    private val discovery get() = getApplication<Application>().assets.open("discover-node.sh").bufferedReader().use { it.readText() }
    fun task(block: suspend () -> Unit) {
        if (busy) return
        polling?.cancel()
        busy = true; error = ""; val started = epoch
        work = viewModelScope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (epoch == started) error = e.message ?: "Не удалось выполнить действие" }
            finally { initialized = vault.exists; if (epoch == started) busy = false }
        }
    }
    private fun open(key: ByteArray) {
        try { servers = vault.servers(key); master = key; initialized = true; unlocked = true }
        catch (e: Exception) { key.fill(0); throw e }
    }
    fun login(pin: String, confirmation: String = "") = task {
        val first = !vault.exists
        if (first) require(pin == confirmation) { "PIN-коды не совпадают" }
        val key = withContext(Dispatchers.IO) { if (first) vault.setup(pin) else vault.unlock(pin) }
        open(key); if (first) offerBiometric = true
    }
    fun biometricUnlocked(cipher: Cipher, started: Int) {
        if (epoch != started) return
        runCatching { open(vault.unlockBiometric(cipher)) }.onFailure { error = "Биометрия недоступна. Войдите по PIN." }
    }
    fun biometricEnrolled(cipher: Cipher, started: Int) {
        if (epoch != started || !unlocked) return
        runCatching { vault.completeEnrollment(cipher, master!!); biometricEnabled = true; offerBiometric = false }
            .onFailure { error = "Не удалось включить биометрию. PIN продолжает работать." }
    }
    fun disableBiometric() { vault.disableBiometric(); biometricEnabled = false }
    fun changePin(old: String, new: String, confirm: String) = task {
        require(new == confirm) { "PIN-коды не совпадают" }
        withContext(Dispatchers.IO) { vault.changePin(old, new) }; message = "PIN изменён"
    }
    fun lock() {
        epoch++; work?.cancel(); polling?.cancel(); ssh.cancelAll(); master?.fill(0); master = null
        servers = emptyList(); selected = null; processes = emptyList(); versions = emptyList(); logs = ""
        unlocked = false; busy = false; error = ""; message = ""; offerBiometric = false
    }
    fun reset() { lock(); vault.reset(); initialized = false; biometricEnabled = false }
    fun saveServer(s: Server, done: () -> Unit) = task {
        s.validate(); require(s.password.isNotBlank() || s.privateKey.isNotBlank()) { "Укажите пароль или приватный ключ" }
        require(s.privateKey.length <= 65536) { "Ключ слишком большой" }
        val next = servers.filterNot { it.id == s.id } + s
        vault.save(master!!, next); servers = next; done()
    }
    fun removeServer(s: Server) = task {
        val next = servers.filterNot { it.id == s.id }; vault.save(master!!, next); servers = next
        if (selected?.id == s.id) back()
    }
    fun probe(s: Server, done: (String) -> Unit) = task { done(ssh.probe(s)) }
    fun select(s: Server) { selected = s; processes = emptyList(); refreshError = ""; refresh() }
    fun back() { epoch++; work?.cancel(); polling?.cancel(); ssh.cancelAll(); busy = false; selected = null; processes = emptyList(); logs = ""; error = ""; refreshError = "" }
    var refreshError by mutableStateOf(""); private set
    fun refresh() {
        val s = selected ?: return
        if (busy || polling?.isActive == true) return
        val started = epoch
        polling = viewModelScope.launch {
            try {
                val result = ssh.processes(s)
                ensureActive()
                if (epoch == started && selected?.id == s.id) { processes = result; refreshError = "" }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { if (epoch == started) refreshError = "Нет связи. Показаны последние данные." }
        }
    }
    suspend fun readLogs(p: ProcessInfo, stderr: Boolean): String {
        val s = selected ?: error("Сервер не выбран")
        return ssh.logs(s, p, stderr)
    }
    fun action(p: ProcessInfo, action: String) { val s = selected ?: return; task { ssh.action(s, p, action); processes = ssh.processes(s); message = "Действие выполнено" } }
    fun savePm2() { val s = selected ?: return; task { ssh.execute(s, Commands.pm2(s, "save")); message = "Список PM2 сохранён" } }
    fun loadLogs(p: ProcessInfo, stderr: Boolean) { val s = selected ?: return; logs = ""; task { logs = ssh.logs(s, p, stderr) } }
    fun loadVersions() { val s = selected ?: return; versions = emptyList(); task { versions = ssh.versions(s, discovery) } }
    fun start(name: String, script: String, cwd: String, node: String, done: () -> Unit) { val s = selected ?: return; task {
        ssh.start(s, name, script, cwd, node, discovery); processes = ssh.processes(s); done(); message = "Приложение запущено"
    } }
    override fun onCleared() { lock(); super.onCleared() }
}
