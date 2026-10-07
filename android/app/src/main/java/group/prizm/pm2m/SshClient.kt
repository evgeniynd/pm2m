package group.prizm.pm2m

import com.jcraft.jsch.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class SshClient {
    private val active = ConcurrentHashMap.newKeySet<Session>()
    fun cancelAll() { active.forEach { it.disconnect() }; active.clear() }
    private fun fingerprint(key: ByteArray) = "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(key))
    private fun repository(expected: String?, observed: (String) -> Unit) = object : HostKeyRepository {
        override fun check(host: String?, key: ByteArray): Int {
            val actual = fingerprint(key); observed(actual)
            return if (expected != null && MessageDigest.isEqual(expected.toByteArray(), actual.toByteArray())) HostKeyRepository.OK else HostKeyRepository.CHANGED
        }
        override fun add(hostkey: HostKey?, ui: UserInfo?) = Unit
        override fun remove(host: String?, type: String?) = Unit
        override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
        override fun getKnownHostsRepositoryID() = "pm2m pinned host key"
        override fun getHostKey(): Array<HostKey> = emptyArray()
        override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
    }
    suspend fun probe(s: Server): String = withContext(Dispatchers.IO) {
        s.validate(false); var observed: String? = null
        val jsch = JSch().apply { hostKeyRepository = repository(null) { observed = it } }
        val session = jsch.getSession(s.username, s.host, s.port)
        active.add(session)
        try {
            session.setConfig("StrictHostKeyChecking", "yes")
            try { session.connect(12000) } catch (e: JSchException) { if (observed == null) throw e }
            currentCoroutineContext().ensureActive()
            observed ?: error("Сервер не прислал ключ SSH")
        } finally { session.disconnect(); active.remove(session) }
    }
    suspend fun execute(s: Server, command: String): String = withContext(Dispatchers.IO) {
        s.validate(); var changed = false
        val jsch = JSch().apply { hostKeyRepository = repository(s.fingerprint) { changed = it != s.fingerprint } }
        if (s.privateKey.isNotBlank()) jsch.addIdentity(s.id, s.privateKey.toByteArray(), null, s.passphrase.takeIf { it.isNotEmpty() }?.toByteArray())
        val session = jsch.getSession(s.username, s.host, s.port)
        active.add(session)
        try {
            session.setConfig("StrictHostKeyChecking", "yes")
            session.setConfig("PreferredAuthentications", if (s.privateKey.isNotBlank()) "publickey" else "password")
            if (s.privateKey.isBlank()) session.setPassword(s.password)
            session.timeout = 30000; session.connect(12000)
            currentCoroutineContext().ensureActive()
            val channel = session.openChannel("exec") as ChannelExec
            try {
                channel.setCommand(command); channel.setInputStream(null)
                val output = channel.inputStream; val errors = channel.errStream
                channel.connect(12000)
                val out = ByteArrayOutputStream(); val err = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                val deadline = System.nanoTime() + 30_000_000_000L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    for ((stream, destination) in listOf(output to out, errors to err)) while (stream.available() > 0) {
                        val size = stream.read(buffer, 0, minOf(buffer.size, stream.available()))
                        if (size < 0) break
                        destination.write(buffer, 0, size)
                        check(out.size() + err.size() <= 4 * 1024 * 1024) { "Ответ SSH превышает 4 МБ" }
                    }
                    if (channel.isClosed && output.available() == 0 && errors.available() == 0) break
                    check(System.nanoTime() < deadline) { "Команда не завершилась за 30 секунд. Проверьте состояние перед повтором." }
                    delay(25)
                }
                check(channel.exitStatus == 0) { err.toString("UTF-8").take(800).ifBlank { "SSH: код ${channel.exitStatus}" } }
                out.toString("UTF-8")
            } finally { channel.disconnect() }
        } catch (e: JSchException) {
            if (changed) error("Отпечаток SSH изменился. Сверьте новый ключ на сервере перед обновлением подключения.")
            throw IllegalStateException("Не удалось подключиться по SSH: проверьте адрес, ключ/пароль и доступ к сети.", e)
        } finally { session.disconnect(); active.remove(session); jsch.removeAllIdentity() }
    }
    suspend fun processes(s: Server) = Commands.parseProcesses(execute(s, Commands.pm2(s, "jlist")))
    suspend fun action(s: Server, p: ProcessInfo, action: String) {
        val current = processes(s).find { it.id == p.id }
        check(current != null && current.name == p.name && current.script == p.script) { "Приложение изменилось. Обновите список." }
        execute(s, Commands.action(s, p.id, action))
    }
    suspend fun logs(s: Server, p: ProcessInfo, stderr: Boolean): String {
        val current = processes(s).find { it.id == p.id && it.name == p.name && it.script == p.script } ?: error("Приложение изменилось")
        val file = if (stderr) current.errLog else current.outLog
        if (file.isEmpty()) return "Нет записей"
        return execute(s, "if [ -f ${Commands.quote(file)} ]; then tail -c 131072 -- ${Commands.quote(file)} | tail -n 200; fi").ifBlank { "Нет записей" }
    }
    suspend fun versions(s: Server, discovery: String): List<NodeVersion> = execute(s, Commands.shell(s, discovery)).lineSequence().mapNotNull {
        val parts = it.split('\t'); if (parts.size >= 2 && Regex("v[0-9]+\\.[0-9]+\\.[0-9]+.*").matches(parts[0]) && parts[1].startsWith('/')) NodeVersion(parts[0], parts[1]) else null
    }.distinctBy { it.path }.toList()
    suspend fun start(s: Server, name: String, script: String, cwd: String, node: String, discovery: String) {
        Commands.validateStart(name, script, cwd, node)
        check(versions(s, discovery).any { it.path == node }) { "Выбранная версия Node.js недоступна" }
        execute(s, "test -f ${Commands.quote(script)} && test -d ${Commands.quote(cwd)}")
        execute(s, Commands.pm2(s, "start", script, "--name", name, "--cwd", cwd, "--interpreter", node))
    }
}
