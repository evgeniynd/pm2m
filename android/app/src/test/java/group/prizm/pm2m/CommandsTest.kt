package group.prizm.pm2m

import org.junit.Assert.*
import org.junit.Test

class CommandsTest {
    @Test fun shellArgumentsAreQuoted() {
        assertEquals("'a'\\''b;\$(whoami)'", Commands.quote("a'b;\$(whoami)"))
        val s = Server(pm2Path = "/opt/node 22/bin/pm2", pm2Home = "/home/a's/.pm2")
        val command = Commands.pm2(s, "start", "/srv/a;echo hacked.js")
        assertTrue(command.startsWith("bash -lc "))
        assertTrue(command.contains("export PATH="))
        assertTrue(command.contains("PM2_HOME="))
    }
    @Test fun onlySupportedActionsAreAllowed() {
        assertThrows(IllegalArgumentException::class.java) { Commands.action(Server(), -1, "stop") }
        assertThrows(IllegalArgumentException::class.java) { Commands.action(Server(), 1, "kill") }
        assertTrue(Commands.action(Server(), 7, "start").contains("restart"))
    }
    @Test fun parsesListAfterPm2Banner() {
        val list = Commands.parseProcesses("[PM2] Starting daemon\n[{\"pm_id\":2,\"name\":\"p2p\",\"pm2_env\":{\"status\":\"online\",\"pm_exec_path\":\"/srv/app.js\",\"restart_time\":4},\"monit\":{\"cpu\":1.5,\"memory\":123}}]")
        assertEquals(2, list.single().id); assertEquals("online", list.single().status)
        assertEquals(4, list.single().restarts); assertEquals(123L, list.single().memory)
        assertThrows(IllegalStateException::class.java) { Commands.parseProcesses("not JSON") }
    }
    @Test fun startRequiresAbsolutePaths() {
        Commands.validateStart("my-api", "/srv/index.js", "/srv", "/usr/bin/node")
        assertThrows(IllegalArgumentException::class.java) { Commands.validateStart("a;rm", "/srv/app", "/srv", "/bin/node") }
        assertThrows(IllegalArgumentException::class.java) { Commands.validateStart("app", "app.js", "/srv", "/bin/node") }
    }
    @Test fun persistedServerRoundTrip() {
        val s = Server(name = "SSH", host = "192.0.2.1", username = "deploy", password = "secret", fingerprint = "SHA256:" + "a".repeat(43))
        s.validate(); assertEquals(s, Server.from(s.json()))
        assertThrows(IllegalArgumentException::class.java) { s.copy(fingerprint = "").validate() }
        assertThrows(IllegalArgumentException::class.java) { s.copy(host = "x; y").validate() }
    }
}
