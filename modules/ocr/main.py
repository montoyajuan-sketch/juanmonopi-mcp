# modules/ocr/main.py
# Worker de OCR. Puerto 9002.
# Recibe imagen o PDF y devuelve el texto reconocido (Tesseract).
# Los PDFs se rasterizan pagina por pagina con PyMuPDF antes del OCR.

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
import json
from io import BytesIO

import pytesseract
from PIL import Image
import fitz  # PyMuPDF

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

import argparse
_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9002)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto

IDIOMA_DEFAULT = "spa+eng"
DPI_RASTERIZADO = 200

EXT_IMAGENES = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tiff")


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


def ocr_imagen(imagen_bytes, idioma):
    img = Image.open(BytesIO(imagen_bytes))
    return pytesseract.image_to_string(img, lang=idioma)


def ocr_pdf(pdf_bytes, idioma):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    paginas = []
    zoom = DPI_RASTERIZADO / 72
    matriz = fitz.Matrix(zoom, zoom)
    for i, pagina in enumerate(doc):
        pix = pagina.get_pixmap(matrix=matriz)
        img = Image.open(BytesIO(pix.tobytes("png")))
        texto = pytesseract.image_to_string(img, lang=idioma)
        paginas.append({"pagina": i + 1, "texto": texto})
    doc.close()
    return paginas


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/salud":
            self._json(200, {"modulo": "ocr", "estado": "activo", "puerto": PORT})
        else:
            self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/ocr":
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

            idioma = campos.get("idioma", IDIOMA_DEFAULT)

            if filename.lower().endswith(".pdf"):
                paginas = ocr_pdf(file_content, idioma)
                texto_completo = "\n\n".join(p["texto"] for p in paginas)
                self._json(200, {
                    "ok": True, "archivo": filename, "tipo": "pdf",
                    "paginas": paginas, "texto": texto_completo,
                })
            elif filename.lower().endswith(EXT_IMAGENES):
                texto = ocr_imagen(file_content, idioma)
                self._json(200, {"ok": True, "archivo": filename, "tipo": "imagen", "texto": texto})
            else:
                self._json(400, {"error": f"formato no soportado: {filename}"})
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
    print(f"[ocr] worker escuchando en http://localhost:{PORT}")
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
