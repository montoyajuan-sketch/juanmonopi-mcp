// modules/control_remoto/module.js
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { resolverPython } from "../_shared/python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const info = JSON.parse(fs.readFileSync(path.join(__dirname, "module_info.json"), "utf-8"));
const MAIN = info.main;

let PUERTO = null;
let URL_WORKER = null;
let procesoPython = null;

async function asegurarWorkerActivo() {
  try {
    const r = await fetch(`${URL_WORKER}/salud`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch {}
  if (procesoPython) return true;

  procesoPython = spawn(resolverPython(__dirname), [MAIN, "--puerto", String(PUERTO)], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  procesoPython.stdout.on("data", (d) => console.log(`[control_remoto] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[control_remoto:err] ${d.toString().trim()}`));
  procesoPython.on("close", () => { procesoPython = null; });

  await new Promise((r) => setTimeout(r, 1000));
  return true;
}

async function ejecutarAccion(accion, parametros = {}) {
  await asegurarWorkerActivo();
  const r = await fetch(`${URL_WORKER}/accion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accion, parametros }),
  });
  const data = await r.json();
  return { httpStatus: r.status, ...data };
}

const ACCIONES_ENUM = [
  "mover_mouse", "click", "escribir", "tecla",
  "listar_ventanas", "activar_ventana", "cerrar_ventana",
  "posicion_mouse", "ventana_activa", "arrastrar", "volumen",
];

// Toma un screenshot y devuelve el PNG con una cruz (colores invertidos)
// dibujada en (x,y), para verificar visualmente una coordenada antes de
// hacer click ahi. Integrado desde crosshair_check.py.
async function verificarCoordenada({ x, y, arm, thickness } = {}) {
  await asegurarWorkerActivo();
  const params = new URLSearchParams({ x, y });
  if (arm != null) params.set("arm", arm);
  if (thickness != null) params.set("thickness", thickness);
  const r = await fetch(`${URL_WORKER}/verificar_coordenada?${params.toString()}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  return { ok: r.ok, buffer };
}

export default {
  nombre: info.nombre,
  info,

  async iniciar(puerto) {
    PUERTO = puerto;
    URL_WORKER = `http://localhost:${PUERTO}`;
    await asegurarWorkerActivo();
  },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "control_remoto",
      {
        title: "Controlar mouse/teclado/ventanas",
        description:
          "Controla el mouse, teclado y ventanas de la PC de forma remota. Acciones: mover_mouse{x,y}, " +
          "click{x,y,boton,clicks}, escribir{texto}, tecla{tecla}, listar_ventanas{}, " +
          "activar_ventana{titulo}, cerrar_ventana{titulo}, posicion_mouse{}, ventana_activa{}, " +
          "arrastrar{x1,y1,x2,y2} o arrastrar{puntos:[{x,y},...]} para trazos, " +
          "volumen{accion:'subir'|'bajar'|'mutear', pasos}.",
        inputSchema: {
          accion: z.enum(ACCIONES_ENUM),
          parametros: z.record(z.any()).optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const resultado = await ejecutarAccion(args.accion, args.parametros);
        return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
      }
    );

    server.registerTool(
      "verificar_coordenada",
      {
        title: "Verificar coordenada en pantalla",
        description:
          "Toma un screenshot real y devuelve una imagen con una cruz (colores invertidos) marcando " +
          "las coordenadas (x,y), para confirmar visualmente adónde apunta un punto antes de hacer click ahí.",
        inputSchema: {
          x: z.number(),
          y: z.number(),
          arm: z.number().optional().describe("Largo de cada brazo de la cruz en px (default 30)"),
          thickness: z.number().optional().describe("Grosor de la cruz en px (default 2)"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const { ok, buffer } = await verificarCoordenada(args);
        if (!ok) return { content: [{ type: "text", text: "Error al generar la verificación" }] };
        return {
          content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }],
        };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/control", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        res.json(await ejecutarAccion(req.body.accion, req.body.parametros));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get("/control/verificar_coordenada", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        const { ok, buffer } = await verificarCoordenada(req.query);
        if (!ok) return res.status(500).json({ error: "no se pudo generar la verificación" });
        res.set("Content-Type", "image/png");
        res.send(buffer);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
