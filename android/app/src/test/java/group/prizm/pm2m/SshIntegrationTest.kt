package group.prizm.pm2m

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

class SshIntegrationTest {
    @Test fun verifiesHostKeyBeforePasswordAndReadsRealSshOutput() = runBlocking {
        val port = System.getenv("PM2M_SSH_TEST_PORT")?.toIntOrNull()
        assumeTrue("Run scripts/ssh-fixture.mjs and set PM2M_SSH_TEST_PORT", port != null)
        val ssh = SshClient()
        val s = Server(name = "Test", host = "127.0.0.1", port = port!!, username = "demo", password = "fixture-only")
        try {
            val fingerprint = ssh.probe(s)
            assertTrue(fingerprint.startsWith("SHA256:"))
            val trusted = s.copy(fingerprint = fingerprint)
            assertEquals("SSH работает\n", ssh.execute(trusted, "fixture-hello"))
            assertEquals("api", ssh.processes(trusted).single().name)
            try { ssh.execute(trusted.copy(fingerprint = "SHA256:" + "a".repeat(43)), "fixture-hello"); fail("Changed key accepted") }
            catch (e: IllegalStateException) { assertTrue(e.message!!.contains("Отпечаток")) }
            try { ssh.execute(trusted.copy(password = "wrong"), "fixture-hello"); fail("Wrong password accepted") }
            catch (e: IllegalStateException) { assertTrue(e.message!!.contains("SSH")) }
        } finally { ssh.cancelAll() }
    }
}
