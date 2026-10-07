package group.prizm.pm2m

import org.junit.Assert.*
import org.junit.Test

class RefreshPolicyTest {
    @Test fun logOpensAtEndButPreservesReadingEarlierLines() {
        assertTrue(followLogTail(false, 0, 1500))
        assertTrue(followLogTail(true, 1500, 1500))
        assertFalse(followLogTail(true, 500, 1500))
        assertTrue(followLogTail(true, 0, 0))
    }
    @Test fun cancelledBiometricDoesNotLoopButNextEntryPromptsAgain() {
        val gate = BiometricEntryGate()
        assertFalse(gate.claim(0, false, false, false))
        assertTrue(gate.claim(0, true, false, false))
        assertFalse(gate.claim(0, true, false, false))
        assertTrue(gate.claim(1, true, false, false))
        assertFalse(gate.claim(2, true, true, false))
        assertFalse(gate.claim(2, true, false, true))
        assertTrue(gate.claim(2, true, false, false))
    }
}
