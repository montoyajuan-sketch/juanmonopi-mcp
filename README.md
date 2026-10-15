<div align="center">

# MCP Server: control remoto de PC

**Un servidor MCP para Windows con 47 herramientas propias, más 99 de Discord**

[![Plataforma](https://img.shields.io/badge/plataforma-Windows-0078D6)](#instalación)
[![Node](https://img.shields.io/badge/Node-24%20portable-339933)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)
[![OAuth](https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-blue)](https://oauth.net/2.1/)
[![Cloudflare](https://img.shields.io/badge/t%C3%BAnel-Cloudflare-F38020)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
[![Licencia](https://img.shields.io/badge/licencia-MIT-green)](LICENSE)

Conecta tu PC con **Claude**, **ChatGPT** o cualquier cliente MCP compatible.
Archivos, terminal, impresora, escáner, capturas de pantalla, mouse y teclado, conversión de formatos, OCR, notificaciones y más, todo con lenguaje natural.

</div>

---

## ¿Por qué este?

- **47 herramientas propias**: archivos, terminal, impresión, escaneo, capturas, control de mouse y teclado, OCR, conversión de formatos, notificaciones, portapapeles, procesos, red y volumen
- **99 herramientas de Discord** (módulo opcional): mensajes, canales, roles, moderación, foros, webhooks y más
- **Portable**: Node.js y Python vienen embebidos, no hace falta tener nada instalado de antemano
- **Sin abrir puertos**: usa un túnel de Cloudflare, sin IP fija ni configurar tu router
- **Autenticación real**: OAuth 2.1 + PKCE, con login de usuario y contraseña como respaldo
- **Modular**: cada herramienta es una carpeta independiente en `modules/`, fácil de agregar o quitar

---

## Inicio rápido

Necesitas **Windows**. Abre PowerShell y corre:

```powershell
git clone https://github.com/montoyajuan-sketch/juanmonopi-mcp.git
cd juanmonopi-mcp
.\instalar-todo.ps1
.\iniciar.bat
```

1. La primera vez te pide crear un **usuario y contraseña**: son los que usarás para autorizar el acceso desde Claude o ChatGPT.
2. El servidor imprime una URL pública del estilo `https://algo-random.trycloudflare.com`.
3. En tu cliente, agrega un **conector personalizado** con esa URL terminada en `/mcp`.

> Si tu PC tiene permisos limitados, ejecuta `instalar-todo.ps1` como administrador (Tesseract se instala en `Program Files`).

---

## Instalación

`instalar-todo.ps1` deja todo listo en un solo paso y se puede volver a correr sin problema: lo que ya está instalado se salta.

| Paso | Qué instala |
| ---- | ----------- |
| 1. Python | Python embebido y las dependencias de cada módulo Python, más el Chromium que usa `convertir` |
| 2. Discord | Dependencias de `modules/discord` (`npm install`) |
| 3. Tesseract | Tesseract-OCR (último instalador publicado en GitHub) y el idioma español |
| 4. Notificaciones | Electron para el overlay del módulo `notificacion` |

```powershell
.\instalar-todo.ps1                              # instala todo
.\instalar-todo.ps1 -SinTesseract                # omite Tesseract
.\instalar-todo.ps1 -SinDiscord                  # omite Discord
.\instalar-todo.ps1 -SinPython                   # omite la parte de Python
.\instalar-todo.ps1 -SinNotificacion             # omite Electron
.\instalar-todo.ps1 -CarpetaTesseract C:\ruta    # instala Tesseract en otra carpeta
```

Si solo necesitas la parte de Python: `.\instalar-dependencias-python.ps1`.

También puedes arrancar sin el `.bat`: `.\node-embed\node.exe index.js`.

### Tesseract-OCR (módulo `ocr`)

Tesseract **no es una librería de Python**, es un programa aparte, y no viene incluido en el repo. `instalar-todo.ps1` lo descarga e instala por ti.

Si prefieres hacerlo a mano, baja el instalador `tesseract-ocr-w64-setup-*.exe` desde las [releases de Tesseract](https://github.com/tesseract-ocr/tesseract/releases) y asegúrate de tener el idioma español (`spa`), que es el que usa el módulo por defecto.

---

## Conectar con tu cliente

<details>
<summary><strong>Claude</strong></summary>

Agrega un **conector personalizado** con la URL pública terminada en `/mcp`, por ejemplo `https://algo-random.trycloudflare.com/mcp`, y autoriza el acceso con el usuario y la contraseña que creaste.

</details>

<details>
<summary><strong>ChatGPT y otros clientes MCP</strong></summary>

Cualquier cliente que soporte servidores MCP remotos con OAuth 2.1 sirve: usa la misma URL terminada en `/mcp`.

</details>

### Sobre la URL pública

Por defecto se usa un **quick tunnel** de Cloudflare: es gratis y no requiere cuenta, pero la URL **cambia cada vez que reinicias el servidor**. Después de reiniciar tienes que volver a autorizar el conector con la URL nueva.

Para una URL fija necesitas un dominio delegado a una cuenta de Cloudflare y un túnel *nombrado* (`cloudflared tunnel create` + `cloudflared tunnel route dns`, y correrlo con `tunnel run <nombre>` en vez de `--url`). Eso queda fuera de este proyecto por defecto, pero `iniciarCloudflared()` en `index.js` es el lugar donde cambiarlo. Puedes conseguir un dominio gratis con [DigitalPlat FreeDomain](https://dash.domain.digitalplat.org).

---

## Panel de configuración

Al arrancar, el servidor abre en tu navegador una página de configuración con estilo Windows 11 (claro/oscuro automático). Desde ahí puedes:

- **Cuenta:** cambiar usuario y contraseña (opcionalmente desconecta los conectores ya autorizados).
- **Túnel:** elegir entre túnel *rápido* (gratis, URL aleatoria), *con nombre* (URL fija, necesita token de Cloudflare) o *sin túnel*; protocolo (HTTP/2, QUIC o automático) y si se actualiza `cloudflared` al iniciar. El botón "Guardar y aplicar" reinicia solo el túnel.
- **Servidor:** puertos, duración de sesiones y tokens.
- **Módulos:** activar o desactivar módulos (se aplica al reiniciar).
- **Seguridad:** cerrar todas las sesiones y ver la API key del REST.

Cómo funciona y qué tener en cuenta:

- Escucha **solo en `127.0.0.1`** (puerto 3100 por defecto), distinto al del servidor MCP, así que el túnel nunca la expone. El enlace lleva un token aleatorio que cambia en cada arranque; si cierras la pestaña, copia el enlace de la consola.
- Lo que guardas va a `config.json` (ignorado por git, puede contener el token del túnel). Las variables de entorno (`PORT`, `SESSION_MINUTOS`, `URL_PUBLICA_BASE`…) siguen teniendo prioridad sobre ese archivo.
- `CONFIG_ABRIR=0` evita que se abra la pestaña; `CONFIG_ABRIR=1` la fuerza.

## Herramientas disponibles (47 + 99 de Discord)

### Sesión (2 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `iniciar_sesion` | Inicia sesión en el servidor |
| `cerrar_sesion` | Cierra la sesión |

### Archivos y carpetas (13 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `listar_archivos` | Lista los archivos y carpetas de una ruta |
| `leer_archivo` | Lee el contenido de un archivo de texto |
| `crear_archivo` | Crea un archivo nuevo o sobrescribe uno existente |
| `editar_archivo` | Reemplaza una porción de texto dentro de un archivo |
| `eliminar_archivo` | Elimina un archivo |
| `eliminar_carpeta` | Elimina una carpeta |
| `crear_carpeta` | Crea una carpeta y las intermedias |
| `renombrar` | Renombra un archivo o carpeta |
| `info_archivo` | Devuelve tamaño, tipo y fechas |
| `descargar_archivo` | Descarga un archivo desde la PC |
| `descargar_carpeta` | Descarga una carpeta completa desde la PC |
| `subir_archivo` | Sube un archivo a la PC |
| `subir_carpeta` | Sube una carpeta a la PC |

### Terminal (6 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `iniciar_shell` | Abre una shell `cmd` o `powershell` |
| `listar_shells` | Muestra las shells abiertas |
| `enviar_comando` | Ejecuta un comando en una shell |
| `leer_salida_shell` | Lee la salida de una shell |
| `esperar_salida` | Espera salida nueva |
| `detener_shell` | Detiene una shell |

### Búsqueda y apertura (2 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `buscar_archivos` | Busca recursivamente por nombre, extensión o texto contenido |
| `abrir` | Abre un archivo con su aplicación predeterminada o lanza un programa |

### Pantalla, mouse y ventanas (5 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `capturar_pantalla` | Captura la pantalla completa o una región |
| `control_remoto` | Controla mouse, teclado y ventanas |
| `verificar_coordenada` | Devuelve un screenshot con una cruz marcando una coordenada |
| `listar_ventanas` | Lista las ventanas abiertas (PID, proceso, título) |
| `ventana_activa` | Devuelve el título de la ventana con el foco |

### Impresión y escaneo (4 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `impresoras` | Lista las impresoras disponibles |
| `imprimir_archivo` | Imprime PDFs e imágenes (color/BN, copias, dúplex, orientación) |
| `escaneres` | Lista los escáneres disponibles |
| `escanear_documento` | Escanea un documento vía WIA |

### Conversión y OCR (2 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `convertir_archivo` | Convierte entre cientos de formatos (documentos, imágenes, audio, video, datos) |
| `reconocer_texto_ocr` | Extrae texto de imágenes y PDFs escaneados con Tesseract |

### Notificaciones (4 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `notificar` | Muestra una notificación tipo toast con mensaje y botones |
| `notificar_progreso_crear` | Crea una notificación con barra de progreso |
| `notificar_progreso_actualizar` | Actualiza una barra de progreso en vivo |
| `notificar_finalizar` | Cierra una notificación |

### Sistema y red (9 herramientas)

| Herramienta | Descripción |
| ----------- | ----------- |
| `info_sistema` | CPU, RAM, espacio en disco, batería y tiempo encendido |
| `listar_procesos` | Procesos en ejecución (top 60 por CPU) |
| `matar_proceso` | Cierra un proceso por nombre o PID |
| `leer_portapapeles` | Lee el portapapeles de Windows |
| `escribir_portapapeles` | Copia texto al portapapeles |
| `volumen` | Sube, baja o silencia el volumen |
| `red_info` | IPs locales de la PC |
| `red_ping` | Hace ping a un host |
| `red_puerto` | Comprueba si un puerto está abierto |

### Discord (99 herramientas, opcional)

Mensajes, canales, permisos, miembros, roles, foros, webhooks, eventos programados, mensajes directos, invitaciones, moderación y estadísticas. La lista completa está en [`modules/discord/README.md`](modules/discord/README.md).

---

## Configuración del módulo Discord

1. Crea un bot en el [Portal de Desarrolladores de Discord](https://discord.com/developers/applications) y copia su token.
2. `instalar-todo.ps1` crea `modules/discord/.env` a partir de `.env.example`. Complétalo:

| Variable | Obligatoria | Descripción |
| -------- | ----------- | ----------- |
| `DISCORD_TOKEN` | Sí | Token de tu bot |
| `DISCORD_ALLOWED_GUILDS` | No | Limita el bot a ciertos servidores (IDs separados por coma) |
| `DISCORD_LOG_CHANNEL_ID` | No | Canal donde se registra cada herramienta ejecutada |

Si falta el token o las dependencias, el módulo se desactiva solo y el resto del servidor arranca igual. Estas herramientas tienen permisos altos (banear, borrar canales, etc.): usa un bot con los permisos mínimos que necesites.

---

## Estructura del proyecto

```
├── index.js                          # Servidor MCP, OAuth 2.1 + PKCE, túnel, carga de módulos
├── iniciar.bat                       # Arranca el servidor con el Node portable
├── instalar-todo.ps1                 # Instala todas las dependencias
├── instalar-dependencias-python.ps1  # Solo la parte de Python
├── node-embed/                       # Node.js portable
├── python-embed/                     # Python portable (se genera al instalar)
└── modules/
    ├── abrir/  buscar_archivos/  captura_pantalla/  control_remoto/
    ├── convertir/  escanear/  imprimir/  info_sistema/  listar_ventanas/
    ├── notificacion/  ocr/  portapapeles/  procesos/  red/  volumen/
    ├── discord/                      # Opcional
    └── _shared/
```

Cada módulo es una carpeta con su propio `module.js` (registra las herramientas MCP y, opcionalmente, rutas REST) y, si necesita Python, su `main.py` y `requirements.txt`.

### Agregar un módulo nuevo

Crea `modules/<nombre>/module.js` con una exportación por defecto. El servidor carga solo todas las carpetas de `modules/` que tengan ese archivo:

```js
import { z } from "zod";

export default {
  nombre: "hola",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "hola_mundo",
      {
        title: "Hola mundo",
        description: "Devuelve un saludo.",
        inputSchema: { nombre: z.string(), clave: z.string().optional() },
      },
      async ({ nombre, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        return { content: [{ type: "text", text: `Hola, ${nombre}` }] };
      },
    );
  },
};
```

Además de `registrarMcp`, un módulo puede definir `registrarRest(router, { verificarApiKey })` para exponer rutas REST e `iniciar(puerto)` si necesita levantar su propio servicio (el puerto libre se lo asigna el servidor).

---

## Seguridad

- Autenticación por **OAuth 2.1 + PKCE** (para Claude y ChatGPT) y login tradicional de usuario y contraseña como respaldo; la contraseña se guarda con scrypt, nunca en texto plano.
- **Este servidor da control amplio de tu PC**: archivos, terminal, mouse y teclado, y borrado de archivos. No filtra ni aísla los comandos. Úsalo bajo tu propio criterio y no compartas tu URL pública ni tus credenciales.
- Tokens, sesiones y archivos de estado (`usuarios.json`, `apikey.json`, `oauth-clients.json`, `modules/discord/.env`, etc.) están en `.gitignore`: no los subas al repo.

---

## Licencia

Este proyecto se distribuye bajo la licencia [MIT](LICENSE). El módulo `modules/discord/` conserva su propia licencia MIT (ver `modules/discord/LICENSE`), y los programas de terceros incluidos, como SumatraPDF, mantienen la suya.

---

## Créditos

- **Discord**: las herramientas vienen de [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp) (licencia MIT), incluido en `modules/discord/` junto con su `LICENSE`. `modules/discord/module.js` es el adaptador que lo conecta a este servidor.
- **Conversión de formatos**: el módulo `convertir` automatiza [p2r3/convert](https://github.com/p2r3/convert) con Playwright.
- **OCR**: [Tesseract](https://github.com/tesseract-ocr/tesseract).
- **Impresión de PDF**: [SumatraPDF](https://www.sumatrapdfreader.org).
- **Túnel**: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`).
