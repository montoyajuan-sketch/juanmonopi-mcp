// modules/_shared/ps.js
// Helper compartido para los modulos que necesitan tirar un comando de
// PowerShell puntual (no una shell persistente) y leer su salida.
// Esta carpeta no tiene module.js, asi que el loader central la ignora
// -- no es un modulo en si, es una utilidad que importan otros.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export async function ejecutarPS(script, { timeoutMs = 15000 } = {}) {
  const { stdout } = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
  );
  return stdout;
}

// Para cuando un valor del usuario se interpola directo en un script de
// PowerShell (no como argumento aparte): saca comillas, backticks, $ y
// separadores de comando, para no dejar la puerta abierta a que alguien
// meta su propio comando ahi. No hace falta para valores que van como
// argv (esos ya los maneja spawn sin pasar por un shell).
export function limpiarParaPS(valor) {
  return String(valor).replace(/["'`$;|&]/g, "");
}

export function aBase64(texto) {
  return Buffer.from(texto, "utf-8").toString("base64");
}
