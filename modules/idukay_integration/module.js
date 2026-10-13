// modules/idukay_integration/module.js
//
// Integra el MCP con la API de idukay.net, reutilizando una sesion
// capturada a mano (headers + cookie) desde el navegador/la app de
// escritorio -- no hay login propio aca, ni se guarda usuario/contrasena
// de idukay en ningun lado.
//
// La sesion vive en sesion.json, al lado de este archivo, y SE VENCE con
// el tiempo (sobre todo 'authorization' y la cookie de sesion). Cuando
// eso pase, las tools de este modulo van a devolver el mensaje de
// "sesion vencida" en vez de tirar un error crudo -- hay que volver a
// capturar los headers (DevTools > Network, alguna llamada a
// idukay.net/colegios/api/..., "Copy as fetch") y actualizar sesion.json.

import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA_SESION = path.join(__dirname, "sesion.json");

// Se relee en cada llamada (no se cachea en memoria) para que, si
// actualizas sesion.json con una captura fresca, se use de inmediato sin
// tener que reiniciar el servidor entero.
function cargarSesion() {
  try {
    return JSON.parse(fs.readFileSync(RUTA_SESION, "utf-8"));
  } catch {
    return null;
  }
}

// Mismo subconjunto de headers que ya usa la app de escritorio
// (buildIdukayRequestHeaders en idukay_desktop/main.js) -- el resto de
// los headers que manda un navegador real (sec-ch-ua-*, etc) son solo
// fingerprinting del cliente, la API no los necesita para autenticar.
function headersIdukay(sesion, extra = {}) {
  return {
    accept: "application/json, text/plain, */*",
    authorization: sesion.authorization,
    clientversion: sesion.clientversion || "",
    profiletype: sesion.profiletype || "",
    selectedstudent: sesion.selectedstudent || "",
    timezone: sesion.timezone || "",
    workingprofile: sesion.workingprofile || "",
    workingschool: sesion.workingschool || "",
    workingyear: sesion.workingyear || "",
    cookie: sesion.cookie || "",
    referer: "https://idukay.net/colegios/",
    ...extra,
  };
}

function errorSesion() {
  return {
    content: [
      {
        type: "text",
        text:
          "No hay sesión de Idukay guardada, o venció. Actualizá modules/idukay_integration/sesion.json con headers frescos " +
          "(DevTools del navegador → pestaña Network → alguna llamada a idukay.net/colegios/api/... → 'Copy as fetch', y sacá de ahí " +
          "'authorization' y 'cookie'; los demás campos casi no cambian).",
      },
    ],
  };
}

export default {
  nombre: "idukay_integration",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    // --- 1) Últimas notificaciones ---
    server.registerTool(
      "idukay_notificaciones",
      {
        title: "Últimas notificaciones de Idukay",
        description:
          "Lista las últimas notificaciones/alertas de Idukay (título, si está leída, fecha, tipo, referencia). No las marca como leídas -- para eso está 'idukay_detalle_notificacion'.",
        inputSchema: {
          cantidad: z.number().optional().describe("Cuántas traer, default 20"),
          clave: z.string().optional(),
        },
      },
      async ({ cantidad, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();

        const sesion = cargarSesion();
        if (!sesion?.authorization) return errorSesion();

        try {
          const n = cantidad || 20;
          const sort = encodeURIComponent(JSON.stringify({ date: "desc", _id: "desc" }));
          const select = "title+read+date+type+reference+student";
          const url = `https://idukay.net/colegios/api/alerts?__page=1&__per_page=${n}&__sort=${sort}&select=${select}`;

          const resp = await fetch(url, { headers: headersIdukay(sesion) });
          if (resp.status === 401 || resp.status === 403) return errorSesion();
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const datos = await resp.json();
          const alertas = Array.isArray(datos?.response) ? datos.response : [];

          if (!alertas.length) {
            return { content: [{ type: "text", text: "No hay notificaciones." }] };
          }

          const texto = alertas
            .map(
              (a) =>
                `${a.read ? "  " : "🔴"} [${a._id}] ${a.title}${a.type ? ` — ${a.type}` : ""}${a.date ? ` (${a.date})` : ""}`,
            )
            .join("\n");

          return { content: [{ type: "text", text: texto }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );

    // --- 2) Detalle de una notificación puntual ---
    server.registerTool(
      "idukay_detalle_notificacion",
      {
        title: "Detalle de una notificación de Idukay",
        description:
          "Trae el detalle completo de una notificación de Idukay por su _id (el que devuelve 'idukay_notificaciones'). " +
          "OJO: este endpoint de Idukay (read_alert) también la marca como LEÍDA como efecto secundario -- no hay forma de traer el detalle sin marcarla.",
        inputSchema: {
          id: z.string().describe("El _id de la notificación"),
          clave: z.string().optional(),
        },
      },
      async ({ id, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();

        const sesion = cargarSesion();
        if (!sesion?.authorization) return errorSesion();

        try {
          const resp = await fetch("https://idukay.net/colegios/api/read_alert", {
            method: "PUT",
            headers: headersIdukay(sesion, { "content-type": "application/json;charset=UTF-8" }),
            body: JSON.stringify({ _id: id }),
          });
          if (resp.status === 401 || resp.status === 403) return errorSesion();
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const datos = await resp.json();
          return { content: [{ type: "text", text: JSON.stringify(datos, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );

    // --- 3) Descargar un adjunto ---
    server.registerTool(
      "idukay_descargar_adjunto",
      {
        title: "Descargar adjunto de Idukay",
        description:
          "Descarga un archivo adjunto (de una tarea, notificación, etc) de Idukay y lo guarda en el disco del host. " +
          "'rutaAdjunto' es la parte de la URL que va después de '/colegios/api/attachments/' " +
          "(ej: 'tasks/6abd476ae86bb5c181d9a6be/feriado-bancario.pptx', tal cual aparece en el link del adjunto dentro de una notificación).",
        inputSchema: {
          rutaAdjunto: z.string(),
          rutaDestino: z
            .string()
            .optional()
            .describe("Dónde guardarlo. Si no se manda, se guarda en modules/idukay_integration/descargas/ con el nombre original del archivo."),
          clave: z.string().optional(),
        },
      },
      async ({ rutaAdjunto, rutaDestino, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();

        const sesion = cargarSesion();
        if (!sesion?.authorization) return errorSesion();

        try {
          const url = `https://idukay.net/colegios/api/attachments/${rutaAdjunto}`;
          const resp = await fetch(url, { headers: headersIdukay(sesion) });
          if (resp.status === 401 || resp.status === 403) return errorSesion();
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const buffer = Buffer.from(await resp.arrayBuffer());
          const nombreOriginal = decodeURIComponent(rutaAdjunto.split("/").pop() || "adjunto");

          const destino = rutaDestino || path.join(__dirname, "descargas", nombreOriginal);
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          fs.writeFileSync(destino, buffer);

          return {
            content: [
              { type: "text", text: `Guardado en: ${destino} (${(buffer.length / 1024).toFixed(1)} KB)` },
            ],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  },
};
