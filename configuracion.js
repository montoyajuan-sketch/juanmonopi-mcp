// configuracion.js
//
// Configuracion persistente del servidor + panel web para editarla.
//
//  - cargarConfiguracion(): lee config.json (si no existe usa los valores por
//    defecto) y devuelve la configuracion ya validada. index.js la usa al
//    arrancar. Las variables de entorno (PORT, SESSION_MINUTOS, ...) siguen
//    teniendo prioridad sobre este archivo.
//  - iniciarPanelConfiguracion(): levanta la pagina de configuracion en
//    http://localhost:<puerto>/ y la abre sola en el navegador.
//
// SEGURIDAD del panel:
//  - Escucha SOLO en 127.0.0.1 y en un puerto distinto al del servidor MCP,
//    asi que el tunel de Cloudflare (que apunta al puerto del MCP) nunca lo
//    expone.
//  - Cada arranque genera un token aleatorio que va en el link que se imprime
//    y se abre. Sin el, el panel responde 401. El token pasa a una cookie
//    HttpOnly + SameSite=Strict.
//  - Rechaza peticiones cuyo Host no sea localhost/127.0.0.1 (anti DNS
//    rebinding) y exige una cabecera propia en la API (anti CSRF).
//  - Cambiar la contrasena exige la actual y limita los intentos.
//  - Solo usa el modulo http de Node: no depende de express.

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = process.cwd();

export const RUTA_CONFIG = path.join(RAIZ, "config.json");
const RUTA_USUARIOS = path.join(RAIZ, "usuarios.json");
const RUTA_APIKEY = path.join(RAIZ, "apikey.json");
const CARPETA_UI = path.join(__dirname, "configuracion-ui");
const CARPETA_MODULOS = path.join(__dirname, "modules");
const COOKIE = "mcp_cfg";

// ============================================================
// VALORES POR DEFECTO Y VALIDACION
// ============================================================

function porDefecto() {
  return {
    servidor: {
      puerto: 3000,
      sesionMinutos: 120,
      accessTokenMinutos: 60,
      refreshTokenDias: 30
    },
    tunel: {
      // rapido  = quick tunnel de Cloudflare (URL random, sin cuenta)
      // nombrado = tunel con nombre, URL fija (necesita token de Cloudflare)
      // ninguno  = sin tunel (solo local, o tu propio proxy/VPN)
      modo: "rapido",
      protocolo: "http2", // http2 | quic | auto
      urlPublica: "", // se usa en los modos nombrado y ninguno
      token: "", // solo modo nombrado
      actualizarCloudflared: true
    },
    modulos: {
      deshabilitados: []
    },
    panel: {
      puerto: 3100,
      abrirAlIniciar: true
    }
  };
}

function esObjeto(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function entero(valor, min, max, defecto, nombre, errores) {
  if (valor === undefined || valor === null || valor === "") return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    errores.push(`${nombre} debe ser un número entero entre ${min} y ${max}.`);
    return defecto;
  }
  return n;
}

function booleano(valor, defecto, nombre, errores) {
  if (valor === undefined) return defecto;
  if (typeof valor !== "boolean") {
    errores.push(`${nombre} debe ser verdadero o falso.`);
    return defecto;
  }
  return valor;
}

function opcion(valor, permitidas, defecto, nombre, errores) {
  if (valor === undefined) return defecto;
  if (!permitidas.includes(valor)) {
    errores.push(`${nombre} no es válido.`);
    return defecto;
  }
  return valor;
}

function urlPublica(valor, defecto, errores) {
  if (valor === undefined) return defecto;
  if (typeof valor !== "string") {
    errores.push("La dirección pública debe ser texto.");
    return defecto;
  }
  const texto = valor.trim();
  if (texto === "") return "";
  try {
    const u = new URL(texto);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocolo");
    return u.origin; // sin ruta: el servidor agrega /mcp por su cuenta
  } catch {
    errores.push("La dirección pública no es una URL válida (ejemplo: https://mcp.tudominio.com).");
    return defecto;
  }
}

function tokenTunel(t, defecto, errores) {
  if (t.borrarToken === true) return "";
  if (t.token === undefined || t.token === null || t.token === "") return defecto;
  if (typeof t.token !== "string") {
    errores.push("El token del túnel debe ser texto.");
    return defecto;
  }
  const texto = t.token.trim();
  if (!/^[A-Za-z0-9+/=_-]{20,4096}$/.test(texto)) {
    errores.push("El token del túnel no tiene un formato válido.");
    return defecto;
  }
  return texto;
}

