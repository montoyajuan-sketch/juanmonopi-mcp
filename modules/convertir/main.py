# modules/convertir/main.py
# Worker de conversion de archivos. Puerto 9005.
# Usa https://convert.to.it/ (proyecto p2r3/convert) via automatizacion con
# Playwright, ya que es una herramienta 100% client-side (WASM en el navegador,
# sin API de servidor propia). Mantenemos un Chromium headless persistente
# para no pagar el costo de arranque (~10s) en cada conversion.
#
# Flujo verificado manualmente:
#   1. Subir archivo -> input#uploadFile
#   2. Click en el pill "N output formats" para abrir el buscador de formatos
#   3. Escribir la extension deseada en el buscador
#   4. Click en el boton de formato que matchea ".EXT" al inicio del texto
#   5. Click en "Convert" y esperar el evento de descarga

import os as _os
import site as _site
_VENDOR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "vendor")
if _os.path.isdir(_VENDOR):
    _site.addsitedir(_VENDOR)
    _pywin32_dlls = _os.path.join(_VENDOR, "pywin32_system32")
    if _os.path.isdir(_pywin32_dlls):
        _os.add_dll_directory(_pywin32_dlls)

import http.server
import socketserver
import json
import os
import tempfile
import uuid

from playwright.sync_api import sync_playwright
import argparse

_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9005)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto

CARPETA_MODULO = os.path.dirname(os.path.abspath(__file__))
TMP_DIR = os.path.join(CARPETA_MODULO, "tmp")
os.makedirs(TMP_DIR, exist_ok=True)

_pw = None
_browser = None


def obtener_browser():
    global _pw, _browser
    if _browser is None or not _browser.is_connected():
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch(headless=True)
    return _browser


def convertir_archivo(nombre, contenido, formato_salida):
    ext_entrada = os.path.splitext(nombre)[1] or ".bin"
    ruta_entrada = os.path.join(TMP_DIR, f"{uuid.uuid4().hex}{ext_entrada}")
    with open(ruta_entrada, "wb") as f:
        f.write(contenido)

    browser = obtener_browser()
    page = browser.new_page(accept_downloads=True)
    try:
        page.goto("https://convert.to.it/", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1000)

        page.set_input_files("#uploadFile", os.path.abspath(ruta_entrada))
        page.wait_for_timeout(2500)

        # a veces aparece un aviso (ej. archivo grande); si aparece "Ignore", lo despachamos
        try:
            boton_ignore = page.get_by_role("button", name="Ignore", exact=True)
            if boton_ignore.is_visible(timeout=1500):
                boton_ignore.click()
                page.wait_for_timeout(500)
        except Exception:
            pass

        # abrir el selector de formato de salida
        try:
            page.get_by_role("button", name="output formats", exact=False).click(timeout=4000)
        except Exception:
            pass  # puede que ya este abierto por defecto

        page.wait_for_timeout(400)
        page.fill('input[placeholder="Search formats..."]', formato_salida.lstrip("."))
        page.wait_for_timeout(1000)

        objetivo = f".{formato_salida.lstrip('.').upper()}"
        candidatos = page.locator("button", has_text=objetivo).all()
        elegido = None
        for c in candidatos:
            txt = c.inner_text().strip()
            if txt.startswith(objetivo + "\n") or txt == objetivo:
                elegido = c
                break
        if not elegido and candidatos:
            elegido = candidatos[0]
        if not elegido:
            return {"ok": False, "error": f"no se encontro el formato de salida '{formato_salida}'"}

        elegido.click()
        page.wait_for_timeout(400)

        with page.expect_download(timeout=30000) as download_info:
            page.get_by_role("button", name="Convert", exact=True).click()
        download = download_info.value

        nombre_salida = download.suggested_filename or f"convertido.{formato_salida.lstrip('.')}"
        ruta_salida = os.path.join(TMP_DIR, f"{uuid.uuid4().hex}_{nombre_salida}")
        download.save_as(ruta_salida)

        with open(ruta_salida, "rb") as f:
            resultado_bytes = f.read()

        return {"ok": True, "nombre": nombre_salida, "bytes": resultado_bytes}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        page.close()
        try:
            os.remove(ruta_entrada)
        except OSError:
            pass


def parse_multipart(body, boundary):
    campos = {}
    parts = body.split(b"--" + boundary)
    for part in parts:
        if b"Content-Disposition" not in part:
            continue
        header, _, content = part.partition(b"\r\n\r\n")
        content = content.rstrip(b"\r\n--")
        header_str = header.decode(errors="ignore")
        if 'filename="' in header_str:
            filename = header_str.split('filename="')[1].split('"')[0]
            campos["file"] = (filename, content)
        else:
            name = header_str.split('name="')[1].split('"')[0]
            campos[name] = content.decode(errors="ignore").strip()
    return campos


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/salud":
            self._json(200, {"modulo": "convertir", "estado": "activo", "puerto": PORT})
        else:
            self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/convertir":
            self._json(404, {"error": "ruta no encontrada"})
            return
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._json(400, {"error": "se espera multipart/form-data"})
                return
            boundary = content_type.split("boundary=")[1].encode()
            length = int(self.headers["Content-Length"])
            body = self.rfile.read(length)
            campos = parse_multipart(body, boundary)

            filename, file_content = campos.get("file", (None, None))
            formato_salida = campos.get("formatoSalida")
            if not filename or not formato_salida:
                self._json(400, {"error": "se requiere 'file' y 'formatoSalida'"})
                return

            resultado = convertir_archivo(filename, file_content, formato_salida)
            if not resultado["ok"]:
                self._json(500, resultado)
                return

            # devolvemos el archivo convertido directamente como binario,
            # con el nombre en un header para que Node lo pueda leer
            data = resultado["bytes"]
            self.send_response(200)
            self.send_header("Content-type", "application/octet-stream")
            self.send_header("X-Nombre-Archivo", resultado["nombre"])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"[convertir] worker escuchando en http://localhost:{PORT}")
    obtener_browser()  # precalentamos el navegador al arrancar
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
