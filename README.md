# MCP Server — control remoto de PC (Windows)

Servidor MCP para Windows que expone tu PC (archivos, shell, impresora,
escáner, captura de pantalla, control de mouse/teclado, conversión de
formatos, OCR y más) para que Claude, ChatGPT o cualquier cliente MCP
compatible puedan usarlo, vía OAuth 2.1 + PKCE y un túnel público de
Cloudflare — sin necesitar IP fija ni abrir puertos en tu router.

## Instalación

Requisitos: **Windows**. No hace falta tener Node.js ni Python instalados
de antemano — vienen empaquetados / se descargan solos.

1. Cloná o descargá este repo.
2. (Solo si vas a usar módulos que necesitan Python — `imprimir`,
   `escanear`, `captura_pantalla`, `control_remoto`, `convertir`, `ocr`)
   corré una vez:
   ```powershell
   .\instalar-dependencias-python.ps1
   ```
   Esto descarga un Python portable (`python-embed/`) y las dependencias
   de cada módulo en su propia carpeta `vendor/`, sin tocar nada global
   de tu sistema.
3. Doble click en **`iniciar.bat`** (o `.\node-embed\node.exe index.js`
   desde una terminal).
4. La primera vez te va a pedir crear un usuario y contraseña — son los
   que vas a usar para autorizar el acceso desde Claude/ChatGPT.
5. Va a imprimir una URL pública (`https://algo-random.trycloudflare.com`).
   Esa es la que usás para conectar el conector MCP en Claude/ChatGPT.

## Sobre la URL pública

Por default usa un **quick tunnel** de Cloudflare: gratis, no requiere
cuenta, pero la URL **cambia cada vez que reiniciás el servidor**. Eso
significa que después de reiniciar vas a tener que volver a autorizar el
conector en Claude/ChatGPT (la URL vieja deja de existir).

Si querés una URL fija para siempre, necesitás:
- Un dominio (podés conseguir uno gratis vía
  [DigitalPlat FreeDomain](https://dash.domain.digitalplat.org)),
- delegado a una cuenta de Cloudflare,
- y un túnel *nombrado* en vez del quick tunnel (`cloudflared tunnel
  create` + `cloudflared tunnel route dns` + correr con `tunnel run
  <nombre>` en vez de `--url`).

Eso queda fuera de este script por default porque depende de tu propio
dominio/cuenta — pero el código de `iniciarCloudflared()` en `index.js`
es el lugar donde cambiarlo si querés armarlo así.

## Tesseract-OCR (módulo `ocr`)

El módulo de OCR usa el programa **Tesseract-OCR**, que no es una
librería de Python — hay que instalarlo aparte:
https://github.com/UB-Mannheim/tesseract/wiki

## Estructura

- `index.js` — servidor MCP, OAuth 2.1+PKCE, login tradicional de respaldo,
  túnel de Cloudflare, carga de módulos.
- `modules/<nombre>/` — cada herramienta es un módulo independiente con su
  propio `module.js` (registra las tools MCP + rutas REST) y, si necesita
  Python, su propio `main.py` + `requirements.txt`.
- `node-embed/` — Node.js portable (no lo borres si no tenés Node instalado
  en el sistema).
- `python-embed/` — Python portable, se genera con el instalador (no viene
  en el repo).

## Seguridad

- Autenticación por **OAuth 2.1 + PKCE** (para Claude/ChatGPT) y login
  tradicional usuario/contraseña (contraseña con scrypt, nunca en texto
  plano) como respaldo.
- El acceso te da control bastante amplio de la PC (archivos, shell,
  mouse/teclado). Usalo bajo tu propio criterio — este proyecto no filtra
  ni sandboxea comandos.
