package group.prizm.pm2m

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val TerminalFont = FontFamily(Font(R.font.plex_mono))
private val uiFont = FontFamily(Font(R.font.inter))
private val headingFont = FontFamily(Font(R.font.figtree))
private fun type(size: Int, heading: Boolean = false, railway: Boolean = false) = TextStyle(
    fontFamily = if (heading) { if (railway) FontFamily(Font(R.font.plex_serif)) else headingFont } else uiFont,
    fontWeight = if (heading) FontWeight.Medium else FontWeight.Normal,
    fontSize = size.sp, lineHeight = (size * 1.4).sp, letterSpacing = (-size * .02).sp)
private val palette = darkColorScheme(
    primary = Color.White, onPrimary = Color(0xFF050606),
    secondary = Color(0xFF85A6E9), onSecondary = Color(0xFF0B0C0E),
    background = Color(0xFF0B0C0E), onBackground = Color.White,
    surface = Color(0xFF0E111B), onSurface = Color.White,
    surfaceVariant = Color(0xFF0D172B), onSurfaceVariant = Color(0xFFABAEBB),
    primaryContainer = Color(0xFF12244F), onPrimaryContainer = Color.White,
    secondaryContainer = Color(0xFF12244F), onSecondaryContainer = Color.White,
    outline = Color(0xFF24375A), outlineVariant = Color(0xFF172540))

enum class AppTheme(val id: String, val title: String, val description: String) {
    AGENTQL("agentql", "AgentQL", "Тёмно-синие поверхности, белые кнопки и заголовки Figtree"),
    RAILWAY("railway", "Railway", "Ночное небо, лиловые кнопки и заголовки IBM Plex Serif");
    companion object { fun fromId(id: String?) = entries.firstOrNull { it.id == id } ?: AGENTQL }
}
private val LocalAppTheme = staticCompositionLocalOf { AppTheme.AGENTQL }
private val railwayPalette = darkColorScheme(
    primary = Color(0xFF553F83), onPrimary = Color(0xFFF7F7F8),
    secondary = Color(0xFFBF92EC), onSecondary = Color(0xFF13111C),
    background = Color(0xFF13111C), onBackground = Color(0xFFF7F7F8),
    surface = Color(0xFF1A191F), onSurface = Color(0xFFF7F7F8),
    surfaceVariant = Color(0xFF1A191F), onSurfaceVariant = Color(0xFFA1A0AB),
    primaryContainer = Color(0xFF553F83), onPrimaryContainer = Color(0xFFF7F7F8),
    secondaryContainer = Color(0xFF553F83), onSecondaryContainer = Color(0xFFF7F7F8),
    outline = Color(0xFF868593), outlineVariant = Color(0xFF33323E),
    error = Color(0xFFFFB4AB), errorContainer = Color(0xFF601410))

@Composable fun themeButtonShape() = RoundedCornerShape(if (LocalAppTheme.current == AppTheme.RAILWAY) 8.dp else 100.dp)
@Composable fun themeInputShape() = RoundedCornerShape(if (LocalAppTheme.current == AppTheme.RAILWAY) 6.dp else 8.dp)
@Composable fun themeTextButtonColors() = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
@Composable fun themeFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = if (LocalAppTheme.current == AppTheme.RAILWAY) Color(0xFFA05FCF) else MaterialTheme.colorScheme.primary,
    focusedLabelColor = MaterialTheme.colorScheme.secondary, cursorColor = MaterialTheme.colorScheme.secondary)

@Composable fun Pm2mTheme(theme: AppTheme, content: @Composable () -> Unit) {
    val railway = theme == AppTheme.RAILWAY
    CompositionLocalProvider(LocalAppTheme provides theme) {
    MaterialTheme(colorScheme = if (railway) railwayPalette else palette, typography = Typography(
        displayMedium = type(48, true, railway), headlineLarge = type(36, true, railway),
        headlineMedium = type(32, true, railway), headlineSmall = type(28, true, railway),
        titleLarge = type(20), titleMedium = type(16), titleSmall = type(14),
        bodyLarge = type(16), bodyMedium = type(14), bodySmall = type(12),
        labelLarge = type(15), labelMedium = type(12), labelSmall = type(11)),
        shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(12.dp)),
        content = content)
    }
}

@Composable fun Modifier.aurora(): Modifier {
    val railway = LocalAppTheme.current == AppTheme.RAILWAY
    return drawBehind {
    if (railway) {
        drawRect(Brush.radialGradient(listOf(Color(0x35553F83), Color.Transparent),
            center = Offset(size.width * .65f, size.height * .2f), radius = size.width))
        repeat(28) { i ->
            drawCircle(Color(0x44868593), radius = if (i % 3 == 0) 1.5f else 1f,
                center = Offset(size.width * ((i * 37 % 101) / 101f), size.height * ((i * 19 % 97) / 97f)))
        }
    } else {
    drawRect(Brush.radialGradient(listOf(Color(0x61625FFF), Color.Transparent),
        center = Offset(size.width * .2f, 0f), radius = size.width * .95f))
    drawRect(Brush.radialGradient(listOf(Color(0x35FF7DDA), Color.Transparent),
        center = Offset(size.width, size.height * .85f), radius = size.width * .65f))
    }
    }
}

@Composable fun Panel(terminal: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(containerColor = if (terminal && LocalAppTheme.current == AppTheme.RAILWAY) Color(0xFF0D0C14) else MaterialTheme.colorScheme.surfaceVariant), content = content)
}

@Composable fun PageHeading(label: String, title: String) {
    Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.headlineMedium)
    }
}
