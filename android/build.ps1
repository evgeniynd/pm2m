param([string[]]$Tasks = @('testDebugUnitTest', 'lintDebug', 'assembleDebug', 'bundleRelease'))
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$portableJdk = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tooling/jdk') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
$previousJavaHome = $env:JAVA_HOME
$previousPath = $env:PATH
try {
    if ($portableJdk) { $env:JAVA_HOME = $portableJdk.FullName; $env:PATH = "$($portableJdk.FullName)/bin;$env:PATH" }
    & (Join-Path $projectRoot 'gradlew.bat') -p $projectRoot @Tasks --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed: $LASTEXITCODE" }
} finally { $env:JAVA_HOME = $previousJavaHome; $env:PATH = $previousPath }
