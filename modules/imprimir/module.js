// modules/imprimir/module.js
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { resolverPython } from "../_shared/python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// module_info.json ya NO define el puerto -- eso lo asigna el loader central
// (modules/registro.js) al arrancar, para que nunca puedan chocar dos modulos.
const info = JSON.parse(fs.readFileSync(path.join(__dirname, "module_info.json"), "utf-8"));
const MAIN = info.main;

let PUERTO = null;
let URL_WORKER = null;
let procesoPython = null;

// Revisa si el worker python ya esta respondiendo (por si quedo corriendo
// de una sesion anterior), y si no, lo levanta.
async function asegurarWorkerActivo() {
  try {
    const r = await fetch(`${URL_WORKER}/salud`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch {
    // no esta corriendo, lo levantamos abajo
  }

  if (procesoPython) return true; // ya lo estamos levantando

  procesoPython = spawn(resolverPython(__dirname), [MAIN, "--puerto", String(PUERTO)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  procesoPython.stdout.on("data", (d) => console.log(`[imprimir] ${d.toString().trim()}`));
  procesoPython.stderr.on("data", (d) => console.error(`[imprimir:err] ${d.toString().trim()}`));
  procesoPython.on("close", (code) => {
    console.log(`[imprimir] worker python se cerro (codigo ${code})`);
    procesoPython = null;
  });

  // Le damos un momento a Python para levantar el server antes de la primera llamada real.
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

// Pide la lista de impresoras al worker python (nombre real + cual es la default).
async function listarImpresoras() {
  await asegurarWorkerActivo();
  const r = await fetch(`${URL_WORKER}/impresoras`);
  return r.json(); // { impresoras: [...], predeterminada: "..." }
}

// Permite mandar la impresora como codigo numerico (1, 2, 3...) ademas del
// nombre completo, para no tener que escribir nombres con espacios/mayusculas
// tal cual figuran en Windows (fuente de errores tontos).
async function resolverImpresora(valor) {
  if (valor === undefined || valor === null || valor === "") return undefined;
  const num = Number(valor);
  const esCodigoNumerico = valor !== "" && !Number.isNaN(num) && Number.isInteger(num);
  if (!esCodigoNumerico) return valor; // ya vino como nombre, se usa tal cual

  const { impresoras: lista } = await listarImpresoras();
  const nombre = lista[num - 1];
  if (!nombre) {
    throw new Error(
      `Código de impresora ${num} inválido. Usá la tool 'impresoras' para ver los códigos disponibles (1 a ${lista.length}).`
    );
  }
  return nombre;
}

// Logica compartida: arma el multipart y llama al worker python.
// Acepta el archivo de dos formas:
//  - ruta: lee el archivo directo del disco del host (ideal cuando quien pide
//    la impresion ya esta hablando con esta misma PC, evita mandar el base64
//    de un lado a otro para nada).
//  - archivoBase64: para cuando el archivo no esta en el disco del host
//    (por ejemplo, algo subido a un chat y todavia no bajado a la PC).
async function imprimir({ archivoBase64, ruta, nombre, impresora, copias, orientacion, papel, color, duplex }) {
  await asegurarWorkerActivo();

  let buffer;
  let nombreFinal = nombre;

  if (ruta) {
    buffer = fs.readFileSync(ruta); // tira su propio error claro si no existe / no hay permiso
    if (!nombreFinal) nombreFinal = path.basename(ruta);
  } else if (archivoBase64) {
    buffer = Buffer.from(archivoBase64, "base64");
  } else {
    throw new Error("Hay que mandar 'ruta' (archivo en el disco del host) o 'archivoBase64'.");
  }

  const impresoraResuelta = await resolverImpresora(impresora);

  const form = new FormData();
  form.append("file", new Blob([buffer]), nombreFinal || "documento");
  form.append("impresora", impresoraResuelta || "HP Ink Tank Wireless 410 series");
  form.append("copias", String(copias || 1));
  form.append("orientacion", orientacion || "portrait");
  form.append("papel", papel || "letter");
  form.append("color", color || "color");
  form.append("duplex", duplex || "no");

  const r = await fetch(`${URL_WORKER}/imprimir`, { method: "POST", body: form });
  const data = await r.json();
  return { httpStatus: r.status, ...data };
}

export default {
  nombre: info.nombre,
  info, // se expone completo por si el loader central lo quiere mostrar/validar

  async iniciar(puerto) {
    PUERTO = puerto;
    URL_WORKER = `http://localhost:${PUERTO}`;
    await asegurarWorkerActivo();
  },

  // --- Para mi (MCP) ---
  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "impresoras",
      {
        title: "Listar impresoras",
        description: "Lista las impresoras disponibles en la PC, cada una con un código numérico corto (1, 2, 3...) para usar en 'imprimir_archivo' sin tener que escribir el nombre completo (evita errores por espacios/mayúsculas raras).",
        inputSchema: { clave: z.string().optional() },
      },
      async ({ clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          const { impresoras, predeterminada } = await listarImpresoras();
          if (!impresoras.length) {
            return { content: [{ type: "text", text: "No se encontraron impresoras instaladas." }] };
          }
          const texto = impresoras
            .map((nombre, i) => `${i + 1}. ${nombre}${nombre === predeterminada ? " (predeterminada)" : ""}`)
            .join("\n");
          return { content: [{ type: "text", text: texto }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      }
    );

    server.registerTool(
      "imprimir_archivo",
      {
        title: "Imprimir archivo",
        description: "Envía un PDF o imagen a imprimir en la impresora conectada a la PC. Pasa 'ruta' si el archivo ya está en el disco del host (evita mandar el archivo entero por la llamada); si no está en el host, pasa 'archivoBase64'. Para 'impresora' podés pasar el código numérico que da la tool 'impresoras' en vez del nombre completo.",
        inputSchema: {
          ruta: z.string().optional(),
          archivoBase64: z.string().optional(),
          nombre: z.string().optional(),
          impresora: z.union([z.string(), z.number()]).optional(),
          copias: z.number().optional(),
          orientacion: z.enum(["portrait", "landscape"]).optional(),
          papel: z.string().optional(),
          color: z.enum(["color", "bw"]).optional(),
          duplex: z.enum(["no", "long", "short"]).optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        try {
          const resultado = await imprimir(args);
          return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      }
    );
  },

  // --- Para el frontend de Cloudflare (REST, con API key) ---
  // Nota: 'ruta' solo tiene sentido para llamadas locales (MCP); un cliente
  // REST remoto (el Worker) no tiene por qué tener acceso al disco del host,
  // así que en la práctica va a mandar siempre archivoBase64. Se deja el
  // soporte por si en algún momento se llama a este endpoint desde el mismo
  // host (ej. un script local).
  registrarRest(router, { verificarApiKey }) {
    router.post("/imprimir", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key inválida o faltante (header x-api-key)" });
      }
      try {
        const resultado = await imprimir(req.body);
        res.json(resultado);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },
};
