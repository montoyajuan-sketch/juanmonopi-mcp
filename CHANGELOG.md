# Changelog

Todos los cambios del proyecto, de la versión más nueva a la más vieja.

## v1.0.0 (2026-10-16)

Primera versión publicada. Reúne todo lo hecho desde la primera versión portable (septiembre de 2026) hasta hoy.

### Lo nuevo de esta versión

**Panel de configuración** (`http://localhost:3100`)
- Página de configuración con estilo Windows 11, con modo claro y oscuro automático. Solo se puede abrir desde la propia PC (`127.0.0.1`), con un enlace con token distinto en cada arranque, cookie de sesión y protección contra CSRF y DNS rebinding.
- Cuenta: cambiar usuario y contraseña, con la opción de cerrar los conectores ya autorizados.
- Túnel: túnel rápido (URL aleatoria), túnel con nombre (URL fija, con token de Cloudflare) o sin túnel. Protocolo HTTP/2, QUIC o automático. "Guardar y aplicar" reinicia solo el túnel.
- Servidor: puertos, duración de la sesión y de los tokens de acceso y de refresco.
- Módulos: activar o desactivar cada módulo.
- Seguridad: cerrar todas las sesiones y ver la API key del REST.
- Botón para reiniciar el servidor desde el panel.
- `config.json` guarda los valores y las variables de entorno siguen teniendo prioridad.

**Asistente de primera vez**
- Si todavía no hay usuario, el panel se abre con un asistente de tres pasos: cuenta, túnel y Discord. Reemplaza las preguntas por consola, que quedan como respaldo si el panel no arranca.

**Ajustes por módulo**
- Cualquier módulo puede declarar sus ajustes en `modules/<nombre>/configuracion.json` y el panel dibuja el formulario solo, debajo de la lista de módulos, con un único botón "Guardar todo".
- Tipos de campo: texto, secreto, número, booleano y opción, con validación (obligatorio, patrón, mínimo y máximo, longitud).
- Los valores se guardan en `modules/<nombre>/.env`. Los secretos nunca se devuelven al navegador.
- El módulo de Discord usa este sistema para su token, sus servidores permitidos y su canal de logs.

**Temas**
- Nueva pestaña para cambiar el color de acento: diez colores predefinidos o cualquier color propio.
- Vista previa al instante y guardado en `config.json` (`tema.acento`). Se ajusta el brillo en modo claro y oscuro para que el texto se lea.
- El mismo color se usa en la página de autorización de los conectores.

**Página de autorización OAuth**
- Rediseñada con el mismo estilo que el panel, en modo claro y oscuro y adaptada al celular.
- Muestra si el dominio de destino es conocido. La lista conocida ahora es `chatgpt.com` y `claude.ai` (se quitó `chat.openai.com`).

**Túnel**
- `cloudflared` se comprueba y se actualiza al iniciar. Solo descarga cuando hay una versión nueva, y se puede desactivar desde el panel.

**Documentación**
- `README.md` reescrito: inicio rápido, tablas de herramientas, configuración, estructura del proyecto y cómo agregar un módulo.
- `MODULE_API.md`: guía completa para crear conectores (módulos), con el API de `configuracion.json`, el API del panel y el API de `configuracion.js`.
- `MODULE_API_DETAILED.md`: referencia exacta verificada contra el código, con plantillas, límites y puntos delicados.
- `LICENSE` (MIT).

**Instalación**
- `instalar-todo.ps1`: instala de una vez Python embebido, las dependencias de Discord, Tesseract-OCR y Electron para las notificaciones.

### Cambios que conviene saber al actualizar
- `config.json` y `modules/*/.env` se ignoran en git, porque pueden tener secretos.
- `index.js` se guardó antes en UTF-16 y con los acentos dañados. Ahora está en UTF-8.
- Se eliminó el módulo `idukay_integration` de la versión pública.
- El token de Discord ya no se pide por consola ni se edita a mano: se pone en el asistente o en Configuración → Módulos. Editar `modules/discord/.env` sigue funcionando.

### Límites conocidos
Estas partes no se probaron de punta a punta:
- Conexión con un token real de Discord.
- Túnel con nombre (necesita un token de Cloudflare).
- Botón de reinicio del servidor y apertura automática del navegador.
- La página de autorización con un flujo OAuth real tras el rediseño y los temas.

## 2026-10-14

- Panel de configuración local (`configuracion.js` y `configuracion-ui/`) y lectura de `config.json` en `index.js`.
- Reinicio del túnel sin reiniciar el servidor.
- Auto-actualización de `cloudflared`.
- `index.js` pasa de UTF-16 a UTF-8.
- `.gitignore` ignora `config.json`. El README gana la sección "Panel de configuración".

## 2026-10-13

- README reescrito, licencia MIT e instalador único `instalar-todo.ps1`.
- Se elimina `idukay_integration` de la versión pública.
- `.gitignore` ignora los `node_modules` de `electron-overlay`.

## 2026-10-12

- Nuevo módulo opcional `discord` (discord.js): token y canal de logs por `.env`, control de acceso en cada herramienta y desactivación automática si faltan dependencias.
- Nuevo módulo opcional `idukay_integration`: notificaciones y adjuntos con sesión propia (`sesion.json` ignorada por git, con `sesion.example.json`). Se quitó el 13 de octubre.
- `.gitignore` ignora secretos y sesiones. El README documenta la configuración.
- Créditos a PaSympa/discord-mcp en el README.

## 2026-09-19

- `node-embed` y `node_modules` salen del repositorio: en ejecución solo hace falta `node.exe`.

## 2026-09-18

- Primera versión pública y portable: servidor MCP con OAuth 2.1 y PKCE, túnel aleatorio de Cloudflare, y Node y Python portables por módulo.
