package group.prizm.pm2m

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class VaultTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val vault = Vault(context)
    @After fun cleanup() { vault.reset() }
    @Test fun wrongPinIsRejectedAndCredentialsStayEncrypted() {
        vault.reset()
        val key = vault.setup("937264")
        val s = Server(name = "fixture", host = "192.0.2.1", username = "test", password = "unique-private-password")
        vault.save(key, listOf(s))
        val disk = File(context.noBackupFilesDir, "vault.json").readText()
        assertFalse(disk.contains(s.password)); assertFalse(disk.contains("937264"))
        assertThrows(IllegalStateException::class.java) { vault.unlock("000000") }
        val reopened = Vault(context).unlock("937264")
        assertEquals(listOf(s), vault.servers(reopened))
        vault.changePin("937264", "827361")
        assertThrows(IllegalStateException::class.java) { vault.unlock("937264") }
        assertEquals(listOf(s), vault.servers(vault.unlock("827361")))
        key.fill(0); reopened.fill(0)
    }
    @Test fun repeatedFailuresSurviveReopening() {
        vault.reset(); vault.setup("937264").fill(0)
        repeat(5) { runCatching { vault.unlock("000000") } }
        assertThrows(IllegalStateException::class.java) { Vault(context).unlock("937264") }
    }
}
