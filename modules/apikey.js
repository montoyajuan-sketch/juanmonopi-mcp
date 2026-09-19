// modules/apikey.js
// API key simple para el REST publico que llama el frontend de Cloudflare.
// Distinta del login usuario/contrasena (ese es para mi, via MCP).
import fs from "fs";
import path from "path";
import crypto from "crypto";

const RUTA = path.join(process.cwd(), "apikey.json");

export function obtenerOCrearApiKey() {
  if (fs.existsSync(RUTA)) {
    return JSON.parse(fs.readFileSync(RUTA, "utf-8")).apiKey;
  }
  const apiKey = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(RUTA, JSON.stringify({ apiKey }, null, 2), "utf-8");
  console.log("\n==================================================");
  console.log(" API key generada para el REST publico (guardala en tu Worker de Cloudflare):");
  console.log(" " + apiKey);
  console.log(" (tambien quedo guardada en apikey.json)");
  console.log("==================================================\n");
  return apiKey;
}

export function crearVerificador(apiKey) {
  return function verificarApiKey(intentada) {
    return typeof intentada === "string" && intentada === apiKey;
  };
}
