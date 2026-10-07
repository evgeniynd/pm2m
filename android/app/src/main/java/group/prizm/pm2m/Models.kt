package group.prizm.pm2m

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.UUID

data class Server(
    val id: String = UUID.randomUUID().toString(), val name: String = "", val host: String = "",
    val port: Int = 22, val username: String = "", val password: String = "",
    val privateKey: String = "", val passphrase: String = "", val fingerprint: String = "",
    val pm2Path: String = "pm2", val pm2Home: String = ""
) {
    fun validate(requireFingerprint: Boolean = true) {
        require(name.isNotBlank() && name.length <= 80) { "Укажите название сервера" }
        require(host.isNotBlank() && host.length <= 253 && !host.any { it.isWhitespace() || it in "/@\u0000" }) { "Неверный адрес сервера" }
        require(port in 1..65535 && username.isNotBlank() && !username.any { it.isWhitespace() || it == '\u0000' }) { "Проверьте порт и пользователя" }
        require(pm2Path == "pm2" || (pm2Path.startsWith('/') && !pm2Path.any { it == '\u0000' || it == '\n' })) { "PM2: укажите pm2 или абсолютный путь" }
        require(pm2Home.isEmpty() || pm2Home.startsWith('/')) { "PM2_HOME должен быть абсолютным путём" }
        if (requireFingerprint) require(Regex("SHA256:[A-Za-z0-9+/]{43}").matches(fingerprint)) { "Получите и проверьте отпечаток SSH" }
    }
    fun json() = JSONObject().apply {
        put("id", id); put("name", name); put("host", host); put("port", port); put("username", username)
        put("password", password); put("privateKey", privateKey); put("passphrase", passphrase)
        put("fingerprint", fingerprint); put("pm2Path", pm2Path); put("pm2Home", pm2Home)
    }
    companion object {
        fun from(j: JSONObject) = Server(j.getString("id"), j.getString("name"), j.getString("host"), j.optInt("port", 22),
            j.getString("username"), j.optString("password"), j.optString("privateKey"), j.optString("passphrase"),
            j.getString("fingerprint"), j.optString("pm2Path", "pm2"), j.optString("pm2Home"))
    }
}
data class ProcessInfo(val id: Int, val name: String, val status: String, val cpu: Double, val memory: Long,
    val restarts: Int, val script: String, val outLog: String, val errLog: String, val uptime: Long, val mode: String)
data class NodeVersion(val version: String, val path: String)

object Commands {
    fun quote(value: String): String {
        require(!value.contains('\u0000')) { "Недопустимый нулевой символ" }
        return "'" + value.replace("'", "'\\''") + "'"
    }
    fun environment(s: Server): String = if (s.pm2Path.startsWith('/'))
        "export PATH=" + quote(s.pm2Path.substringBeforeLast('/')) + ":\"\$PATH\"; "
    else "if ! command -v pm2 >/dev/null 2>&1; then if [ -s \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" ]; then . \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" >/dev/null; fi; fi; "
    fun shell(s: Server, body: String) = "bash -lc " + quote(environment(s) + body)
    fun pm2(s: Server, vararg args: String) = shell(s, (if (s.pm2Home.isBlank()) "" else "PM2_HOME=${quote(s.pm2Home)} ") + quote(s.pm2Path) + " " + args.joinToString(" ", transform = ::quote))
    fun action(s: Server, id: Int, action: String): String {
        require(id >= 0 && action in setOf("start", "stop", "restart", "reload", "delete"))
        return pm2(s, if (action == "start") "restart" else action, id.toString())
    }
    fun parseProcesses(text: String): List<ProcessInfo> {
        for (index in text.indices.filter { text[it] == '[' }) {
            try {
            val parser = JSONTokener(text.substring(index))
            val array = parser.nextValue() as? JSONArray ?: continue
            if (parser.nextClean() != '\u0000') continue
            return (0 until array.length()).map { i ->
                val p = array.getJSONObject(i); val e = p.optJSONObject("pm2_env") ?: JSONObject(); val m = p.optJSONObject("monit") ?: JSONObject()
                ProcessInfo(p.getInt("pm_id"), p.getString("name"), e.optString("status"), m.optDouble("cpu", 0.0), m.optLong("memory"),
                    e.optInt("restart_time"), e.optString("pm_exec_path"), e.optString("pm_out_log_path"), e.optString("pm_err_log_path"),
                    e.optLong("pm_uptime"), e.optString("exec_mode"))
            }
            } catch (_: Exception) { continue }
        }
        error("PM2 вернул некорректный список. Проверьте путь и SSH-окружение.")
    }
    fun validateStart(name: String, script: String, cwd: String, node: String) {
        require(Regex("[a-zA-Z0-9_-]{1,64}").matches(name)) { "Имя: латиница, цифры, _ и -" }
        require(listOf(script, cwd, node).all { it.startsWith('/') && !it.any { c -> c == '\u0000' || c == '\n' } }) { "Укажите абсолютные пути скрипта, папки и Node.js" }
    }
}
