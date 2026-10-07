package group.prizm.pm2m

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

class MainActivity : FragmentActivity() {
    private val model: AppModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        if (Security.getProvider("BC") !is BouncyCastleProvider) { Security.removeProvider("BC"); Security.addProvider(BouncyCastleProvider()) }
        setContent { Pm2mApp(model, ::biometric, ::biometricAvailable) }
    }
    private fun biometricAvailable() = BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    private fun biometric(enroll: Boolean) {
        if (!biometricAvailable()) { model.error = "Добавьте отпечаток или поддерживаемую биометрию в настройках Android. Можно пользоваться PIN."; return }
        val epoch = model.epoch
        try {
            val cipher = if (enroll) model.vault.enrollmentCipher() else model.vault.biometricCipher()
            val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val authorized = result.cryptoObject?.cipher ?: return
                    if (enroll) model.biometricEnrolled(authorized, epoch) else model.biometricUnlocked(authorized, epoch)
                }
                override fun onAuthenticationError(code: Int, text: CharSequence) {
                    if (code != BiometricPrompt.ERROR_NEGATIVE_BUTTON && code != BiometricPrompt.ERROR_USER_CANCELED && model.epoch == epoch) model.error = text.toString()
                }
            })
            prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(if (enroll) "Включить биометрию" else "Вход в pm2m")
                .setSubtitle("Подтвердите доступ к SSH-подключениям")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText(if (enroll) "Позже" else "Ввести PIN").build(), BiometricPrompt.CryptoObject(cipher))
        } catch (_: Exception) { model.error = "Биометрический ключ недоступен. Войдите по PIN и включите биометрию заново." }
    }
    override fun onResume() {
        super.onResume()
        if (model.claimAutoBiometric()) biometric(false)
    }
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) model.lock()
    }
}