function listaModulos(valor, defecto, errores) {
  if (valor === undefined) return defecto;
  if (!Array.isArray(valor) || valor.length > 200) {
    errores.push("La lista de módulos desactivados no es válida.");
    return defecto;
  }
  const limpia = [];
  for (const nombre of valor) {
    if (typeof nombre !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(nombre)) {
      errores.push("La lista de módulos desactivados contiene un nombre no válido.");
      return defecto;
    }
    if (!limpia.includes(nombre)) limpia.push(nombre);
  }
  return limpia;
}

// Toma "entrada" (parcial o completa) y rellena lo que falte con "base".
export function normalizarConfig(entrada, base = porDefecto()) {
  const errores = [];
  const e = esObjeto(entrada) ? entrada : {};
  const s = esObjeto(e.servidor) ? e.servidor : {};
  const t = esObjeto(e.tunel) ? e.tunel : {};
  const m = esObjeto(e.modulos) ? e.modulos : {};
  const p = esObjeto(e.panel) ? e.panel : {};

  const config = {
    servidor: {
      puerto: entero(s.puerto, 1, 65535, base.servidor.puerto, "El puerto del servidor", errores),
      sesionMinutos: entero(s.sesionMinutos, 5, 10080, base.servidor.sesionMinutos, "La duración de la sesión", errores),
      accessTokenMinutos: entero(s.accessTokenMinutos, 5, 1440, base.servidor.accessTokenMinutos, "La duración del token de acceso", errores),
      refreshTokenDias: entero(s.refreshTokenDias, 1, 365, base.servidor.refreshTokenDias, "La duración del token de refresco", errores)
    },
    tunel: {
      modo: opcion(t.modo, ["rapido", "nombrado", "ninguno"], base.tunel.modo, "El modo del túnel", errores),
      protocolo: opcion(t.protocolo, ["http2", "quic", "auto"], base.tunel.protocolo, "El protocolo del túnel", errores),
      urlPublica: urlPublica(t.urlPublica, base.tunel.urlPublica, errores),
      token: tokenTunel(t, base.tunel.token, errores),
      actualizarCloudflared: booleano(t.actualizarCloudflared, base.tunel.actualizarCloudflared, "La actualización de cloudflared", errores)
    },
    modulos: {
      deshabilitados: listaModulos(m.deshabilitados, base.modulos.deshabilitados, errores)
    },
    panel: {
      puerto: entero(p.puerto, 1024, 65535, base.panel.puerto, "El puerto del panel", errores),
      abrirAlIniciar: booleano(p.abrirAlIniciar, base.panel.abrirAlIniciar, "La apertura automática del panel", errores)
    }
  };

  return { config, errores };
}

function validarCruzada(config, errores) {
  if (config.tunel.modo === "nombrado") {
    if (!config.tunel.token) {
      errores.push("Para el túnel con nombre necesitas pegar el token de Cloudflare.");
    }
    if (!config.tunel.urlPublica) {
      errores.push("Para el túnel con nombre indica la dirección pública (por ejemplo https://mcp.tudominio.com).");
    }
  }
  if (config.servidor.puerto === config.panel.puerto) {
    errores.push("El puerto del servidor y el del panel no pueden ser el mismo.");
  }
}

// ============================================================
// LECTURA / ESCRITURA DE ARCHIVOS
// ============================================================

function leerJson(ruta, defecto) {
  try {
    return JSON.parse(fs.readFileSync(ruta, "utf8").replace(/^﻿/, ""));
  } catch {
    return defecto;
  }
}

