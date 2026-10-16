# instalar-todo.ps1
#
# Instala TODAS las dependencias del servidor en un solo paso:
#
#   1) Python embebido + dependencias de cada modulo Python
#      (llama a instalar-dependencias-python.ps1).
#   2) Dependencias del modulo "discord" (npm install --omit=dev).
#      Usa el npm de node-embed si existe, luego el npm del sistema y, si no
#      hay ninguno, baja un Node oficial temporal solo para instalar.
#   3) Tesseract-OCR (para el modulo "ocr") y el idioma espanol.
#      Descarga el instalador mas reciente publicado en GitHub.
#   4) Overlay de notificaciones (modulo "notificacion"): npm install de
#      Electron, que descarga su propio ejecutable (pesa varios cientos de MB).
#
# Se puede correr de nuevo cuando quieras: lo que ya esta instalado se salta.
#
# Uso:
#   .\instalar-todo.ps1
#   .\instalar-todo.ps1 -SinTesseract     (no toca Tesseract)
#   .\instalar-todo.ps1 -SinDiscord       (no instala lo de discord)
#   .\instalar-todo.ps1 -SinPython        (no instala lo de Python)
#   .\instalar-todo.ps1 -SinNotificacion  (no instala Electron)
#   .\instalar-todo.ps1 -CarpetaTesseract C:\ruta\tesseract
#                                         (instala Tesseract en esa carpeta en
#                                          vez de Program Files)

param(
    [switch]$SinTesseract,
    [switch]$SinDiscord,
    [switch]$SinPython,
    [switch]$SinNotificacion,
    [string]$CarpetaTesseract = ""
)

$ErrorActionPreference = "Stop"
# PowerShell 5.1 usa TLS viejo por defecto y GitHub lo rechaza.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$raiz = $PSScriptRoot
$resumen = [ordered]@{}

function Titulo($texto) {
    Write-Host ""
    Write-Host "=== $texto ===" -ForegroundColor Cyan
}

# ============================================================
# PASO 1: Python embebido + modulos Python
# ============================================================
if ($SinPython) {
    $resumen["Python"] = "omitido (-SinPython)"
} else {
    Titulo "1/4 Python y modulos Python"
    $scriptPython = Join-Path $raiz "instalar-dependencias-python.ps1"
    try {
        & $scriptPython
        $resumen["Python"] = "OK"
    } catch {
        Write-Warning "Fallo instalar-dependencias-python.ps1: $($_.Exception.Message)"
        $resumen["Python"] = "FALLO (ver mensaje arriba)"
    }
}

# ============================================================
# PASO 2: dependencias de npm del modulo discord
# ============================================================
function Obtener-Npm {
    # Devuelve @{ Node = <exe>; Cli = <npm-cli.js>; Temporal = <carpeta o $null> }
    # Si Node es $null, hay que usar el "npm" del PATH.
    $nodeEmbed = Join-Path $raiz "node-embed\node.exe"
    $cliEmbed = Join-Path $raiz "node-embed\node_modules\npm\bin\npm-cli.js"

    if ((Test-Path $nodeEmbed) -and (Test-Path $cliEmbed)) {
        return @{ Node = $nodeEmbed; Cli = $cliEmbed; Temporal = $null }
    }

    $npmSistema = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmSistema) {
        return @{ Node = $null; Cli = $null; Temporal = $null }
    }

    # No hay npm: bajamos el mismo Node que usa node-embed, solo para instalar.
    if (-not (Test-Path $nodeEmbed)) {
        throw "No hay npm ni node-embed\node.exe. Instala Node.js desde https://nodejs.org y vuelve a correr este script."
    }
    $version = (& $nodeEmbed --version).Trim()
    Write-Host "  Descargando Node $version temporal (solo para instalar, se borra al terminar)..."
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("node-tmp-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $zip = Join-Path $temp "node.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/node-$version-win-x64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $temp -Force
    $carpetaNode = Get-ChildItem $temp -Directory | Where-Object { $_.Name -like "node-v*" } | Select-Object -First 1
    return @{
        Node = Join-Path $carpetaNode.FullName "node.exe"
        Cli = Join-Path $carpetaNode.FullName "node_modules\npm\bin\npm-cli.js"
        Temporal = $temp
    }
}

