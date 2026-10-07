package group.prizm.pm2m

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

class Vault(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "vault.json"))
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val exists: Boolean get() = file.baseFile.exists()
    private fun read() = JSONObject(file.openRead().bufferedReader().use { it.readText() })
    private fun write(value: JSONObject) {
        val output = file.startWrite()
        try { output.write(value.toString().toByteArray()); file.finishWrite(output) }
        catch (e: Exception) { file.failWrite(output); throw e }
    }
    private fun encode(value: ByteArray) = Base64.getEncoder().encodeToString(value)
    private fun decode(value: String) = Base64.getDecoder().decode(value)
    private fun random() = ByteArray(32).also { SecureRandom().nextBytes(it) }
    private fun deviceKey(alias: String, biometric: Boolean = false): SecretKey {
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
        if (biometric) spec.setUserAuthenticationRequired(true).setUserAuthenticationValidityDurationSeconds(-1).setInvalidatedByBiometricEnrollment(true)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec.build()) }.generateKey()
    }
    private fun pack(cipher: Cipher, bytes: ByteArray) = encode(cipher.iv) + "." + encode(cipher.doFinal(bytes))
    private fun seal(key: SecretKey, bytes: ByteArray): String = Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.ENCRYPT_MODE, key); pack(this, bytes) }
    private fun unseal(key: SecretKey, value: String): ByteArray {
        val parts = value.split('.')
        return Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode(parts[0]))); doFinal(decode(parts[1])) }
    }
    private fun derive(pin: String, salt: ByteArray): SecretKey {
        require(Regex("[0-9]{6,12}").matches(pin)) { "PIN: от 6 до 12 цифр" }
        val chars = pin.toCharArray(); val spec = PBEKeySpec(chars, salt, 210000, 256)
        try { return SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES") }
        finally { chars.fill('\u0000'); spec.clearPassword() }
    }
    fun setup(pin: String): ByteArray {
        check(!exists) { "PIN уже задан" }
        val salt = random(); val master = random()
        val wrapped = seal(derive(pin, salt), master)
        val j = JSONObject().put("version", 1).put("salt", encode(salt))
            .put("pin", seal(deviceKey("pm2m.device"), wrapped.toByteArray()))
            .put("data", seal(SecretKeySpec(master, "AES"), "[]".toByteArray()))
        write(j); return master
    }
    fun unlock(pin: String): ByteArray {
        val j = read(); val remaining = j.optLong("retryAt") - System.currentTimeMillis()
        check(remaining <= 0) { "Повторите через ${(remaining + 999) / 1000} с" }
        try {
            val wrapped = unseal(deviceKey("pm2m.device"), j.getString("pin")).toString(Charsets.UTF_8)
            val master = unseal(derive(pin, decode(j.getString("salt"))), wrapped)
            j.put("failures", 0).put("retryAt", 0); write(j); return master
        } catch (_: Exception) {
            val failures = j.optInt("failures") + 1
            val wait = if (failures < 5) 0L else minOf(300L, 15L * (1L shl minOf(failures - 5, 5)))
            j.put("failures", failures).put("retryAt", System.currentTimeMillis() + wait * 1000); write(j)
            error(if (wait > 0) "Неверный PIN. Повторите через $wait с" else "Неверный PIN или хранилище недоступно")
        }
    }
    fun servers(master: ByteArray): List<Server> {
        val array = JSONArray(unseal(SecretKeySpec(master, "AES"), read().getString("data")).toString(Charsets.UTF_8))
        return (0 until array.length()).map { Server.from(array.getJSONObject(it)) }
    }
    fun save(master: ByteArray, servers: List<Server>) {
        val j = read(); j.put("data", seal(SecretKeySpec(master, "AES"), JSONArray().apply { servers.forEach { put(it.json()) } }.toString().toByteArray())); write(j)
    }
    fun changePin(old: String, new: String) {
        val master = unlock(old)
        try {
            val j = read(); val salt = random()
            j.put("salt", encode(salt)).put("pin", seal(deviceKey("pm2m.device"), seal(derive(new, salt), master).toByteArray()))
            write(j)
        } finally { master.fill(0) }
    }
    val biometricEnabled: Boolean get() = exists && read().has("biometric")
    fun enrollmentCipher(): Cipher {
        keyStore.deleteEntry("pm2m.biometric")
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, deviceKey("pm2m.biometric", true)) }
    }
    fun completeEnrollment(cipher: Cipher, master: ByteArray) { val j = read(); j.put("biometric", pack(cipher, master)); write(j) }
    fun biometricCipher(): Cipher {
        val parts = read().getString("biometric").split('.')
        val key = keyStore.getKey("pm2m.biometric", null) as? SecretKey ?: error("Войдите по PIN и включите биометрию заново")
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode(parts[0]))) }
    }
    fun unlockBiometric(cipher: Cipher) = cipher.doFinal(decode(read().getString("biometric").split('.')[1]))
    fun disableBiometric() { val j = read(); j.remove("biometric"); write(j); keyStore.deleteEntry("pm2m.biometric") }
    fun reset() { file.delete(); keyStore.deleteEntry("pm2m.device"); keyStore.deleteEntry("pm2m.biometric") }
}
