package group.prizm.pm2m

internal fun followLogTail(loaded: Boolean, offset: Int, maximum: Int) = !loaded || offset >= maximum - 24

internal class BiometricEntryGate {
    private var requestedEpoch = -1
    fun claim(epoch: Int, enabled: Boolean, unlocked: Boolean, busy: Boolean): Boolean {
        if (!enabled || unlocked || busy || requestedEpoch == epoch) return false
        requestedEpoch = epoch
        return true
    }
}
