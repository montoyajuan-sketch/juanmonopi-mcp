# modules/captura_pantalla/main.py
# Worker de captura de pantalla. Puerto 9003.
# Devuelve un PNG con lo que se ve en la pantalla (o una region especifica).

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
from io import BytesIO
from urllib.parse import urlparse, parse_qs

from PIL import ImageGrab
import argparse
import ctypes

# Forzar Per-Monitor DPI Awareness para que las coordenadas de captura
# coincidan en pixeles fisicos con las que usa control_remoto (pyautogui).
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    pass

_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9003)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/salud":
            self._json(200, {"modulo": "captura_pantalla", "estado": "activo", "puerto": PORT})
            return
        if parsed.path != "/capturar":
            self._json(404, {"error": "ruta no encontrada"})
            return

        try:
            q = parse_qs(parsed.query)
            bbox = None
            if all(k in q for k in ("x", "y", "w", "h")):
                x, y = int(q["x"][0]), int(q["y"][0])
                w, h = int(q["w"][0]), int(q["h"][0])
                bbox = (x, y, x + w, y + h)

            # all_screens=True captura todos los monitores conectados (virtual screen completo)
            img = ImageGrab.grab(bbox=bbox, all_screens=True)
            buf = BytesIO()
            img.save(buf, format="PNG")
            data = buf.getvalue()

            self.send_response(200)
            self.send_header("Content-type", "image/png")
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
    print(f"[captura_pantalla] worker escuchando en http://localhost:{PORT}")
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
