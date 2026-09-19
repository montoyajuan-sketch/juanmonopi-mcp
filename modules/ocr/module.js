// modules/ocr/module.js
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
  procesoPython.stdout.on("data", (d) => console.log(`[ocr] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[ocr:err] ${d.toString().trim()}`));
  procesoPython.on("close", () => { procesoPython = null; });

  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function reconocerTexto({ archivoBase64, nombre, idioma }) {
  await asegurarWorkerActivo();

  const buffer = Buffer.from(archivoBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([buffer]), nombre);
  if (idioma) form.append("idioma", idioma);

  const r = await fetch(`${URL_WORKER}/ocr`, { method: "POST", body: form });
  const data = await r.json();
  return { httpStatus: r.status, ...data };
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
      "reconocer_texto_ocr",
      {
        title: "OCR: reconocer texto",
        description: "Extrae el texto de una imagen o PDF (escaneado) usando OCR",
        inputSchema: {
          archivoBase64: z.string(),
          nombre: z.string(),
          idioma: z.string().optional().describe("Ej: 'spa', 'eng', 'spa+eng' (default)"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const resultado = await reconocerTexto(args);
        return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/ocr", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        res.json(await reconocerTexto(req.body));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
