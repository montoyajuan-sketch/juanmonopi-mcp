// modules/notificacion/module.js
// Notificaciones con botones y notificaciones de progreso (barra que se
// puede actualizar en vivo), apiladas en una sola ventana tipo toast de
// Chrome, anclada abajo a la derecha de la pantalla. Cada notificacion
// tiene un id propio.

import { z } from "zod";
import path from "path";
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "notificacion.html");

// Ventana overlay Electron (transparente, sin bordes, click-through), vive
// en una subcarpeta aparte con su propio node_modules (tiene 'electron' de
// dependencia, que es pesado y no queremos mezclar con el resto del server).
const RUTA_ELECTRON = path.join(__dirname, "electron-overlay", "node_modules", "electron", "dist", "electron.exe");
const RUTA_MAIN_ELECTRON = path.join(__dirname, "electron-overlay", "main.js");

const MS_ANTES_DE_PURGAR = 8000; // cuanto se deja ver una notif ya terminada antes de borrarla del estado

let PUERTO = null;
let ventanaAbierta = false;
let procesoElectron = null;

const notifs = new Map(); // id -> estado de la notificacion
const pendientesSimples = new Map(); // id -> { resolve, timeoutHandle }

function abrirVentanaSiHaceFalta() {
  if (ventanaAbierta) return;

  if (!fs.existsSync(RUTA_ELECTRON)) {
    console.error("[notificacion] No se encontro electron.exe en modules/notificacion/electron-overlay/node_modules. Corre 'npm install' ahi adentro.");
    return;
  }

  ventanaAbierta = true;
  procesoElectron = spawn(RUTA_ELECTRON, [RUTA_MAIN_ELECTRON, `--puerto=${PUERTO}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  procesoElectron.unref();
  procesoElectron.on("exit", () => {
    procesoElectron = null;
    ventanaAbierta = false; // si el proceso muere, la proxima notificacion lo vuelve a levantar
  });
}

function idAleatorio() {
  return crypto.randomBytes(6).toString("hex");
}

function purgarLuego(id) {
  setTimeout(() => {
    notifs.delete(id);
    // la ventana Electron queda corriendo (escondida via IPC); no hace falta reabrirla.
  }, MS_ANTES_DE_PURGAR);
}

// ---- API interna que usan las tools MCP / REST ----

function crearSimple({ mensaje, botones, timeoutMs }) {
  const id = idAleatorio();
  const listaBotones = botones && botones.length > 0 ? botones : ["OK"];
  notifs.set(id, {
    id, tipo: "simple", mensaje, botones: listaBotones, estado: "activa", creadoEn: Date.now(),
  });
  abrirVentanaSiHaceFalta();

  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendientesSimples.delete(id);
      const n = notifs.get(id);
      if (n) { n.estado = "completada"; purgarLuego(id); }
      resolve(null);
    }, timeoutMs || 120000);
    pendientesSimples.set(id, { resolve, timeoutHandle });
  });
}

function crearProgreso({ id, mensaje, progreso, cancelable }) {
  const idFinal = id || idAleatorio();
  notifs.set(idFinal, {
    id: idFinal,
    tipo: "progreso",
    mensaje,
    progreso: typeof progreso === "number" ? progreso : null,
    velocidad: null,
    eta: null,
    cancelable: !!cancelable,
    estado: "activa",
    creadoEn: Date.now(),
  });
  abrirVentanaSiHaceFalta();
  return idFinal;
}

function actualizarProgreso({ id, mensaje, progreso, velocidad, eta }) {
  const n = notifs.get(id);
  if (!n) return false;
  if (mensaje !== undefined) n.mensaje = mensaje;
  if (progreso !== undefined) n.progreso = progreso;
  if (velocidad !== undefined) n.velocidad = velocidad;
  if (eta !== undefined) n.eta = eta;
  return true;
}

function finalizar({ id, estado, mensaje }) {
  const n = notifs.get(id);
  if (!n) return false;
  n.estado = estado || "completada";
  if (mensaje !== undefined) n.mensaje = mensaje;
  purgarLuego(id);
  return true;
}

function responderAccion({ id, accion, valor }) {
  const n = notifs.get(id);
  if (accion === "boton") {
    const pend = pendientesSimples.get(id);
    if (pend) {
      clearTimeout(pend.timeoutHandle);
      pend.resolve(valor ?? null);
      pendientesSimples.delete(id);
    }
    if (n) { n.estado = "completada"; purgarLuego(id); }
  } else if (accion === "cancelar") {
    if (n) { n.estado = "cancelada"; purgarLuego(id); }
  } else if (accion === "cerrar") {
    if (n) {
      n.estado = n.estado === "activa" ? "cancelada" : n.estado;
      purgarLuego(id);
    }
  }
}

// ---- servidor HTTP ----

function servidorHttp(req, res) {
  const url = new URL(req.url, `http://localhost:${PUERTO}`);

  if (req.method === "GET" && url.pathname === "/pagina") {
    const html = fs.readFileSync(HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/estado") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.from(notifs.values())));
    return;
  }

  if (req.method === "POST" && url.pathname === "/accion") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const datos = JSON.parse(body || "{}");
        responderAccion(datos);
      } catch { /* ignorado */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

export default {
  nombre: "notificacion",
  info: { nombre: "notificacion" },

  async iniciar(puerto) {
    PUERTO = puerto;
    http.createServer(servidorHttp).listen(PUERTO, "127.0.0.1");
  },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "notificar",
      {
        title: "Mostrar notificacion con botones",
        description: "Muestra un toast anclado abajo a la derecha con un mensaje y uno o mas botones de seleccion, y espera hasta un limite de tiempo a que el usuario elija uno. Devuelve el texto del boton elegido, o null si se cerro sin responder o se agoto el tiempo.",
        inputSchema: {
          mensaje: z.string(),
          botones: z.array(z.string()).optional().describe("Textos de los botones a mostrar. Si se omite, se muestra un solo boton 'OK'."),
          timeoutMs: z.number().optional().describe("Milisegundos a esperar respuesta antes de darse por vencido (default 120000 = 2 min)"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const boton = await crearSimple(args);
        return {
          content: [{
            type: "text",
            text: boton == null
              ? "El usuario no respondio a tiempo o cerro la notificacion sin elegir un boton."
              : `El usuario eligio: ${boton}`,
          }],
        };
      }
    );

    server.registerTool(
      "notificar_progreso_crear",
      {
        title: "Crear notificacion de progreso",
        description: "Crea una notificacion tipo toast con una barra de progreso, apilada junto a las demas notificaciones. No espera respuesta: devuelve enseguida el id de la notificacion, que despues se usa con notificar_progreso_actualizar para ir cambiando el mensaje y el porcentaje, y con notificar_finalizar para cerrarla.",
        inputSchema: {
          id: z.string().optional().describe("Id propio para la notificacion. Si se omite, se genera uno automaticamente."),
          mensaje: z.string(),
          progreso: z.number().min(0).max(100).optional().describe("Porcentaje inicial (0-100). Si se omite, se muestra como indeterminado (barra animada sin numero)."),
          cancelable: z.boolean().optional().describe("Si es true, muestra un boton 'Cancelar' mientras la notificacion esta activa."),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const id = crearProgreso(args);
        return { content: [{ type: "text", text: `Notificacion de progreso creada. id: ${id}` }] };
      }
    );

    server.registerTool(
      "notificar_progreso_actualizar",
      {
        title: "Actualizar notificacion de progreso",
        description: "Actualiza el mensaje, el porcentaje de progreso, la velocidad y/o el tiempo estimado de una notificacion ya creada con notificar_progreso_crear. Se puede llamar varias veces seguidas para ir avanzando la barra.",
        inputSchema: {
          id: z.string().describe("Id devuelto por notificar_progreso_crear"),
          mensaje: z.string().optional().describe("Si se manda, reemplaza el texto del titulo."),
          progreso: z.number().min(0).max(100).optional().describe("Nuevo porcentaje (0-100)."),
          velocidad: z.string().optional().describe("Texto libre, ej: '1.2 MB/s'"),
          eta: z.string().optional().describe("Texto libre, ej: 'restan 10 s'"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const ok = actualizarProgreso(args);
        return {
          content: [{
            type: "text",
            text: ok ? "Notificacion actualizada." : `No existe ninguna notificacion activa con id ${args.id}`,
          }],
        };
      }
    );

    server.registerTool(
      "notificar_finalizar",
      {
        title: "Finalizar notificacion",
        description: "Marca una notificacion (simple o de progreso) como completada, fallida o cancelada. Se queda visible unos segundos mas con el icono final y despues se cierra sola.",
        inputSchema: {
          id: z.string(),
          estado: z.enum(["completada", "fallida", "cancelada"]).optional().describe("Default: completada"),
          mensaje: z.string().optional().describe("Mensaje final, por si se quiere cambiar el texto al terminar."),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const ok = finalizar(args);
        return {
          content: [{
            type: "text",
            text: ok ? "Notificacion finalizada." : `No existe ninguna notificacion activa con id ${args.id}`,
          }],
        };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/notificar", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key invalida o faltante (header x-api-key)" });
      }
      try {
        const boton = await crearSimple(req.body || {});
        res.json({ boton });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post("/notificar/progreso", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key invalida o faltante (header x-api-key)" });
      }
      const id = crearProgreso(req.body || {});
      res.json({ id });
    });

    router.patch("/notificar/progreso/:id", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key invalida o faltante (header x-api-key)" });
      }
      const ok = actualizarProgreso({ ...req.body, id: req.params.id });
      res.json({ ok });
    });

    router.post("/notificar/:id/finalizar", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key invalida o faltante (header x-api-key)" });
      }
      const ok = finalizar({ ...req.body, id: req.params.id });
      res.json({ ok });
    });
  },
};
