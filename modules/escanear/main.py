# modules/escanear/main.py
# Worker de escaneo (WIA) del modulo "escanear". Puerto asignado dinamicamente
# por el loader central. No expone GUI: recibe POST /escanear con JSON y
# guarda el resultado directo en el disco del host (ruta que le pasa Node).

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
import time
import win32com.client
import pythoncom

try:
    from PIL import Image
    PIL_DISPONIBLE = True
except ImportError:
    PIL_DISPONIBLE = False

import argparse
_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9002)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto

CARPETA_MODULO = os.path.dirname(os.path.abspath(__file__))
CARPETA_TEMP = os.path.join(CARPETA_MODULO, "_temp")
os.makedirs(CARPETA_TEMP, exist_ok=True)

# 0x80210003 (WIA_ERROR_PAPER_EMPTY): el alimentador automatico (ADF) se quedo
# sin hojas. Es el corte normal de un loop de escaneo multi-pagina, no un error real.
WIA_ERROR_PAPER_EMPTY_HEX = "0x80210003"

# IDs de propiedad WIA (convencion estandar del protocolo, no cambian entre escaneres,
# aunque no todos los escaneres soportan todas -- por eso _set_prop_seguro ignora fallos).
PROP_COLOR_INTENT = "6146"
PROP_RES_H = "6147"
PROP_RES_V = "6148"
COLOR_INTENTS = {"color": 1, "grises": 2, "gris": 2, "bw": 4, "byn": 4}


def listar_dispositivos():
    pythoncom.CoInitialize()
    wia = win32com.client.Dispatch("WIA.DeviceManager")
    dispositivos = []
    for i in range(1, wia.DeviceInfos.Count + 1):
        info = wia.DeviceInfos.Item(i)
        dispositivos.append({"indice": i - 1, "nombre": info.Properties("Name").Value})
    return dispositivos


def _set_prop_seguro(properties, prop_id, valor):
    try:
        properties(prop_id).Value = valor
    except Exception:
        pass


def escanear(indice_dispositivo, color, resolucion, formato, paginas, ruta_salida, espera_entre_paginas_ms=0):
    pythoncom.CoInitialize()
    wia = win32com.client.Dispatch("WIA.DeviceManager")
    if wia.DeviceInfos.Count == 0:
        raise Exception("No hay escáneres conectados")
    if indice_dispositivo >= wia.DeviceInfos.Count:
        raise Exception(f"Índice de escáner inválido (hay {wia.DeviceInfos.Count} conectados, revisá con la lista de dispositivos)")

    info = wia.DeviceInfos.Item(indice_dispositivo + 1)  # WIA es 1-indexado
    device = info.Connect()
    item = device.Items.Item(1)

    intent = COLOR_INTENTS.get(str(color).lower(), 1)
    _set_prop_seguro(item.Properties, PROP_COLOR_INTENT, intent)
    _set_prop_seguro(item.Properties, PROP_RES_H, resolucion)
    _set_prop_seguro(item.Properties, PROP_RES_V, resolucion)

    max_paginas = 9999 if paginas in ("todas", 0, None) else int(paginas)
    temp_files = []

    pagina = 0
    while pagina < max_paginas:
        try:
            imagen = item.Transfer()
        except Exception as e:
            if pagina > 0 and WIA_ERROR_PAPER_EMPTY_HEX in str(e):
                break  # se acabaron las hojas del ADF, corte normal
            raise Exception(f"Error al escanear página {pagina + 1}: {e}")

        pagina += 1
        temp_path = os.path.join(CARPETA_TEMP, f"pag{pagina}_{os.getpid()}.bmp")
        if os.path.exists(temp_path):
            os.remove(temp_path)
        imagen.SaveFile(temp_path)
        temp_files.append(temp_path)

        # Pausa entre paginas: en un escaner plano (sin ADF) da tiempo a
        # cambiar la hoja a mano antes de que se pida la siguiente. En un
        # ADF real no hace falta (el alimentador ya la tiene lista), pero no
        # molesta dejarla en 0 en ese caso.
        if espera_entre_paginas_ms > 0 and pagina < max_paginas:
            time.sleep(espera_entre_paginas_ms / 1000)

    if not temp_files:
        raise Exception("No se pudo escanear ninguna página")

    os.makedirs(os.path.dirname(os.path.abspath(ruta_salida)) or ".", exist_ok=True)

    try:
        if formato == "pdf":
            if not PIL_DISPONIBLE:
                raise Exception("Pillow no está instalado, no se puede armar el PDF")
            imagenes = [Image.open(f).convert("RGB") for f in temp_files]
            imagenes[0].save(ruta_salida, save_all=True, append_images=imagenes[1:])
            for im in imagenes:
                im.close()
            return {"ok": True, "archivo": ruta_salida, "paginas": len(temp_files)}

        elif len(temp_files) == 1:
            Image.open(temp_files[0]).convert("RGB").save(ruta_salida)
            return {"ok": True, "archivo": ruta_salida, "paginas": 1}

        else:
            base, ext = os.path.splitext(ruta_salida)
            finales = []
            for i, f in enumerate(temp_files, 1):
                destino = f"{base}_pag{i}{ext}"
                Image.open(f).convert("RGB").save(destino)
                finales.append(destino)
            return {"ok": True, "archivos": finales, "paginas": len(finales)}
    finally:
        for f in temp_files:
            try:
                os.remove(f)
            except OSError:
                pass


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/salud":
            self._json(200, {"modulo": "escanear", "estado": "activo", "puerto": PORT})
        elif self.path == "/dispositivos":
            try:
                self._json(200, {"dispositivos": listar_dispositivos()})
            except Exception as e:
                self._json(500, {"error": str(e)})
        else:
            self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/escanear":
            self._json(404, {"error": "ruta no encontrada"})
            return
        try:
            length = int(self.headers["Content-Length"])
            body = self.rfile.read(length)
            datos = json.loads(body)
            resultado = escanear(
                indice_dispositivo=int(datos.get("dispositivo", 0)),
                color=datos.get("color", "color"),
                resolucion=int(datos.get("resolucion", 300)),
                formato=datos.get("formato", "pdf"),
                paginas=datos.get("paginas", 1),
                ruta_salida=datos["rutaSalida"],
                espera_entre_paginas_ms=int(datos.get("esperaEntrePaginasMs", 0)),
            )
            self._json(200, resultado)
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"[escanear] worker escuchando en http://localhost:{PORT}")
    with socketserver.TCPServer(("localhost", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()
