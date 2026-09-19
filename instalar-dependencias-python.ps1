# instalar-dependencias-python.ps1
#
# Deja el proyecto listo para correr los modulos Python SIN necesitar que
# la PC tenga Python instalado. Hace dos cosas:
#
#  1) Descarga el paquete "embeddable" oficial de Python (un Python
#     redistribuible, sin instalador, pensado exactamente para esto) a
#     ./python-embed, y le bootstrapea pip adentro.
#  2) Para cada modulo Python, instala su requirements.txt en su propia
#     carpeta modules/<nombre>/vendor usando ESE Python embebido. Cada
#     main.py ya sabe agregarse su propio vendor/ al arrancar
#     (site.addsitedir), asi que alcanza con ejecutarlo con python-embed.
#
# Ademas, por las dudas, tambien arma un venv por modulo (requiere que ESTA
# pc ya tenga Python) como respaldo -- pero lo que realmente hace el
# proyecto portable a una PC sin Python es el paso 1+2.
#
# Se puede correr de nuevo mas adelante sin problema.

$ErrorActionPreference = "Stop"

$VERSION_PYTHON = "3.14.5"
$raiz = $PSScriptRoot
$carpetaEmbed = Join-Path $raiz "python-embed"
$modulos = @("captura_pantalla", "control_remoto", "convertir", "escanear", "imprimir", "ocr")

# ============================================================
# PASO 1: Python embebido (si no existe todavia)
# ============================================================
$pythonEmbedExe = Join-Path $carpetaEmbed "python.exe"

if (-not (Test-Path $pythonEmbedExe)) {
    Write-Host "=== Descargando Python $VERSION_PYTHON embebido ===" -ForegroundColor Cyan

    $zipUrl = "https://www.python.org/ftp/python/$VERSION_PYTHON/python-$VERSION_PYTHON-embed-amd64.zip"
    $zipPath = Join-Path $raiz "python-embed.zip"

    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $carpetaEmbed -Force
    Remove-Item $zipPath

    # El ._pth trae "import site" comentado por default -- hay que
    # habilitarlo para que pip y los .pth de paquetes (pywin32, etc)
    # funcionen. El nombre exacto del archivo cambia segun la version
    # (ej. python314._pth), asi que lo buscamos en vez de hardcodearlo.
    $pth = Get-ChildItem $carpetaEmbed -Filter "python3*._pth" | Select-Object -First 1
    (Get-Content $pth.FullName) -replace '#\s*import site', 'import site' | Set-Content $pth.FullName

    Write-Host "Bootstrapeando pip..."
    $getPip = Join-Path $raiz "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    & $pythonEmbedExe $getPip --no-warn-script-location | Out-Null
    Remove-Item $getPip

    Write-Host "Python embebido listo." -ForegroundColor Green
} else {
    Write-Host "Python embebido ya existe en $carpetaEmbed, reutilizando." -ForegroundColor DarkGray
}

# ============================================================
# PASO 2: vendor por modulo, usando el Python embebido
# ============================================================
Write-Host ""
Write-Host "=== Instalando dependencias de cada modulo en su vendor/ ===" -ForegroundColor Cyan

foreach ($nombre in $modulos) {
    $carpetaModulo = Join-Path $raiz "modules\$nombre"
    $requirements = Join-Path $carpetaModulo "requirements.txt"
    $vendor = Join-Path $carpetaModulo "vendor"

    if (-not (Test-Path $requirements)) {
        Write-Host "  [$nombre] no tiene requirements.txt, salteando." -ForegroundColor DarkGray
        continue
    }

    Write-Host ""
    Write-Host "--- $nombre (vendor) ---" -ForegroundColor Yellow
    & $pythonEmbedExe -m pip install --target=$vendor -r $requirements

    if ($nombre -eq "convertir") {
        Write-Host "  Descargando Chromium para Playwright (si ya esta descargado de antes, no vuelve a bajarlo)..."
        & $pythonEmbedExe -m playwright install chromium
    }

    Write-Host "  [$nombre] vendor listo." -ForegroundColor Green
}

# ============================================================
# PASO 3 (respaldo): venv por modulo con el Python que ya tenga la PC
# Si esta PC no tiene Python del todo, este paso simplemente falla y se
# saltea -- no rompe nada, porque resolverPython() ya prioriza el
# embebido+vendor del paso 2, que es el que de verdad es portable.
# ============================================================
$hayPythonDelSistema = $null -ne (Get-Command python -ErrorAction SilentlyContinue)

if ($hayPythonDelSistema) {
    Write-Host ""
    Write-Host "=== (Respaldo) armando venv por modulo con el Python de esta PC ===" -ForegroundColor Cyan

    foreach ($nombre in $modulos) {
        $carpetaModulo = Join-Path $raiz "modules\$nombre"
        $requirements = Join-Path $carpetaModulo "requirements.txt"
        if (-not (Test-Path $requirements)) { continue }

        $venv = Join-Path $carpetaModulo "venv"
        $pipExe = Join-Path $venv "Scripts\pip.exe"
        $pyExe = Join-Path $venv "Scripts\python.exe"

        if (-not (Test-Path $pyExe)) {
            python -m venv $venv
        }
        & $pipExe install -r $requirements --quiet

        if ($nombre -eq "escanear" -or $nombre -eq "imprimir") {
            $postinstall = Join-Path $venv "Scripts\pywin32_postinstall.py"
            if (Test-Path $postinstall) { & $pyExe $postinstall -install | Out-Null }
        }
    }

    Write-Host "Venvs de respaldo listos." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Esta PC no tiene Python instalado -- se saltea el venv de respaldo (no hace falta, ya queda andando con el embebido)." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Terminado ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "IMPORTANTE: el modulo 'ocr' usa Tesseract-OCR, que NO es un paquete" -ForegroundColor Yellow
Write-Host "de Python -- es un programa aparte que hay que instalar en esta PC:" -ForegroundColor Yellow
Write-Host "  https://github.com/UB-Mannheim/tesseract/wiki" -ForegroundColor Yellow
Write-Host ""
Write-Host "Reiniciá 'node index.js' para que los módulos usen esto." -ForegroundColor Cyan