if ($SinDiscord) {
    $resumen["Discord"] = "omitido (-SinDiscord)"
} else {
    Titulo "2/4 Modulo discord (npm)"
    $carpetaDiscord = Join-Path $raiz "modules\discord"

    if (-not (Test-Path (Join-Path $carpetaDiscord "package.json"))) {
        Write-Host "  No existe modules\discord, se salta." -ForegroundColor DarkGray
        $resumen["Discord"] = "no existe el modulo"
    } else {
        $npm = $null
        try {
            $npm = Obtener-Npm
            Push-Location $carpetaDiscord
            # --ignore-scripts: no ejecutar scripts de build, el modulo corre sus .ts directo.
            if ($npm.Node) {
                & $npm.Node $npm.Cli install --omit=dev --ignore-scripts --no-audit --no-fund
            } else {
                & npm install --omit=dev --ignore-scripts --no-audit --no-fund
            }
            if ($LASTEXITCODE -ne 0) { throw "npm install termino con codigo $LASTEXITCODE" }

            $archivoEnv = Join-Path $carpetaDiscord ".env"
            $ejemplo = Join-Path $carpetaDiscord ".env.example"
            if (-not (Test-Path $archivoEnv) -and (Test-Path $ejemplo)) {
                Copy-Item $ejemplo $archivoEnv
                Write-Host "  Cree modules\discord\.env vacio: pon tu DISCORD_TOKEN en el asistente de la primera vez (o en Configuracion > Modulos)." -ForegroundColor Yellow
                $resumen["Discord"] = "OK - falta el token (se pone en el asistente de configuracion)"
            } else {
                $resumen["Discord"] = "OK"
            }
        } catch {
            Write-Warning "Fallo la instalacion de discord: $($_.Exception.Message)"
            $resumen["Discord"] = "FALLO (ver mensaje arriba)"
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
            if ($npm -and $npm.Temporal -and (Test-Path $npm.Temporal)) {
                Remove-Item $npm.Temporal -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# ============================================================
# PASO 3: Tesseract-OCR + idioma espanol
# ------------------------------------------------------------
# El instalador se baja de GitHub. Se revisan dos repos y se elige el mas
# nuevo: tesseract-ocr/tesseract (oficial, el que hoy publica los instaladores
# de Windows nuevos) y UB-Mannheim/tesseract (quien los armaba antes; sus
# releases estan desactualizados, queda como respaldo).
#
# TODO: si se consigue una version portable de Tesseract, reemplazar
# Instalar-Tesseract / Buscar-Tesseract por eso y ajustar la ruta fija en
# modules\ocr\main.py.
# ============================================================
function Obtener-InstaladorTesseract {
    $repos = @("tesseract-ocr/tesseract", "UB-Mannheim/tesseract")
    $mejor = $null

    foreach ($repo in $repos) {
        try {
            $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=15" `
                -Headers @{ "User-Agent" = "instalar-todo" }
        } catch {
            Write-Warning "No pude consultar los releases de $repo : $($_.Exception.Message)"
            continue
        }

        foreach ($rel in $releases) {
            if ($rel.prerelease) { continue }
            $asset = $rel.assets | Where-Object { $_.name -match '^tesseract-ocr-w64-setup-.*\.exe$' } | Select-Object -First 1
            if ($asset) {
                $fecha = [datetime]$rel.published_at
                if ((-not $mejor) -or ($fecha -gt $mejor.Fecha)) {
                    $mejor = @{ Nombre = $asset.name; Url = $asset.browser_download_url; Fecha = $fecha; Repo = $repo }
                }
                break   # el primero con instalador es el mas nuevo de ese repo
            }
        }
    }
    return $mejor
}

function Buscar-Tesseract {
    if ($CarpetaTesseract) {
        $propio = Join-Path $CarpetaTesseract "tesseract.exe"
        if (Test-Path $propio) { return $propio }
    }
    $enPath = Get-Command tesseract -ErrorAction SilentlyContinue
    if ($enPath) { return $enPath.Source }
    $candidatos = @(
        "C:\Program Files\Tesseract-OCR\tesseract.exe",
        "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Tesseract-OCR\tesseract.exe")
    )
    foreach ($c in $candidatos) { if (Test-Path $c) { return $c } }
    return $null
}

function Instalar-Tesseract {
    $inst = Obtener-InstaladorTesseract
    if ($inst) {
        $descarga = Join-Path ([IO.Path]::GetTempPath()) $inst.Nombre
        Write-Host "  Descargando $($inst.Nombre) (de $($inst.Repo))..."
        Invoke-WebRequest -Uri $inst.Url -OutFile $descarga

        $argumentos = @("/S")
        # /D debe ir al final y sin comillas (regla de los instaladores NSIS).
        if ($CarpetaTesseract) { $argumentos += "/D=$CarpetaTesseract" }

        Write-Host "  Instalando en silencio (puede pedir permisos de administrador)..."
        $proceso = Start-Process -FilePath $descarga -ArgumentList $argumentos -Wait -PassThru -Verb RunAs
        Remove-Item $descarga -Force -ErrorAction SilentlyContinue
        return ($proceso.ExitCode -eq 0)
    }

    # Respaldo: winget, si GitHub no respondio.
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  No pude obtener el instalador de GitHub, probando con winget..."
        & winget install --id UB-Mannheim.TesseractOCR -e --silent --accept-package-agreements --accept-source-agreements
        return ($LASTEXITCODE -eq 0)
    }
    return $false
}

if ($SinTesseract) {
    $resumen["Tesseract"] = "omitido (-SinTesseract)"
} else {
    Titulo "3/4 Tesseract-OCR"
    $tess = Buscar-Tesseract

    if (-not $tess) {
        try { [void](Instalar-Tesseract) } catch { Write-Warning $_.Exception.Message }
        $tess = Buscar-Tesseract
        if (-not $tess) {
            Write-Warning "No se pudo instalar Tesseract automaticamente."
            Write-Host "  Descargalo a mano desde https://github.com/tesseract-ocr/tesseract/releases" -ForegroundColor Yellow
            Write-Host "  (archivo tesseract-ocr-w64-setup-*.exe) y vuelve a correr este script." -ForegroundColor Yellow
            $resumen["Tesseract"] = "FALTA - instalar a mano"
        }
    } else {
        Write-Host "  Tesseract ya esta instalado: $tess" -ForegroundColor DarkGray
    }

    if ($tess) {
        $idiomas = & $tess --list-langs 2>&1
        if ($idiomas -contains "spa") {
            $resumen["Tesseract"] = "OK (con espanol)"
        } else {
            Write-Host "  Falta el idioma espanol (spa). Descargandolo..."
            $tessdata = Join-Path (Split-Path $tess -Parent) "tessdata"
            try {
                Invoke-WebRequest -Uri "https://github.com/tesseract-ocr/tessdata_fast/raw/main/spa.traineddata" `
                    -OutFile (Join-Path $tessdata "spa.traineddata")
                $resumen["Tesseract"] = "OK (espanol agregado)"
            } catch {
                Write-Warning "No pude escribir en $tessdata (probablemente falta ejecutar como administrador)."
                Write-Host "  Vuelve a correr este script como administrador, o copia spa.traineddata ahi a mano." -ForegroundColor Yellow
                $resumen["Tesseract"] = "instalado, falta el idioma espanol"
            }
        }
    }
}

# ============================================================
# PASO 4: Electron del modulo notificacion
# ============================================================
if ($SinNotificacion) {
    $resumen["Notificacion"] = "omitido (-SinNotificacion)"
} else {
    Titulo "4/4 Modulo notificacion (Electron)"
    $carpetaElectron = Join-Path $raiz "modules\notificacion\electron-overlay"

    if (-not (Test-Path (Join-Path $carpetaElectron "package.json"))) {
        Write-Host "  No existe modules\notificacion\electron-overlay, se salta." -ForegroundColor DarkGray
        $resumen["Notificacion"] = "no existe el modulo"
    } else {
        $npm = $null
        try {
            $npm = Obtener-Npm
            Push-Location $carpetaElectron
            # Sin --ignore-scripts: el postinstall de Electron es el que baja su ejecutable.
            if ($npm.Node) {
                & $npm.Node $npm.Cli install --no-audit --no-fund
            } else {
                & npm install --no-audit --no-fund
            }
            if ($LASTEXITCODE -ne 0) { throw "npm install termino con codigo $LASTEXITCODE" }
            $resumen["Notificacion"] = "OK"
        } catch {
            Write-Warning "Fallo la instalacion de Electron: $($_.Exception.Message)"
            $resumen["Notificacion"] = "FALLO (ver mensaje arriba)"
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
            if ($npm -and $npm.Temporal -and (Test-Path $npm.Temporal)) {
                Remove-Item $npm.Temporal -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# ============================================================
# Resumen
# ============================================================
Titulo "Resumen"
foreach ($k in $resumen.Keys) {
    $color = "Green"
    if ($resumen[$k] -match "FALL|FALTA|falta|omitido|no existe") { $color = "Yellow" }
    Write-Host ("  {0,-10} {1}" -f $k, $resumen[$k]) -ForegroundColor $color
}
Write-Host ""
Write-Host "Listo. Arranca el servidor con iniciar.bat." -ForegroundColor Cyan