function escribirJsonAtomico(ruta, valor) {
  const tmp = `${ruta}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valor, null, 2), "utf8");
  fs.renameSync(tmp, ruta);
}

export function cargarConfiguracion() {
  let crudo = null;
  try {
    crudo = JSON.parse(fs.readFileSync(RUTA_CONFIG, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[configuracion] config.json ilegible, se usan los valores por defecto:", err.message);
    }
  }
  const { config, errores } = normalizarConfig(crudo, porDefecto());
  if (errores.length) {
    console.warn(
      "[configuracion] Valores inválidos en config.json (se usan los por defecto en esos campos):\n - " +
        errores.join("\n - ")
    );
  }
  return config;
}

function guardarConfiguracion(parcial) {
  const actual = cargarConfiguracion();
  const { config, errores } = normalizarConfig(parcial, actual);
  validarCruzada(config, errores);
  if (errores.length) return { errores };
  escribirJsonAtomico(RUTA_CONFIG, config);
  return { config };
}

function configPublica(config) {
  const copia = JSON.parse(JSON.stringify(config));
  copia.tunel.tokenGuardado = Boolean(config.tunel.token);
  delete copia.tunel.token;
  return copia;
}

// Lo que obliga a reiniciar el servidor / el tunel para aplicarse.
function claveReinicio(c) {
  return JSON.stringify([c.servidor, [...c.modulos.deshabilitados].sort(), c.panel.puerto]);
}

function claveTunel(c) {
  return JSON.stringify(c.tunel);
}

// ============================================================
// MODULOS DISPONIBLES
// ============================================================

const DESCRIPCIONES = {
  abrir: "Abre archivos con su aplicación predeterminada o lanza programas.",
  buscar_archivos: "Busca archivos por nombre, extensión o contenido.",
  captura_pantalla: "Toma capturas de la pantalla completa o de una región.",
  control_remoto: "Controla el mouse, el teclado y las ventanas.",
  convertir: "Convierte archivos entre cientos de formatos.",
  discord: "Administra servidores de Discord (99 herramientas).",
  escanear: "Escanea documentos desde un escáner conectado.",
  imprimir: "Imprime PDFs e imágenes en la impresora de la PC.",
  info_sistema: "Muestra CPU, RAM, discos, batería y tiempo encendido.",
  listar_ventanas: "Lista las ventanas abiertas y la ventana activa.",
  notificacion: "Muestra notificaciones y barras de progreso en pantalla.",
  ocr: "Extrae texto de imágenes y PDFs escaneados (Tesseract).",
  portapapeles: "Lee y escribe el portapapeles de Windows.",
  procesos: "Lista procesos y cierra los que indiques.",
  red: "IPs locales, ping y prueba de puertos.",
  volumen: "Sube, baja o silencia el volumen."
};

function listarModulos(deshabilitados) {
  let carpetas = [];
  try {
    carpetas = fs.readdirSync(CARPETA_MODULOS, { withFileTypes: true });
  } catch {
    return [];
  }

  return carpetas
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(CARPETA_MODULOS, d.name, "module.js")))
    .map((d) => {
      let descripcion = DESCRIPCIONES[d.name] || "";
      if (!descripcion) {
        const info = leerJson(path.join(CARPETA_MODULOS, d.name, "module_info.json"), null);
        if (info && typeof info.descripcion === "string") {
          descripcion = info.descripcion.length > 160 ? info.descripcion.slice(0, 157) + "..." : info.descripcion;
        }
      }
      return { nombre: d.name, descripcion, activo: !deshabilitados.includes(d.name) };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// ============================================================
// CONTRASENA
// ============================================================

function hashPassword(password, salt) {
  // Mismos parametros que index.js (scryptSync con el salt como texto).
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verificarContrasena(contrasena, usuario) {
  try {
    const intento = Buffer.from(hashPassword(contrasena, usuario.salt), "hex");
    const guardado = Buffer.from(String(usuario.hash), "hex");
    return intento.length === guardado.length && crypto.timingSafeEqual(intento, guardado);
  } catch {
    return false;
  }
}

// ============================================================
// UTILIDADES DEL SERVIDOR HTTP
// ============================================================

class ErrorHttp extends Error {
  constructor(estado, mensaje, extra = {}) {
    super(mensaje);
    this.estado = estado;
    this.extra = extra;
  }
}

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

// Solo se sirven estos archivos (nada de rutas arbitrarias).
const ARCHIVOS_UI = new Set(["/estilos.css", "/app.js"]);

const PAGINA_SIN_ACCESO =
  '<!doctype html><html lang="es"><meta charset="utf-8">' +
  '<meta name="color-scheme" content="light dark"><title>Sin acceso</title>' +
  "<h1>Sin acceso</h1>" +
  "<p>Abre la configuración con el enlace que aparece en la ventana del servidor, " +
  "o reinicia el servidor para obtener uno nuevo.</p></html>";

function sha256(texto) {
  return crypto.createHash("sha256").update(texto).digest();
}

function abrirNavegador(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Si no se puede abrir, el link igual queda impreso en la consola.
  }
}

function relanzarServidor() {
  if (process.platform !== "win32") {
    throw new ErrorHttp(501, "Reiniciar desde el panel solo funciona en Windows.");
  }

  const exe = process.execPath;
  const script = process.argv[1] ? path.resolve(process.argv[1]) : path.join(RAIZ, "index.js");

  // Espera ~2 s a que este proceso suelte el puerto y abre otra consola con
  // el servidor nuevo (que abrira el panel solo, por CONFIG_ABRIR=1).
  const linea = `"ping -n 3 127.0.0.1 >nul & start "MCP Server" "${exe}" "${script}""`;

  spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", linea], {
    cwd: RAIZ,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
    env: { ...process.env, CONFIG_ABRIR: "1" }
  }).unref();

  setTimeout(() => process.exit(0), 400);
}

function escuchar(servidor, puertoInicial, puertoServidor) {
  return new Promise((resolve, reject) => {
    let puerto = puertoInicial;
    const maximo = puertoInicial + 20;

    const probar = () => {
      while (puerto === puertoServidor) puerto++;
      const alError = (err) => {
        if (err.code === "EADDRINUSE" && puerto < maximo) {
          puerto++;
          probar();
        } else {
          reject(err);
        }
      };
      servidor.once("error", alError);
      servidor.listen(puerto, "127.0.0.1", () => {
        servidor.removeListener("error", alError);
        resolve(puerto);
      });
    };

    probar();
  });
}

// ============================================================
// PANEL
// ============================================================

export async function iniciarPanelConfiguracion({ config, puertoServidor, hooks = {} }) {
  const inicio = Date.now();
  const token = crypto.randomBytes(24).toString("base64url");
  const hashToken = sha256(token);
  const snapReinicio = claveReinicio(config);
  let snapTunel = claveTunel(config);
  let puertoPanel = 0;

  // Limite de intentos para el cambio de contrasena.
  let fallos = 0;
  let bloqueadoHasta = 0;

  const tokenValido = (candidato) =>
    typeof candidato === "string" && crypto.timingSafeEqual(sha256(candidato), hashToken);

  const cookieValida = (req) => {
    const cabecera = req.headers.cookie || "";
    for (const parte of cabecera.split(";")) {
      const [nombre, ...resto] = parte.trim().split("=");
      if (nombre === COOKIE) return tokenValido(resto.join("="));
    }
    return false;
  };

  const hostPermitido = (req) => {
    const host = String(req.headers.host || "").toLowerCase();
    return host === `localhost:${puertoPanel}` || host === `127.0.0.1:${puertoPanel}`;
  };

  const enviar = (res, estado, tipo, cuerpo) => {
    res.writeHead(estado, { "Content-Type": tipo });
    res.end(cuerpo);
  };

  const enviarJson = (res, estado, objeto) =>
    enviar(res, estado, "application/json; charset=utf-8", JSON.stringify(objeto));

  const leerCuerpo = (req) =>
    new Promise((resolve, reject) => {
      const trozos = [];
      let tamano = 0;
      req.on("data", (c) => {
        tamano += c.length;
        if (tamano > 64 * 1024) {
          reject(new ErrorHttp(413, "La petición es demasiado grande."));
          req.destroy();
          return;
        }
        trozos.push(c);
      });
      req.on("end", () => {
        if (tamano === 0) return resolve({});
        if (!/^application\/json/i.test(req.headers["content-type"] || "")) {
          return reject(new ErrorHttp(415, "Se esperaba JSON."));
        }
        try {
          resolve(JSON.parse(Buffer.concat(trozos).toString("utf8")));
        } catch {
          reject(new ErrorHttp(400, "El JSON enviado no es válido."));
        }
      });
      req.on("error", reject);
    });

  const nombreUsuario = () => {
    const u = leerJson(RUTA_USUARIOS, null);
    return u && typeof u.usuario === "string" ? u.usuario : "";
  };

  // ----------------------------------------------------------
  // API
  // ----------------------------------------------------------

  const rutas = {
    "GET /api/estado": () => {
      const actual = cargarConfiguracion();
      const base = typeof hooks.estado === "function" ? hooks.estado() : {};
      return {
        ahora: Date.now(),
        inicio,
        nodeVersion: process.version,
        plataforma: `${os.type()} ${os.release()}`,
        carpeta: RAIZ,
        usuario: nombreUsuario(),
        puertoServidor,
        puertoPanel,
        ...base,
        reinicioPendiente: claveReinicio(actual) !== snapReinicio,
        tunelPendiente: claveTunel(actual) !== snapTunel
      };
    },

    "GET /api/config": () => {
      const actual = cargarConfiguracion();
      return {
        config: configPublica(actual),
        usuario: nombreUsuario(),
        modulos: listarModulos(actual.modulos.deshabilitados),
        reinicioPendiente: claveReinicio(actual) !== snapReinicio,
        tunelPendiente: claveTunel(actual) !== snapTunel
      };
    },

    "PUT /api/config": (req, body) => {
      const resultado = guardarConfiguracion(body);
      if (resultado.errores) throw new ErrorHttp(400, resultado.errores.join(" "), { errores: resultado.errores });
      const actual = resultado.config;
      return {
        config: configPublica(actual),
        modulos: listarModulos(actual.modulos.deshabilitados),
        reinicioPendiente: claveReinicio(actual) !== snapReinicio,
        tunelPendiente: claveTunel(actual) !== snapTunel
      };
    },

    "POST /api/tunel/reiniciar": async () => {
      if (typeof hooks.reiniciarTunel !== "function") {
        throw new ErrorHttp(501, "Este servidor no permite reiniciar el túnel desde el panel.");
      }
      await hooks.reiniciarTunel();
      snapTunel = claveTunel(cargarConfiguracion());
      return { ok: true };
    },

    "POST /api/cuenta": (req, body) => {
      const ahora = Date.now();
      if (bloqueadoHasta > ahora) {
        throw new ErrorHttp(429, `Demasiados intentos. Espera ${Math.ceil((bloqueadoHasta - ahora) / 1000)} segundos.`);
      }

      const { usuarioNuevo, contrasenaActual, contrasenaNueva, revocarConectores } = body || {};
      const actual = leerJson(RUTA_USUARIOS, null);
      if (!actual || !actual.salt || !actual.hash) {
        throw new ErrorHttp(409, "Todavía no hay un usuario configurado.");
      }

      if (typeof contrasenaActual !== "string" || !verificarContrasena(contrasenaActual, actual)) {
        fallos++;
        if (fallos >= 5) {
          bloqueadoHasta = ahora + 60_000;
          fallos = 0;
        }
        throw new ErrorHttp(403, "La contraseña actual no es correcta.");
      }
      fallos = 0;

      const errores = [];
      const nombre =
        typeof usuarioNuevo === "string" && usuarioNuevo.trim() ? usuarioNuevo.trim() : actual.usuario;
      if (nombre.length > 64 || /[\u0000-\u001f\u007f]/.test(nombre)) {
        errores.push("El nombre de usuario no es válido (máximo 64 caracteres, sin caracteres de control).");
      }

      const nueva = typeof contrasenaNueva === "string" && contrasenaNueva !== "" ? contrasenaNueva : null;
      if (nueva !== null) {
        if (nueva.length < 8) errores.push("La contraseña nueva debe tener al menos 8 caracteres.");
        if (nueva.length > 128) errores.push("La contraseña nueva no puede pasar de 128 caracteres.");
      }
      if (nueva === null && nombre === actual.usuario) {
        errores.push("No hay nada que cambiar: escribe un usuario o una contraseña nuevos.");
      }
      if (errores.length) throw new ErrorHttp(400, errores.join(" "), { errores });

      const salt = nueva !== null ? crypto.randomBytes(16).toString("hex") : actual.salt;
      const hash = nueva !== null ? hashPassword(nueva, salt) : actual.hash;
      escribirJsonAtomico(RUTA_USUARIOS, { ...actual, usuario: nombre, salt, hash });

      if (typeof hooks.recargarUsuario === "function") hooks.recargarUsuario();
      if (typeof hooks.cerrarSesiones === "function") {
        hooks.cerrarSesiones({ revocarOAuth: revocarConectores === true });
      }

      console.log("[Configuracion] Credenciales actualizadas desde el panel; sesiones cerradas.");
      return { ok: true, usuario: nombre, contrasenaCambiada: nueva !== null };
    },

    "POST /api/sesiones/cerrar": (req, body) => {
      if (typeof hooks.cerrarSesiones !== "function") {
        throw new ErrorHttp(501, "Este servidor no permite cerrar sesiones desde el panel.");
      }
      hooks.cerrarSesiones({ revocarOAuth: body && body.revocarConectores === true });
      return { ok: true };
    },

    "GET /api/apikey": () => {
      const datos = leerJson(RUTA_APIKEY, null);
      if (!datos || typeof datos.apiKey !== "string") {
        throw new ErrorHttp(404, "Todavía no se generó una API key.");
      }
      return { apiKey: datos.apiKey };
    },

    "POST /api/servidor/reiniciar": () => {
      if (process.platform !== "win32") {
        throw new ErrorHttp(501, "Reiniciar desde el panel solo funciona en Windows.");
      }
      // Se responde primero y recien despues se relanza.
      setTimeout(relanzarServidor, 250);
      return { ok: true };
    }
  };

  // ----------------------------------------------------------
  // Manejo de peticiones
  // ----------------------------------------------------------

  async function manejar(req, res) {
    if (!hostPermitido(req)) {
      return enviar(res, 403, "text/plain; charset=utf-8", "Host no permitido.");
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );

    const url = new URL(req.url || "/", "http://localhost");
    const metodo = req.method || "GET";

    // Entrada: valida el token del link y lo pasa a una cookie.
    if (url.pathname === "/" && (metodo === "GET" || metodo === "HEAD")) {
      if (tokenValido(url.searchParams.get("t"))) {
        res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
      if (!cookieValida(req)) return enviar(res, 401, "text/html; charset=utf-8", PAGINA_SIN_ACCESO);
      return enviar(res, 200, TIPOS[".html"], fs.readFileSync(path.join(CARPETA_UI, "index.html")));
    }

    if (!cookieValida(req)) {
      if (url.pathname.startsWith("/api/")) return enviarJson(res, 401, { error: "Sesión del panel no válida." });
      return enviar(res, 401, "text/plain; charset=utf-8", "Sin acceso.");
    }

    // API
    if (url.pathname.startsWith("/api/")) {
      if (req.headers["x-configuracion"] !== "1") {
        return enviarJson(res, 403, { error: "Falta la cabecera de seguridad." });
      }
      const manejador = rutas[`${metodo} ${url.pathname}`];
      if (!manejador) return enviarJson(res, 404, { error: "No encontrado." });
      try {
        const cuerpo = metodo === "GET" ? {} : await leerCuerpo(req);
        const resultado = await manejador(req, cuerpo);
        return enviarJson(res, 200, resultado);
      } catch (err) {
        if (err instanceof ErrorHttp) {
          return enviarJson(res, err.estado, { error: err.message, ...err.extra });
        }
        console.error("[configuracion]", err);
        return enviarJson(res, 500, { error: "Error interno: " + err.message });
      }
    }

    // Archivos de la interfaz
    if ((metodo === "GET" || metodo === "HEAD") && ARCHIVOS_UI.has(url.pathname)) {
      const archivo = path.join(CARPETA_UI, url.pathname);
      return enviar(res, 200, TIPOS[path.extname(archivo)], fs.readFileSync(archivo));
    }

    return enviar(res, 404, "text/plain; charset=utf-8", "No encontrado.");
  }

  const servidor = http.createServer((req, res) => {
    manejar(req, res).catch((err) => {
      console.error("[configuracion]", err);
      if (!res.headersSent) enviarJson(res, 500, { error: "Error interno." });
      else res.end();
    });
  });

  puertoPanel = await escuchar(servidor, config.panel.puerto, puertoServidor);

  const url = `http://localhost:${puertoPanel}/?t=${token}`;
  console.log("\n==================================================");
  console.log(" Configuración (solo accesible desde esta PC):");
  console.log(" " + url);
  console.log("==================================================\n");

  const forzar = process.env.CONFIG_ABRIR;
  const abrir = forzar === "1" ? true : forzar === "0" ? false : config.panel.abrirAlIniciar;
  if (abrir) abrirNavegador(url);

  return { puerto: puertoPanel, url, cerrar: () => servidor.close() };
}
