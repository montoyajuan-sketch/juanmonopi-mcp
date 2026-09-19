# modules/control_remoto/main.py
# Worker de control remoto de mouse/teclado/ventanas. Puerto 9004.
# PODEROSO: controla la PC como si estuvieras sentado frente a ella.
# El acceso ya esta protegido por la sesion/api-key de Node; aun asi, usar con cuidado.

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
import ctypes

# Forzar Per-Monitor DPI Awareness para que las coordenadas de mouse/click
# coincidan en pixeles fisicos con las que usa captura_pantalla (ImageGrab).
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    pass

import pyautogui
import pygetwindow as gw
from PIL import ImageGrab
from io import BytesIO
from urllib.parse import urlparse, parse_qs

pyautogui.FAILSAFE = True  # mover el mouse a la esquina superior izq. aborta la accion en curso

import argparse
_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9004)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto


def accion_mover_mouse(p):
    pyautogui.moveTo(p["x"], p["y"], duration=p.get("duracion", 0.2))
    return {"ok": True}


def accion_click(p):
    pyautogui.click(x=p.get("x"), y=p.get("y"), button=p.get("boton", "left"),
                     clicks=p.get("clicks", 1))
    return {"ok": True}


def accion_escribir(p):
    pyautogui.typewrite(p["texto"], interval=p.get("intervalo", 0.02))
    return {"ok": True}


def accion_tecla(p):
    # p["tecla"] puede ser "enter", "esc", o combinacion como ["ctrl","c"]
    tecla = p["tecla"]
    if isinstance(tecla, list):
        pyautogui.hotkey(*tecla)
    else:
        pyautogui.press(tecla)
    return {"ok": True}


def accion_listar_ventanas(p):
    titulos = [t for t in gw.getAllTitles() if t.strip()]
    return {"ok": True, "ventanas": titulos}


def accion_activar_ventana(p):
    ventanas = gw.getWindowsWithTitle(p["titulo"])
    if not ventanas:
        return {"ok": False, "error": f"no se encontro ventana con titulo '{p['titulo']}'"}
    win = ventanas[0]
    try:
        if win.isMinimized:
            win.restore()
    except Exception:
        pass
    win.activate()
    return {"ok": True, "titulo": win.title, "estaba_minimizada": getattr(win, "isMinimized", None)}


def accion_cerrar_ventana(p):
    ventanas = gw.getWindowsWithTitle(p["titulo"])
    if not ventanas:
        return {"ok": False, "error": f"no se encontro ventana con titulo '{p['titulo']}'"}
    win = ventanas[0]
    titulo = win.title
    win.close()
    return {"ok": True, "titulo": titulo}


def accion_posicion_mouse(p):
    x, y = pyautogui.position()
    return {"ok": True, "x": x, "y": y}


def accion_arrastrar(p):
    # Arrastre libre: soporta un arrastre simple x1,y1 -> x2,y2, o una
    # lista de "puntos" (polilinea) para trazos curvos/a mano alzada.
    boton = p.get("boton", "left")
    puntos = p.get("puntos")
    if puntos and len(puntos) >= 2:
        pyautogui.moveTo(puntos[0]["x"], puntos[0]["y"], duration=0.05)
        pyautogui.mouseDown(button=boton)
        for punto in puntos[1:]:
            pyautogui.moveTo(punto["x"], punto["y"], duration=p.get("duracion", 0.05))
        pyautogui.mouseUp(button=boton)
        return {"ok": True, "puntos": len(puntos)}
    else:
        pyautogui.moveTo(p["x1"], p["y1"], duration=0.05)
        pyautogui.mouseDown(button=boton)
        pyautogui.moveTo(p["x2"], p["y2"], duration=p.get("duracion", 0.2))
        pyautogui.mouseUp(button=boton)
        return {"ok": True}


def accion_captura_ventana_activa(p):
    win = gw.getActiveWindow()
    return {"ok": True, "titulo": win.title if win else None}


def accion_volumen(p):
    # p["accion"]: "subir" | "bajar" | "mutear"
    # p.get("pasos", 1): cuantas veces repetir subir/bajar (cada paso ~2%)
    accion = p.get("accion", "subir")
    pasos = int(p.get("pasos", 1))
    tecla = {"subir": "volumeup", "bajar": "volumedown", "mutear": "volumemute"}.get(accion)
    if not tecla:
        return {"ok": False, "error": f"accion de volumen desconocida: {accion} (usar subir/bajar/mutear)"}
    for _ in range(max(1, pasos)):
        pyautogui.press(tecla)
    return {"ok": True, "accion": accion, "pasos": pasos}


ACCIONES = {
    "mover_mouse": accion_mover_mouse,
    "click": accion_click,
    "escribir": accion_escribir,
    "tecla": accion_tecla,
    "listar_ventanas": accion_listar_ventanas,
    "activar_ventana": accion_activar_ventana,
    "cerrar_ventana": accion_cerrar_ventana,
    "posicion_mouse": accion_posicion_mouse,
    "ventana_activa": accion_captura_ventana_activa,
    "arrastrar": accion_arrastrar,
    "volumen": accion_volumen,
}


# --- integrado desde crosshair_check.py --------------------------------
# Toma un screenshot real y le dibuja una cruz con los colores invertidos
# en (x, y), para verificar visualmente adonde apunta una coordenada antes
# de hacer click ahi. A diferencia del script original, no escribe a disco:
# devuelve el PNG directo en la respuesta HTTP.
def verificar_coordenada_png(px: int, py: int, arm: int = 30, thickness: int = 2) -> bytes:
    img = ImageGrab.grab().convert("RGB")
    pixels = img.load()
    w, h = img.size
    half = thickness // 2

    def invertir_pixel(x, y):
        if 0 <= x < w and 0 <= y < h:
            r, g, b = pixels[x, y]
            pixels[x, y] = (255 - r, 255 - g, 255 - b)

    for dx in range(-arm, arm + 1):
        for t in range(-half, half + 1):
            invertir_pixel(px + dx, py + t)
    for dy in range(-arm, arm + 1):
        for t in range(-half, half + 1):
            invertir_pixel(px + t, py + dy)

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/salud":
            self._json(200, {"modulo": "control_remoto", "estado": "activo", "puerto": PORT,
                              "acciones_disponibles": list(ACCIONES.keys())})
            return
        if parsed.path == "/verificar_coordenada":
            try:
                q = parse_qs(parsed.query)
                x = int(q["x"][0])
                y = int(q["y"][0])
                arm = int(q.get("arm", [30])[0])
                thickness = int(q.get("thickness", [2])[0])
                data = verificar_coordenada_png(x, y, arm, thickness)
                self.send_response(200)
                self.send_header("Content-type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except KeyError:
                self._json(400, {"error": "faltan parametros requeridos: x, y"})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return
        self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/accion":
            self._json(404, {"error": "ruta no encontrada"})
            return
        try:
            length = int(self.headers["Content-Length"])
            body = json.loads(self.rfile.read(length))
            accion = body.get("accion")
            fn = ACCIONES.get(accion)
            if not fn:
                self._json(400, {"error": f"accion desconocida: {accion}",
                                  "acciones_disponibles": list(ACCIONES.keys())})
                return
            resultado = fn(body.get("parametros", {}))
            self._json(200, resultado)
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
    print(f"[control_remoto] worker escuchando en http://localhost:{PORT}")
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
