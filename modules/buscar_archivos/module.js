// modules/buscar_archivos/module.js
// Busqueda recursiva de archivos por nombre/extension, y opcionalmente
// por contenido de texto. A diferencia de listar_archivos (una carpeta
// puntual), esto recorre subcarpetas.
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

function escaparPs(s) {
  return String(s ?? "").replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

async function buscar({ raiz, nombre, extension, contenido, maxResultados }) {
  const tope = Math.min(maxResultados || 50, 200);
  const raizEsc = escaparPs(raiz);
  const filtroNombre = nombre ? `*${escaparPs(nombre)}*` : "*";
  const filtroExt = extension ? (extension.startsWith(".") ? extension : "." + extension) : null;

  let script = `Get-ChildItem -Path "${raizEsc}" -Recurse -File -Filter "${filtroNombre}" -ErrorAction SilentlyContinue`;
  if (filtroExt) {
    script += ` | Where-Object { $_.Extension -ieq "${escaparPs(filtroExt)}" }`;
  }
  if (contenido) {
    script += ` | Where-Object { (Select-String -Path $_.FullName -Pattern "${escaparPs(contenido)}" -SimpleMatch -ErrorAction SilentlyContinue) }`;
  }
  script += ` | Select-Object -First ${tope} FullName,@{n='tamanoKB';e={[math]::Round($_.Length/1KB,1)}},LastWriteTime | ConvertTo-Json -Compress`;

  const { stdout } = await execFileP("powershell", ["-NoProfile", "-Command", script], {
    maxBuffer: 1024 * 1024 * 20,
  });
  if (!stdout.trim()) return [];
  const data = JSON.parse(stdout);
  return Array.isArray(data) ? data : [data];
}

export default {
  nombre: "buscar_archivos",
  info: { nombre: "buscar_archivos" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "buscar_archivos",
      {
        title: "Buscar archivos (recursivo)",
        description: "Busca archivos recursivamente a partir de una carpeta raiz, filtrando por nombre (comodin), extension, y/o texto contenido dentro de los archivos. Usar una raiz razonablemente acotada (no todo C:\\\\) para que no tarde demasiado.",
        inputSchema: {
          raiz: z.string().describe("Carpeta desde donde empezar a buscar, ej. C:\\\\Users\\\\Lenovo\\\\Documents"),
          nombre: z.string().optional().describe("Texto que debe contener el nombre del archivo"),
          extension: z.string().optional().describe("Ej. 'pdf' o '.pdf'"),
          contenido: z.string().optional().describe("Texto que debe aparecer dentro del archivo (busqueda simple, no regex). Puede ser lento en carpetas grandes."),
          maxResultados: z.number().optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const resultados = await buscar(args);
        return {
          content: [{
            type: "text",
            text: resultados.length
              ? JSON.stringify(resultados, null, 2)
              : "No se encontraron archivos que coincidan.",
          }],
        };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/buscar_archivos", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json(await buscar(req.body || {}));
    });
  },
};
