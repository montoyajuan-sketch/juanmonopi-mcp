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
//  - Primera vez (sin usuarios.json): sirve setup.html, un asistente que crea el
//    usuario, el tunel y el token de Discord; index.js espera a que termine.
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
    },
    tema: {
      acento: "" // "" = predeterminado; si no, #rrggbb
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

function colorAcento(valor, defecto, errores) {
  if (valor === undefined) return defecto;
  if (valor === null || valor === "") return "";
  if (typeof valor !== "string" || !REGEX_ACENTO.test(valor.trim())) {
    errores.push("El color de acento debe tener el formato #RRGGBB (por ejemplo #0078d4).");
    return defecto;
  }
  return valor.trim().toLowerCase();
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

// ============================================================
// TEMA (color de acento)
// ============================================================

const REGEX_ACENTO = /^#[0-9a-f]{6}$/i;

function hexARgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbAHex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function luminancia(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mezclar(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function contraste(l1, l2) {
  const [x, y] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (x + 0.05) / (y + 0.05);
}

// Modo claro: oscurece un color demasiado claro. Modo oscuro: aclara uno demasiado oscuro.
function ajustarAcento(rgb, modo) {
  let c = rgb;
  for (let i = 0; i < 40; i++) {
    const l = luminancia(c);
    if (modo === "claro" ? l <= 0.3 : l >= 0.25) break;
    c = mezclar(c, modo === "claro" ? [0, 0, 0] : [255, 255, 255], 0.08);
  }
  return c;
}

function textoSobre(rgb) {
  const l = luminancia(rgb);
  return contraste(l, 1) >= contraste(l, 0) ? "#ffffff" : "#000000";
}

// CSS que sobrescribe el color de acento (claro y oscuro). Devuelve "" si el color
// es el predeterminado o no es un #rrggbb valido, asi que es seguro incrustarlo en HTML.
export function cssTema(acento) {
  if (typeof acento !== "string" || !REGEX_ACENTO.test(acento)) return "";
  const base = hexARgb(acento);
  const bloque = (rgb, fondo, mezcla) =>
    `    --acento: ${rgbAHex(rgb)};\n` +
    `    --acento-texto: ${textoSobre(rgb)};\n` +
    `    --info-fondo: ${rgbAHex(mezclar(fondo, rgb, mezcla))};\n`;
  return (
    ":root {\n" + bloque(ajustarAcento(base, "claro"), [255, 255, 255], 0.1) + "  }\n" +
    "@media (prefers-color-scheme: dark) {\n  :root {\n" +
    bloque(ajustarAcento(base, "oscuro"), [43, 43, 43], 0.2) + "  }\n}\n"
  );
}

// Toma "entrada" (parcial o completa) y rellena lo que falte con "base".
export function normalizarConfig(entrada, base = porDefecto()) {
  const errores = [];
  const e = esObjeto(entrada) ? entrada : {};
  const s = esObjeto(e.servidor) ? e.servidor : {};
  const t = esObjeto(e.tunel) ? e.tunel : {};
  const m = esObjeto(e.modulos) ? e.modulos : {};
  const p = esObjeto(e.panel) ? e.panel : {};
  const te = esObjeto(e.tema) ? e.tema : {};

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
    },
    tema: {
      acento: colorAcento(te.acento, base.tema.acento, errores)
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
// USUARIO (configuracion inicial)
// ============================================================

function usuarioExiste() {
  const u = leerJson(RUTA_USUARIOS, null);
  return Boolean(u && typeof u.usuario === "string" && u.usuario && u.salt && u.hash);
}

function errorNombre(nombre) {
  if (typeof nombre !== "string" || !nombre.trim()) return "Escribe un nombre de usuario.";
  if (nombre.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(nombre)) {
    return "El nombre de usuario no es válido (máximo 64 caracteres, sin caracteres de control).";
  }
  return "";
}

function errorContrasena(clave) {
  if (typeof clave !== "string" || clave.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (clave.length > 128) return "La contraseña no puede pasar de 128 caracteres.";
  return "";
}

// ============================================================
// AJUSTES DE MODULOS
//
// Cada modulo puede declarar sus ajustes en modules/<nombre>/configuracion.json.
// El panel dibuja el formulario, valida en el servidor y guarda los valores en
// modules/<nombre>/.env. Al arrancar, index.js carga ese .env en process.env
// (solo las claves declaradas, sin pisar variables que ya existan).
// ============================================================

const TIPOS_CAMPO = ["texto", "secreto", "numero", "booleano", "opcion"];
const LONGITUD_MAX_DEFECTO = 500;
const LONGITUD_MAX_TOPE = 4096;

// Variables que un modulo nunca puede declarar como ajuste.
const CLAVES_RESERVADAS = new Set([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED", "PORT", "SESSION_MINUTOS", "ACCESS_TOKEN_MINUTOS",
  "REFRESH_TOKEN_DIAS", "OAUTH_CODE_MINUTOS", "URL_PUBLICA_BASE", "URL_PUBLICA", "OAUTH_ISSUER",
  "CONFIG_ABRIR", "TUNNEL_TOKEN", "TUNNEL_TRANSPORT_PROTOCOL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"
]);

function nombreModuloValido(nombre) {
  return typeof nombre === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(nombre);
}

function rutaEnvModulo(nombre) {
  return path.join(CARPETA_MODULOS, nombre, ".env");
}

const avisosEmitidos = new Set();
function avisarUnaVez(clave, texto) {
  if (avisosEmitidos.has(clave)) return;
  avisosEmitidos.add(clave);
  console.warn(texto);
}

function textoCorto(valor, max, nombre, errores, obligatorio = false) {
  if (valor === undefined || valor === null || valor === "") {
    if (obligatorio) errores.push(`${nombre} es obligatorio.`);
    return "";
  }
  if (typeof valor !== "string" || valor.length > max || /[\u0000-\u001f\u007f]/.test(valor)) {
    errores.push(`${nombre} debe ser texto de hasta ${max} caracteres.`);
    return "";
  }
  return valor.trim();
}

function normalizarCampo(c, i, errores, vistas) {
  const donde = `campos[${i}]`;
  if (!esObjeto(c)) {
    errores.push(`${donde} debe ser un objeto.`);
    return null;
  }
  const n = errores.length;

  const clave = typeof c.clave === "string" ? c.clave : "";
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(clave)) {
    errores.push(`${donde}.clave debe ser MAYUSCULAS, números y guiones bajos (ejemplo: MIMODULO_API_KEY).`);
  } else if (CLAVES_RESERVADAS.has(clave)) {
    errores.push(`${donde}.clave "${clave}" está reservada.`);
  } else if (vistas.has(clave)) {
    errores.push(`${donde}.clave "${clave}" está repetida.`);
  }
  vistas.add(clave);

  const tipo = c.tipo === undefined ? "texto" : c.tipo;
  if (!TIPOS_CAMPO.includes(tipo)) {
    errores.push(`${donde}.tipo debe ser uno de: ${TIPOS_CAMPO.join(", ")}.`);
  }

  const campo = {
    clave,
    etiqueta: textoCorto(c.etiqueta, 80, `${donde}.etiqueta`, errores, true),
    tipo,
    ayuda: textoCorto(c.ayuda, 300, `${donde}.ayuda`, errores),
    placeholder: textoCorto(c.placeholder, 100, `${donde}.placeholder`, errores),
    obligatorio: c.obligatorio === true
  };
  if (c.obligatorio !== undefined && typeof c.obligatorio !== "boolean") {
    errores.push(`${donde}.obligatorio debe ser verdadero o falso.`);
  }

  if (tipo === "texto" || tipo === "secreto") {
    const max = c.longitudMax === undefined ? LONGITUD_MAX_DEFECTO : c.longitudMax;
    if (!Number.isInteger(max) || max < 1 || max > LONGITUD_MAX_TOPE) {
      errores.push(`${donde}.longitudMax debe ser un entero entre 1 y ${LONGITUD_MAX_TOPE}.`);
    } else {
      campo.longitudMax = max;
    }
    if (c.patron !== undefined) {
      if (typeof c.patron !== "string" || c.patron.length > 300) {
        errores.push(`${donde}.patron debe ser una expresión regular de hasta 300 caracteres.`);
      } else {
        try {
          new RegExp(c.patron);
          campo.patron = c.patron;
        } catch {
          errores.push(`${donde}.patron no es una expresión regular válida.`);
        }
      }
    }
    campo.mensajePatron = textoCorto(c.mensajePatron, 200, `${donde}.mensajePatron`, errores);
    if (c.quitarEspacios === true) campo.quitarEspacios = true;
    if (c.predeterminado !== undefined) {
      if (tipo === "secreto") errores.push(`${donde}: un secreto no puede tener valor predeterminado.`);
      else if (typeof c.predeterminado !== "string") errores.push(`${donde}.predeterminado debe ser texto.`);
      else campo.predeterminado = c.predeterminado;
    }
  }

  if (tipo === "numero") {
    for (const lim of ["min", "max"]) {
      if (c[lim] === undefined) continue;
      if (typeof c[lim] !== "number" || !Number.isFinite(c[lim])) errores.push(`${donde}.${lim} debe ser un número.`);
      else campo[lim] = c[lim];
    }
    if (c.predeterminado !== undefined) {
      if (typeof c.predeterminado !== "number" || !Number.isFinite(c.predeterminado)) errores.push(`${donde}.predeterminado debe ser un número.`);
      else campo.predeterminado = c.predeterminado;
    }
  }

  if (tipo === "booleano" && c.predeterminado !== undefined) {
    if (typeof c.predeterminado !== "boolean") errores.push(`${donde}.predeterminado debe ser verdadero o falso.`);
    else campo.predeterminado = c.predeterminado;
  }

  if (tipo === "opcion") {
    const lista = Array.isArray(c.opciones) ? c.opciones : [];
    if (lista.length < 1 || lista.length > 50) {
      errores.push(`${donde}.opciones debe tener entre 1 y 50 elementos.`);
    } else {
      const opciones = [];
      for (const o of lista) {
        const valor = typeof o === "string" ? o : esObjeto(o) ? o.valor : undefined;
        const etiqueta = typeof o === "string" ? o : esObjeto(o) && o.etiqueta !== undefined ? o.etiqueta : valor;
        if (
          typeof valor !== "string" || valor === "" || valor.length > 100 || /[\u0000-\u001f\u007f]/.test(valor) ||
          typeof etiqueta !== "string" || etiqueta.length > 100
        ) {
          errores.push(`${donde}.opciones contiene una opción no válida.`);
          break;
        }
        if (opciones.some((x) => x.valor === valor)) {
          errores.push(`${donde}.opciones repite el valor "${valor}".`);
          break;
        }
        opciones.push({ valor, etiqueta });
      }
      campo.opciones = opciones;
    }
    if (c.predeterminado !== undefined) {
      if (typeof c.predeterminado !== "string" || !(campo.opciones || []).some((x) => x.valor === c.predeterminado)) {
        errores.push(`${donde}.predeterminado debe ser uno de los valores de "opciones".`);
      } else {
        campo.predeterminado = c.predeterminado;
      }
    }
  }

  return errores.length === n ? campo : null;
}

function normalizarEsquema(crudo, nombre, errores) {
  if (!esObjeto(crudo)) {
    errores.push("El archivo debe contener un objeto JSON.");
    return null;
  }
  const titulo = textoCorto(crudo.titulo, 60, "titulo", errores) || nombre;
  const descripcion = textoCorto(crudo.descripcion, 300, "descripcion", errores);

  if (!Array.isArray(crudo.campos) || crudo.campos.length < 1 || crudo.campos.length > 50) {
    errores.push('"campos" debe ser una lista de 1 a 50 campos.');
    return null;
  }
  const vistas = new Set();
  const campos = [];
  crudo.campos.forEach((c, i) => {
    const campo = normalizarCampo(c, i, errores, vistas);
    if (campo) campos.push(campo);
  });
  return errores.length ? null : { titulo, descripcion, campos };
}

// Lee y valida modules/<nombre>/configuracion.json. null si no existe o no es valido.
export function leerEsquemaModulo(nombre) {
  if (!nombreModuloValido(nombre)) return null;
  const ruta = path.join(CARPETA_MODULOS, nombre, "configuracion.json");
  let crudo;
  try {
    crudo = JSON.parse(fs.readFileSync(ruta, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    if (err.code !== "ENOENT") {
      avisarUnaVez(`${nombre}:json`, `[configuracion] modules/${nombre}/configuracion.json no se pudo leer: ${err.message}`);
    }
    return null;
  }
  const errores = [];
  const esquema = normalizarEsquema(crudo, nombre, errores);
  if (!esquema) {
    avisarUnaVez(
      `${nombre}:${errores.join("|")}`,
      `[configuracion] modules/${nombre}/configuracion.json no es válido y se ignora:\n - ${errores.join("\n - ")}`
    );
    return null;
  }
  return esquema;
}

function parsearEnv(texto) {
  const valores = {};
  for (const linea of texto.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linea);
    if (m) valores[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return valores;
}

function leerEnvModulo(nombre) {
  try {
    return parsearEnv(fs.readFileSync(rutaEnvModulo(nombre), "utf8"));
  } catch {
    return {};
  }
}

// index.js la llama antes de importar cada modulo: pasa a process.env las claves
// declaradas en su configuracion.json (sin pisar las que ya existan).
export function cargarEnvModulo(nombre) {
  const esquema = leerEsquemaModulo(nombre);
  if (!esquema) return;
  const env = leerEnvModulo(nombre);
  for (const c of esquema.campos) {
    if (env[c.clave] !== undefined && process.env[c.clave] === undefined) {
      process.env[c.clave] = env[c.clave];
    }
  }
}

// Como se escribe un valor en el .env para que dotenv lo lea igual. null = no se puede.
function formatearValorEnv(valor) {
  if (valor === "") return "";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(valor)) return valor;
  if (!valor.includes("'")) return `'${valor}'`;
  if (!valor.includes('"') && !/\\[nrt]/.test(valor)) return `"${valor}"`;
  return null;
}

// Cambia solo las claves indicadas; valor "" borra la linea. Respeta el resto del archivo.
function escribirEnvModulo(nombre, cambios) {
  const ruta = rutaEnvModulo(nombre);
  let lineas = [];
  try {
    lineas = fs.readFileSync(ruta, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    /* archivo nuevo */
  }
  if (lineas.length && lineas[lineas.length - 1] === "") lineas.pop();

  for (const [clave, valor] of Object.entries(cambios)) {
    const re = new RegExp(`^\\s*${clave}\\s*=`);
    const i = lineas.findIndex((l) => re.test(l));
    if (valor === "") {
      if (i >= 0) lineas.splice(i, 1);
      continue;
    }
    const escrito = formatearValorEnv(valor);
    if (escrito === null) throw new Error(`Valor no admitido para ${clave}.`);
    if (i >= 0) lineas[i] = `${clave}=${escrito}`;
    else lineas.push(`${clave}=${escrito}`);
  }

  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, lineas.join("\n") + (lineas.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, ruta);
}

// Valida lo que envia el panel. entrada = { valores: {CLAVE: valor}, borrar: [CLAVE] }.
// estricto = true (asistente de primera vez): los campos obligatorios deben quedar con valor.
// Si no, solo se impide vaciar un obligatorio que ya tenia valor.
function validarAjustes(esquema, entrada, envActual, { estricto = false } = {}) {
  const errores = [];
  const cambios = {};
  const e = esObjeto(entrada) ? entrada : {};
  const valores = esObjeto(e.valores) ? e.valores : {};
  const borrar = Array.isArray(e.borrar) ? e.borrar : [];
  const porClave = new Map(esquema.campos.map((c) => [c.clave, c]));

  for (const k of Object.keys(valores)) {
    if (!porClave.has(k)) errores.push(`El ajuste ${k} no existe.`);
  }
  for (const k of borrar) {
    if (!porClave.has(k)) errores.push(`El ajuste ${k} no existe.`);
    else cambios[k] = "";
  }

  for (const c of esquema.campos) {
    if (!Object.prototype.hasOwnProperty.call(valores, c.clave) || borrar.includes(c.clave)) continue;
    let v = valores[c.clave];
    const et = c.etiqueta;

    if (c.tipo === "texto" || c.tipo === "secreto") {
      if (typeof v !== "string") {
        errores.push(`${et} debe ser texto.`);
        continue;
      }
      v = c.quitarEspacios ? v.replace(/\s+/g, "") : v.trim();
      if (v === "") {
        if (c.tipo === "texto") cambios[c.clave] = ""; // un secreto vacio = conservar
        continue;
      }
      if (v.length > c.longitudMax) {
        errores.push(`${et} no puede pasar de ${c.longitudMax} caracteres.`);
        continue;
      }
      if (/[\u0000-\u001f\u007f]/.test(v)) {
        errores.push(`${et} contiene caracteres no permitidos.`);
        continue;
      }
      if (c.patron && !new RegExp(c.patron).test(v)) {
        errores.push(c.mensajePatron || `${et} no tiene un formato válido.`);
        continue;
      }
      if (formatearValorEnv(v) === null) {
        errores.push(`${et} no admite ese valor (mezcla comillas simples y dobles).`);
        continue;
      }
      cambios[c.clave] = v;
    } else if (c.tipo === "numero") {
      const t = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : null;
      if (t === null) {
        errores.push(`${et} debe ser un número.`);
        continue;
      }
      if (t === "") {
        cambios[c.clave] = "";
        continue;
      }
      if (!/^-?\d+(\.\d+)?$/.test(t)) {
        errores.push(`${et} debe ser un número.`);
        continue;
      }
      const n = Number(t);
      if ((c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) {
        const rango = c.min !== undefined && c.max !== undefined ? `entre ${c.min} y ${c.max}` : c.min !== undefined ? `al menos ${c.min}` : `como máximo ${c.max}`;
        errores.push(`${et} debe estar ${rango}.`);
        continue;
      }
      cambios[c.clave] = String(n);
    } else if (c.tipo === "booleano") {
      if (typeof v !== "boolean") {
        errores.push(`${et} debe ser verdadero o falso.`);
        continue;
      }
      cambios[c.clave] = v ? "true" : "false";
    } else if (c.tipo === "opcion") {
      if (v === "" || v === null) {
        cambios[c.clave] = "";
        continue;
      }
      if (typeof v !== "string" || !c.opciones.some((o) => o.valor === v)) {
        errores.push(`${et}: la opción elegida no es válida.`);
        continue;
      }
      cambios[c.clave] = v;
    }
  }

  for (const c of esquema.campos) {
    if (!c.obligatorio || c.tipo === "booleano" || borrar.includes(c.clave)) continue;
    const actual = envActual[c.clave] || "";
    const final = Object.prototype.hasOwnProperty.call(cambios, c.clave) ? cambios[c.clave] : actual;
    if (final !== "") continue;
    if (c.predeterminado !== undefined) continue;
    if (estricto || actual !== "") errores.push(`${c.etiqueta} es obligatorio.`);
  }

  return { errores, cambios };
}

// Campos tal como los ve el navegador: los secretos nunca viajan, solo si hay uno guardado.
function camposPublicos(esquema, env) {
  return esquema.campos.map((c) => {
    const { patron, mensajePatron, quitarEspacios, ...visible } = c;
    const crudo = env[c.clave];
    if (c.tipo === "secreto") return { ...visible, guardado: Boolean(crudo) };
    if (c.tipo === "booleano") {
      return { ...visible, valor: crudo === undefined || crudo === "" ? c.predeterminado === true : crudo === "true" };
    }
    return { ...visible, valor: crudo === undefined ? "" : crudo };
  });
}

function infoAjustes(deshabilitados) {
  const resultado = [];
  for (const m of listarModulos(deshabilitados)) {
    const esquema = leerEsquemaModulo(m.nombre);
    if (!esquema) continue;
    resultado.push({
      nombre: m.nombre,
      titulo: esquema.titulo,
      descripcion: esquema.descripcion,
      activo: m.activo,
      campos: camposPublicos(esquema, leerEnvModulo(m.nombre))
    });
  }
  return resultado;
}

// Lo que el asistente de primera vez necesita saber de Discord.
function infoDiscordSetup(deshabilitados) {
  const env = leerEnvModulo("discord");
  return {
    disponible:
      fs.existsSync(path.join(CARPETA_MODULOS, "discord", "module.js")) && leerEsquemaModulo("discord") !== null,
    activo: !deshabilitados.includes("discord"),
    tokenGuardado: Boolean(env.DISCORD_TOKEN),
    guilds: env.DISCORD_ALLOWED_GUILDS || "",
    logChannel: env.DISCORD_LOG_CHANNEL_ID || ""
  };
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
const ARCHIVOS_UI = new Set(["/estilos.css", "/app.js", "/setup.js"]);

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
  let snapReinicio = claveReinicio(config);
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

    "GET /api/setup/estado": () => {
      const actual = cargarConfiguracion();
      return {
        pendiente: !usuarioExiste(),
        discord: infoDiscordSetup(actual.modulos.deshabilitados),
        tunel: { modo: actual.tunel.modo, urlPublica: actual.tunel.urlPublica }
      };
    },

    "POST /api/setup": (req, body) => {
      if (usuarioExiste()) {
        throw new ErrorHttp(409, "La configuración inicial ya se completó.");
      }
      const b = esObjeto(body) ? body : {};
      const errores = [];

      const eNombre = errorNombre(b.usuario);
      if (eNombre) errores.push(eNombre);
      const eClave = errorContrasena(b.contrasena);
      if (eClave) errores.push(eClave);

      const actual = cargarConfiguracion();
      const t = esObjeto(b.tunel) ? b.tunel : {};
      const parcial = { tunel: { modo: t.modo, urlPublica: t.urlPublica } };
      if (typeof t.token === "string" && t.token.trim()) parcial.tunel.token = t.token;

      // Discord (solo si el modulo existe): usa el mismo esquema que el panel
      let cambiosEnv = {};
      let deshabilitados = [...actual.modulos.deshabilitados];
      if (infoDiscordSetup(deshabilitados).disponible && esObjeto(b.discord)) {
        if (b.discord.activar === true) {
          const valores = {
            DISCORD_ALLOWED_GUILDS: b.discord.guilds === undefined ? "" : b.discord.guilds,
            DISCORD_LOG_CHANNEL_ID: b.discord.logChannel === undefined ? "" : b.discord.logChannel
          };
          if (b.discord.token) valores.DISCORD_TOKEN = b.discord.token;
          const r = validarAjustes(leerEsquemaModulo("discord"), { valores }, leerEnvModulo("discord"), { estricto: true });
          errores.push(...r.errores);
          cambiosEnv = r.cambios;
          deshabilitados = deshabilitados.filter((n) => n !== "discord");
        } else if (!deshabilitados.includes("discord")) {
          deshabilitados.push("discord");
        }
      }
      parcial.modulos = { deshabilitados };

      const { config: nueva, errores: erroresConfig } = normalizarConfig(parcial, actual);
      validarCruzada(nueva, erroresConfig);
      errores.push(...erroresConfig);

      if (errores.length) throw new ErrorHttp(400, errores.join(" "), { errores });

      const salt = crypto.randomBytes(16).toString("hex");
      escribirJsonAtomico(RUTA_USUARIOS, {
        usuario: String(b.usuario).trim(),
        salt,
        hash: hashPassword(b.contrasena, salt)
      });
      if (Object.keys(cambiosEnv).length) escribirEnvModulo("discord", cambiosEnv);
      escribirJsonAtomico(RUTA_CONFIG, nueva);

      // Lo recien guardado es el punto de partida: no cuenta como "pendiente".
      snapReinicio = claveReinicio(nueva);
      snapTunel = claveTunel(nueva);

      console.log("[Configuracion] Configuración inicial completada desde el panel.");
      if (typeof hooks.setupCompleto === "function") hooks.setupCompleto();
      return { ok: true };
    },

    "GET /api/modulos/ajustes": () => ({
      modulos: infoAjustes(cargarConfiguracion().modulos.deshabilitados)
    }),

    "PUT /api/modulos/ajustes": (req, body) => {
      const entrada = esObjeto(body) && esObjeto(body.modulos) ? body.modulos : null;
      const nombres = entrada ? Object.keys(entrada) : [];
      if (!entrada || nombres.length === 0 || nombres.length > 100) {
        throw new ErrorHttp(400, "No hay ajustes que guardar.");
      }

      const errores = [];
      const plan = [];
      for (const nombre of nombres) {
        const esquema = leerEsquemaModulo(nombre);
        if (!esquema) {
          errores.push(`El módulo "${nombre}" no declara ajustes.`);
          continue;
        }
        const r = validarAjustes(esquema, entrada[nombre], leerEnvModulo(nombre));
        errores.push(...r.errores.map((e) => `${esquema.titulo}: ${e}`));
        if (Object.keys(r.cambios).length) plan.push([nombre, r.cambios]);
      }
      if (errores.length) throw new ErrorHttp(400, errores.join(" "), { errores });

      for (const [nombre, cambios] of plan) escribirEnvModulo(nombre, cambios);
      return {
        guardados: plan.map(([nombre]) => nombre),
        modulos: infoAjustes(cargarConfiguracion().modulos.deshabilitados)
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
      const pagina = usuarioExiste() ? "index.html" : "setup.html";
      return enviar(res, 200, TIPOS[".html"], fs.readFileSync(path.join(CARPETA_UI, pagina)));
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

    // Tema: CSS del color de acento (con ?acento=... se usa para la vista previa)
    if ((metodo === "GET" || metodo === "HEAD") && url.pathname === "/tema.css") {
      const previa = url.searchParams.get("acento");
      const acento = previa !== null ? previa : cargarConfiguracion().tema.acento;
      return enviar(res, 200, TIPOS[".css"], cssTema(acento));
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
  const enSetup = !usuarioExiste();
  console.log("\n==================================================");
  console.log(enSetup
    ? " Primera vez: completa la configuración inicial en esta página\n (solo accesible desde esta PC):"
    : " Configuración (solo accesible desde esta PC):");
  console.log(" " + url);
  console.log("==================================================\n");

  const forzar = process.env.CONFIG_ABRIR;
  const abrir = forzar === "1" ? true : forzar === "0" ? false : config.panel.abrirAlIniciar || enSetup;
  if (abrir) abrirNavegador(url);

  return {
    puerto: puertoPanel,
    url,
    setupPendiente: () => !usuarioExiste(),
    cerrar: () => servidor.close()
  };
}
