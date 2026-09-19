// modules/captura_pantalla/module.js
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
  procesoPython.stdout.on("data", (d) => console.log(`[captura_pantalla] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[captura_pantalla:err] ${d.toString().trim()}`));
  procesoPython.on("close", () => { procesoPython = null; });

  await new Promise((r) => setTimeout(r, 1000));
  return true;
}

async function capturar({ x, y, w, h } = {}) {
  await asegurarWorkerActivo();
  const params = new URLSearchParams();
  if (x != null && y != null && w != null && h != null) {
    params.set("x", x); params.set("y", y); params.set("w", w); params.set("h", h);
  }
  const r = await fetch(`${URL_WORKER}/capturar?${params.toString()}`);
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
      "capturar_pantalla",
      {
        title: "Capturar pantalla",
        description: "Toma una captura de pantalla de la PC (completa o de una región específica)",
        inputSchema: {
          x: z.number().optional(),
          y: z.number().optional(),
          w: z.number().optional(),
          h: z.number().optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const { ok, buffer } = await capturar(args);
        if (!ok) return { content: [{ type: "text", text: "Error al capturar pantalla" }] };
        return {
          content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }],
        };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/captura", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        const { ok, buffer } = await capturar(req.query);
        if (!ok) return res.status(500).json({ error: "no se pudo capturar" });
        res.set("Content-Type", "image/png");
        res.send(buffer);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
