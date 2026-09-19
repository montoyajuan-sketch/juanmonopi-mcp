// modules/escanear/module.js
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

const CARPETA_DEFAULT = path.join(__dirname, "escaneos_recibidos");

async function asegurarWorkerActivo() {
  try {
    const r = await fetch(`${URL_WORKER}/salud`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch {
    // no esta corriendo, lo levantamos abajo
  }

  if (procesoPython) return true;

  procesoPython = spawn(resolverPython(__dirname), [MAIN, "--puerto", String(PUERTO)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  procesoPython.stdout.on("data", (d) => console.log(`[escanear] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[escanear:err] ${d.toString().trim()}`));
  procesoPython.on("close", (code) => {
    console.log(`[escanear] worker python se cerro (codigo ${code})`);
    procesoPython = null;
  });

  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function listarDispositivos() {
  await asegurarWorkerActivo();
  const r = await fetch(`${URL_WORKER}/dispositivos`);
  return r.json();
}

// El resultado siempre se guarda en el disco del host (nunca vuelve en base64
// por defecto): un escaneo a 300dpi pesa varios MB, y devolverlo entero por
// la respuesta se comería el contexto para nada. 'ruta' opcional para elegir
// donde; si no se manda, va a la carpeta del propio modulo.
async function escanear({ dispositivo, color, resolucion, formato, paginas, ruta, esperaEntrePaginasMs }) {
  await asegurarWorkerActivo();

  const fmt = (formato || "pdf").toLowerCase();
  const rutaSalida = ruta || path.join(CARPETA_DEFAULT, `escaneo-${Date.now()}.${fmt}`);

  const r = await fetch(`${URL_WORKER}/escanear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dispositivo: dispositivo ?? 0,
      color: color || "color",
      resolucion: resolucion || 300,
      formato: fmt,
      paginas: paginas ?? 1,
      rutaSalida,
      esperaEntrePaginasMs: esperaEntrePaginasMs ?? 5000,
    }),
  });
  const data = await r.json();
  return { httpStatus: r.status, ...data };
}

export default {
  nombre: info.nombre,
  info,

  async iniciar(puerto) {
    PUERTO = puerto;
    URL_WORKER = `http://localhost:${PUERTO}`;
    fs.mkdirSync(CARPETA_DEFAULT, { recursive: true });
    // No arrancamos el worker python de una: inicializar COM/WIA tiene su
    // costo y no hace falta hasta que alguien pida escanear algo.
  },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "escaneres",
      {
        title: "Listar escáneres",
        description: "Lista los escáneres o impresoras multifunción conectados (vía WIA), cada uno con un índice para usar en 'escanear_documento'.",
        inputSchema: { clave: z.string().optional() },
      },
      async ({ clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          const { dispositivos } = await listarDispositivos();
          if (!dispositivos.length) {
            return { content: [{ type: "text", text: "No se encontraron escáneres conectados." }] };
          }
          const texto = dispositivos.map((d) => `${d.indice}. ${d.nombre}`).join("\n");
          return { content: [{ type: "text", text: texto }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      }
    );

    server.registerTool(
      "escanear_documento",
      {
        title: "Escanear documento",
        description:
          "Escanea desde un escáner conectado (WIA) y guarda el resultado en el disco del host. Usá 'ruta' para elegir dónde guardarlo; si no se manda, se guarda en la carpeta del módulo. 'paginas' > 1 o 'todas' asume varias hojas: en un alimentador automático (ADF) es directo, en un escáner plano (flatbed) usá 'esperaEntrePaginasMs' (default 5000) para tener tiempo de cambiar la hoja a mano entre página y página.",
        inputSchema: {
          dispositivo: z.number().optional(),
          color: z.enum(["color", "grises", "bw"]).optional(),
          resolucion: z.number().optional(),
          formato: z.enum(["pdf", "png", "jpg"]).optional(),
          paginas: z.union([z.number(), z.literal("todas")]).optional(),
          esperaEntrePaginasMs: z.number().optional(),
          ruta: z.string().optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        try {
          const resultado = await escanear(args);
          return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/escaneres", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        res.json(await listarDispositivos());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post("/escanear", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        res.json(await escanear(req.body));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
