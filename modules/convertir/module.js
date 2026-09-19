// modules/convertir/module.js
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
  procesoPython.stdout.on("data", (d) => console.log(`[convertir] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[convertir:err] ${d.toString().trim()}`));
  procesoPython.on("close", () => { procesoPython = null; });

  // el primer arranque precalienta Chromium, dale mas tiempo que a los demas modulos
  await new Promise((r) => setTimeout(r, 4000));
  return true;
}

async function convertir({ archivoBase64, nombre, formatoSalida }) {
  await asegurarWorkerActivo();

  const buffer = Buffer.from(archivoBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([buffer]), nombre);
  form.append("formatoSalida", formatoSalida);

  // las conversiones pueden tardar (arranque de pagina + wasm), damos margen generoso
  const r = await fetch(`${URL_WORKER}/convertir`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(45000),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `status ${r.status}` }));
    return { ok: false, ...err };
  }

  const nombreSalida = r.headers.get("X-Nombre-Archivo") || `convertido.${formatoSalida}`;
  const bufferSalida = Buffer.from(await r.arrayBuffer());
  return { ok: true, nombre: nombreSalida, buffer: bufferSalida };
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
      "convertir_archivo",
      {
        title: "Convertir archivo",
        description:
          "Convierte un archivo a otro formato (documentos, imágenes, audio, video, etc.) usando convert.to.it. " +
          "Soporta cientos de formatos porque usa el mismo motor de esa herramienta.",
        inputSchema: {
          archivoBase64: z.string(),
          nombre: z.string(),
          formatoSalida: z.string().describe("Extensión deseada, ej: 'pdf', 'docx', 'mp3', 'png'"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const resultado = await convertir(args);
        if (!resultado.ok) {
          return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, nombre: resultado.nombre, tamañoBytes: resultado.buffer.length }),
            },
            {
              type: "resource",
              resource: {
                uri: `data:application/octet-stream;base64,${resultado.buffer.toString("base64")}`,
                name: resultado.nombre,
              },
            },
          ],
        };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/convertir", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        const resultado = await convertir(req.body);
        if (!resultado.ok) return res.status(500).json(resultado);
        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="${resultado.nombre}"`);
        res.send(resultado.buffer);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
