# modules/imprimir/main.py
# Worker de impresion del modulo "imprimir". Puerto 9001.
# No expone GUI ni maneja tunel: eso lo hace Node (index.js del server MCP).
# Solo recibe POST /imprimir con multipart/form-data y manda a imprimir.

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
import os
import subprocess
import win32print
import win32api

try:
    from PIL import Image
    from io import BytesIO
    PIL_DISPONIBLE = True
except ImportError:
    PIL_DISPONIBLE = False

import argparse
_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9001)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto

CARPETA_MODULO = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(CARPETA_MODULO, "archivos_recibidos")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# SumatraPDF vive dentro del propio modulo -- autocontenido, no depende
# de ninguna carpeta externa.
SUMATRA = os.path.join(CARPETA_MODULO, "SumatraPDF", "SumatraPDF-3.5.2-64.exe")

EXT_IMAGENES = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tiff")
PAPER_SIZES_IN = {
    "letter": (8.5, 11),
    "legal": (8.5, 14),
    "a4": (8.27, 11.69),
    "a3": (11.69, 16.54),
}
DPI_IMPRESION = 150


def componer_imagen_en_hoja(imagen_bytes, papel, orientacion, fx, fy, fw, fh):
    ancho_in, alto_in = PAPER_SIZES_IN.get(papel, PAPER_SIZES_IN["letter"])
    if orientacion == "landscape":
        ancho_in, alto_in = alto_in, ancho_in
    page_w = max(1, int(ancho_in * DPI_IMPRESION))
    page_h = max(1, int(alto_in * DPI_IMPRESION))
    hoja = Image.new("RGB", (page_w, page_h), "white")
    img = Image.open(BytesIO(imagen_bytes))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.mode else "RGB")
    box_x, box_y = int(fx * page_w), int(fy * page_h)
    box_w, box_h = max(1, int(fw * page_w)), max(1, int(fh * page_h))
    img_resized = img.resize((box_w, box_h), Image.LANCZOS)
    if img_resized.mode == "RGBA":
        hoja.paste(img_resized, (box_x, box_y), img_resized)
    else:
        hoja.paste(img_resized, (box_x, box_y))
    salida = BytesIO()
    hoja.save(salida, format="PNG")
    return salida.getvalue()


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


def listar_impresoras():
    # El indice 2 de cada tupla que devuelve EnumPrinters es el nombre (pName).
    impresoras = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
    nombres = [p[2] for p in impresoras]
    predeterminada = win32print.GetDefaultPrinter()
    return nombres, predeterminada


def imprimir_pdf_o_imagen(filename, file_content, impresora, copias, orientacion, papel, color, duplex):
    es_imagen = filename.lower().endswith(EXT_IMAGENES)

    if es_imagen and PIL_DISPONIBLE:
        try:
            file_content = componer_imagen_en_hoja(file_content, papel, orientacion, 0.1, 0.1, 0.8, 0.8)
            filename = os.path.splitext(filename)[0] + "_hoja.png"
        except Exception as e:
            print(f"No se pudo componer imagen, se imprime original: {e}")

    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(file_content)

    win32print.SetDefaultPrinter(impresora)

    if os.path.exists(SUMATRA) and filename.lower().endswith(".pdf"):
        # IMPORTANTE: la orientacion va DENTRO de -print-settings (portrait/landscape),
        # NO como flag "-portrait" separado -- eso fue el bug que encontramos antes
        # (Sumatra lo interpretaba como nombre de archivo y tiraba error).
        settings = (
            f'{"color" if color == "color" else "monochrome"},'
            f'{copias}x,'
            f'{"duplex" if duplex != "no" else "noDuplex"},'
            f'{"landscape" if orientacion == "landscape" else "portrait"},'
            f'noscale'
        )
        cmd = [SUMATRA, "-print-to", impresora, "-print-settings", settings,
               "-silent", "-exit-on-print", filepath]
        resultado = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return {
            "ok": resultado.returncode == 0,
            "returncode": resultado.returncode,
            "stderr": resultado.stderr,
            "archivo": filename,
        }
    else:
        for _ in range(copias):
            win32api.ShellExecute(0, "print", filepath, None, ".", 0)
        return {"ok": True, "metodo": "shellexecute", "archivo": filename}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/salud":
            self._json(200, {"modulo": "imprimir", "estado": "activo", "puerto": PORT})
        elif self.path == "/impresoras":
            nombres, predeterminada = listar_impresoras()
            self._json(200, {"impresoras": nombres, "predeterminada": predeterminada})
        else:
            self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/imprimir":
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
            if not filename:
                self._json(400, {"error": "no se recibio archivo"})
                return

            resultado = imprimir_pdf_o_imagen(
                filename, file_content,
                impresora=campos.get("impresora", win32print.GetDefaultPrinter()),
                copias=int(campos.get("copias", 1)),
                orientacion=campos.get("orientacion", "portrait"),
                papel=campos.get("papel", "letter"),
                color=campos.get("color", "color"),
                duplex=campos.get("duplex", "no"),
            )
            self._json(200, resultado)
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status, data):
        import json
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"[imprimir] worker escuchando en http://localhost:{PORT}")
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
