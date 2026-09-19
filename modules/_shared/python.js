// modules/_shared/python.js
// Elige que interprete de Python usar para levantar el worker de un modulo:
// si existe un venv propio del modulo (armado con instalar-dependencias-python.ps1),
// se usa ese -- aislado, con sus propias dependencias, portable a otra PC.
// Si no existe (todavia no se corrio el instalador, o es un setup viejo),
// cae de vuelta al "python" global, como funcionaba antes.

import fs from "fs";
import path from "path";

export function resolverPython(carpetaModulo) {
  // Prioridad 1: Python embebido del proyecto + vendor propio del modulo.
  // No requiere que la PC tenga Python instalado -- es la forma "portable
  // de verdad". El main.py de cada modulo hace site.addsitedir(vendor) al
  // arrancar, asi que ejecutarlo con este interprete alcanza.
  const raizProyecto = path.join(carpetaModulo, "..", "..");
  const pythonEmbebido = path.join(raizProyecto, "python-embed", "python.exe");
  const vendorDelModulo = path.join(carpetaModulo, "vendor");
  if (fs.existsSync(pythonEmbebido) && fs.existsSync(vendorDelModulo)) {
    return pythonEmbebido;
  }

  // Prioridad 2: venv propio del modulo (requiere que ESTA pc ya tuviera
  // Python para crearlo -- no es portable a otra maquina, pero funciona
  // bien si el setup se hizo en esta misma PC).
  const pythonVenv = path.join(carpetaModulo, "venv", "Scripts", "python.exe");
  if (fs.existsSync(pythonVenv)) return pythonVenv;

  // Prioridad 3: lo que haya en el PATH global, como funcionaba al principio.
  return "python";
}
