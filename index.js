import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import readline from "readline";
import { spawn } from "child_process";
import AdmZip from "adm-zip";
import { asignarPuertoLibre } from "./modules/registro.js";
import { obtenerOCrearApiKey, crearVerificador } from "./modules/apikey.js";

// ============================================================
// CONFIGURACION GENERAL
// ============================================================

const PORT = Number(process.env.PORT || 3000);

// Estas tres arrancan apuntando a localhost, y se actualizan solas apenas
// cloudflared nos da la URL publica real (ver iniciarCloudflared() mas abajo).
// Si el usuario las fija a mano por variable de entorno, esas tienen
// prioridad siempre y nunca se pisan con la URL random del tunel.
let URL_PUBLICA_BASE =
  process.env.URL_PUBLICA_BASE ||
  `http://localhost:${Number(process.env.PORT || 3000)}`;

let URL_PUBLICA_MCP =
  process.env.URL_PUBLICA ||
  `${URL_PUBLICA_BASE}/mcp`;

let URL_OAUTH_ISSUER =
  process.env.OAUTH_ISSUER ||
  URL_PUBLICA_BASE;

const SESSION_MINUTOS =
  Number(process.env.SESSION_MINUTOS || 120);

// OAuth
const ACCESS_TOKEN_MINUTOS =
  Number(process.env.ACCESS_TOKEN_MINUTOS || 60);

const REFRESH_TOKEN_DIAS =
  Number(process.env.REFRESH_TOKEN_DIAS || 30);

const OAUTH_CODE_MINUTOS =
  Number(process.env.OAUTH_CODE_MINUTOS || 5);

const OAUTH_CLIENTS_PATH =
  path.join(process.cwd(), "oauth-clients.json");

const OAUTH_TOKENS_PATH =
  path.join(process.cwd(), "oauth-tokens.json");

// ============================================================
// LOGIN TRADICIONAL
// ============================================================

const USERS_PATH = path.join(process.cwd(), "usuarios.json");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function preguntar(texto) {
  return new Promise((resolve) =>
    rl.question(texto, (r) => resolve(r.trim()))
  );
}

function preguntarOculto(texto) {
  return new Promise((resolve) => {
    process.stdout.write(texto);

    const stdin = process.stdin;

    const rawModeDisponible =
      typeof stdin.setRawMode === "function";

    if (rawModeDisponible)
      stdin.setRawMode(true);

    stdin.resume();
    stdin.setEncoding("utf8");

    let valor = "";

    const onData = (char) => {
      if (
        char === "\n" ||
        char === "\r" ||
        char === "\u0004"
      ) {
        if (rawModeDisponible)
          stdin.setRawMode(false);

        stdin.pause();
        stdin.removeListener("data", onData);

        process.stdout.write("\n");
        resolve(valor);
      } else if (char === "\u0003") {
        process.exit();
      } else if (
        char === "\u007f" ||
        char === "\b"
      ) {
        valor = valor.slice(0, -1);
      } else {
        valor += char;
      }
    };

    stdin.on("data", onData);
  });
}

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
}

function cargarUsuario() {
  try {
    return JSON.parse(
      fs.readFileSync(USERS_PATH, "utf-8")
    );
  } catch {
    return null;
  }
}

function guardarUsuario(usuario) {
  fs.writeFileSync(
    USERS_PATH,
    JSON.stringify(usuario, null, 2),
    "utf-8"
  );
}

async function configurarUsuarioSiHaceFalta() {
  let usuario = cargarUsuario();

  if (usuario) {
    console.log(
      `Usuario configurado: ${usuario.usuario}`
    );

    return usuario;
  }

  console.log("\n==================================================");
  console.log(
    " No hay usuario configurado todavia. Vamos a crear uno."
  );
  console.log("==================================================");

  const nombreUsuario =
    await preguntar(" Elige un nombre de usuario: ");

  const contrasena =
    await preguntarOculto(
      " Elige una contrasena: "
    );

  const salt =
    crypto.randomBytes(16).toString("hex");

  const hash =
    hashPassword(contrasena, salt);

  usuario = {
    usuario: nombreUsuario,
    salt,
    hash
  };

  guardarUsuario(usuario);

  console.log(
    ` Usuario "${nombreUsuario}" creado y guardado en usuarios.json.\n`
  );

  return usuario;
}

let usuarioConfigurado = null;

// ============================================================
// SESIONES TRADICIONALES
// ============================================================

const sesiones = new Map();

function crearSesion() {
  const token =
    crypto.randomBytes(32).toString("hex");

  sesiones.set(
    token,
    Date.now() +
      SESSION_MINUTOS * 60 * 1000
  );

  return token;
}

function sesionValida(token) {
  if (!token || !sesiones.has(token))
    return false;

  const expira =
    sesiones.get(token);

  if (Date.now() > expira) {
    sesiones.delete(token);
    return false;
  }

  return true;
}

// ============================================================
// OAUTH 2.1
// ============================================================

const oauthClients = new Map();
const oauthAuthorizationCodes = new Map();
const oauthAccessTokens = new Map();
const oauthRefreshTokens = new Map();

// CSRF de formularios OAuth
const oauthLoginRequests = new Map();

function cargarJsonSeguro(ruta, valorDefault) {
  try {
    if (!fs.existsSync(ruta))
      return valorDefault;

    return JSON.parse(
      fs.readFileSync(ruta, "utf8")
    );
  } catch {
    return valorDefault;
  }
}

function guardarJsonSeguro(ruta, valor) {
  fs.writeFileSync(
    ruta,
    JSON.stringify(valor, null, 2),
    "utf8"
  );
}

function cargarOAuthPersistente() {
  const clientes =
    cargarJsonSeguro(
      OAUTH_CLIENTS_PATH,
      {}
    );

  for (
    const [id, cliente]
    of Object.entries(clientes)
  ) {
    oauthClients.set(id, cliente);
  }
}

function guardarClientesOAuth() {
  const objeto = {};

  for (
    const [id, cliente]
    of oauthClients.entries()
  ) {
    objeto[id] = cliente;
  }

  guardarJsonSeguro(
    OAUTH_CLIENTS_PATH,
    objeto
  );
}

function randomToken(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("base64url");
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function compararSeguro(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const aa = Buffer.from(a);
  const bb = Buffer.from(b);

  if (aa.length !== bb.length)
    return false;

  return crypto.timingSafeEqual(
    aa,
    bb
  );
}

// ============================================================
// OAUTH CLIENT REGISTRATION
// ============================================================

function registrarClienteOAuth(metadata) {
  const clientId =
    `client_${randomToken(24)}`;

  const cliente = {
    client_id: clientId,

    client_name:
      metadata.client_name ||
      "Cliente MCP",

    redirect_uris:
      metadata.redirect_uris || [],

    token_endpoint_auth_method:
      metadata.token_endpoint_auth_method ||
      "none",

    grant_types:
      metadata.grant_types ||
      [
        "authorization_code",
        "refresh_token"
      ],

    response_types:
      metadata.response_types ||
      ["code"],

    scope:
      metadata.scope ||
      "mcp offline_access",

    created_at:
      Date.now()
  };

  oauthClients.set(
    clientId,
    cliente
  );

  guardarClientesOAuth();

  return cliente;
}

function obtenerCliente(clientId) {
  return oauthClients.get(clientId);
}

function redirectUriPermitida(
  cliente,
  redirectUri
) {
  if (!cliente)
    return false;

  return cliente.redirect_uris.some(
    (uri) => uri === redirectUri
  );
}

// ============================================================
// OAUTH AUTHORIZATION CODE
// ============================================================

function crearAuthorizationCode(datos) {
  const code =
    randomToken(32);

  oauthAuthorizationCodes.set(
    hashToken(code),
    {
      ...datos,

      createdAt:
        Date.now(),

      expiresAt:
        Date.now() +
        OAUTH_CODE_MINUTOS *
          60 *
          1000
    }
  );

  return code;
}

function consumirAuthorizationCode(code) {
  const hash =
    hashToken(code);

  const datos =
    oauthAuthorizationCodes.get(hash);

  if (!datos)
    return null;

  oauthAuthorizationCodes.delete(hash);

  if (
    Date.now() >
    datos.expiresAt
  ) {
    return null;
  }

  return datos;
}

// ============================================================
// OAUTH TOKENS
// ============================================================

function crearOAuthTokens({
  clientId,
  scope,
  mcpSessionToken
}) {
  const accessToken =
    randomToken(48);

  const refreshToken =
    randomToken(64);

  const accessHash =
    hashToken(accessToken);

  const refreshHash =
    hashToken(refreshToken);

  const ahora =
    Date.now();

  oauthAccessTokens.set(
    accessHash,
    {
      clientId,
      scope,
      mcpSessionToken,

      createdAt:
        ahora,

      expiresAt:
        ahora +
        ACCESS_TOKEN_MINUTOS *
          60 *
          1000
    }
  );

  oauthRefreshTokens.set(
    refreshHash,
    {
      clientId,
      scope,
      mcpSessionToken,

      createdAt:
        ahora,

      expiresAt:
        ahora +
        REFRESH_TOKEN_DIAS *
          24 *
          60 *
          60 *
          1000,

      used: false
    }
  );

  return {
    access_token:
      accessToken,

    token_type:
      "Bearer",

    expires_in:
      ACCESS_TOKEN_MINUTOS * 60,

    refresh_token:
      refreshToken,

    scope
  };
}

function obtenerAccessTokenOAuth(token) {
  if (!token)
    return null;

  const hash =
    hashToken(token);

  const datos =
    oauthAccessTokens.get(hash);

  if (!datos)
    return null;

  if (
    Date.now() >
    datos.expiresAt
  ) {
    oauthAccessTokens.delete(hash);
    return null;
  }

  return datos;
}

function renovarOAuth(refreshToken) {
  const hash =
    hashToken(refreshToken);

  const viejo =
    oauthRefreshTokens.get(hash);

  if (!viejo)
    return null;

  // Rotacion obligatoria
  oauthRefreshTokens.delete(hash);

  if (viejo.used)
    return null;

  if (
    Date.now() >
    viejo.expiresAt
  ) {
    return null;
  }

  viejo.used = true;

  // La sesion MCP se conserva.
  return crearOAuthTokens({
    clientId:
      viejo.clientId,

    scope:
      viejo.scope,

    mcpSessionToken:
      viejo.mcpSessionToken
  });
}

// ============================================================
// AUTENTICACION HTTP MCP
// ============================================================

function obtenerBearer(req) {
  const header =
    req.headers.authorization;

  if (!header)
    return null;

  const match =
    header.match(
      /^Bearer\s+(.+)$/i
    );

  if (!match)
    return null;

  return match[1].trim();
}

function obtenerSesionOAuth(req) {
  const accessToken =
    obtenerBearer(req);

  if (!accessToken)
    return null;

  const oauth =
    obtenerAccessTokenOAuth(
      accessToken
    );

  if (!oauth)
    return null;

  if (
    !sesionValida(
      oauth.mcpSessionToken
    )
  ) {
    return null;
  }

  return {
    accessToken,
    ...oauth
  };
}

function enviar401OAuth(res) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="MCP", resource_metadata="${URL_OAUTH_ISSUER}/.well-known/oauth-protected-resource"`
  );

  res.status(401).json({
    error:
      "unauthorized",

    error_description:
      "Se requiere un access token OAuth valido."
  });
}

// ============================================================
// VERIFICACION DE ACCESO USADA POR TODAS LAS TOOLS
// ============================================================

async function verificarAcceso(token) {
  return sesionValida(token);
}

function errorClave() {
  return {
    content: [{
      type: "text",
      text:
        "Sesion invalida, expirada o faltante."
    }]
  };
}

// ============================================================
// SHELLS
// ============================================================

const shells = new Map();

function siguienteIdLibre() {
  let id = 0;

  while (shells.has(id))
    id++;

  return id;
}

function abrirVentanaVisibleParaShell(
  id,
  tipo,
  logPath
) {
  const titulo =
    `Shell ${id} (${tipo})`;

  const comandoTail =
    `Get-Content -Path '${logPath}' -Wait -Tail 200`;

  try {
    const wt =
      spawn(
        "wt.exe",
        [
          "-w",
          "0",
          "new-tab",
          "--title",
          titulo,
          "powershell",
          "-NoExit",
          "-Command",
          comandoTail
        ],
        {
          shell: false,
          detached: true,
          stdio: "ignore"
        }
      );

    wt.on(
      "error",
      (err) => {
        console.error(
          `[shell ${id}] no se pudo abrir Windows Terminal: ${err.message}`
        );
      }
    );

    wt.unref();

  } catch (err) {
    console.error(
      `[shell ${id}] no se pudo abrir Windows Terminal: ${err.message}`
    );
  }
}

function iniciarShellInterna(
  id,
  tipo
) {
  const comando =
    tipo === "powershell"
      ? "powershell.exe"
      : "cmd.exe";

  const proceso =
    spawn(
      comando,
      [],
      {
        shell: false
      }
    );

  const logPath =
    path.join(
      os.tmpdir(),
      `mcp_shell_${id}.log`
    );

  try {
    fs.writeFileSync(
      logPath,
      `[Shell ${id} (${tipo}) iniciada - esto es un espejo de solo lectura]\r\n`
    );
  } catch {}

  const entrada = {
    proceso,
    buffer: "",
    logPath
  };

  shells.set(
    id,
    entrada
  );

  proceso.stdout.on(
    "data",
    (data) => {
      entrada.buffer +=
        data.toString();

      try {
        fs.appendFileSync(
          logPath,
          data
        );
      } catch {}
    }
  );

  proceso.stderr.on(
    "data",
    (data) => {
      entrada.buffer +=
        data.toString();

      try {
        fs.appendFileSync(
          logPath,
          data
        );
      } catch {}
    }
  );

  proceso.on(
    "close",
    (code) => {
      entrada.buffer +=
        `\n[La shell ${id} se cerro con codigo ${code}]\n`;

      entrada.proceso = null;

      try {
        fs.appendFileSync(
          logPath,
          `\r\n[La shell ${id} se cerro con codigo ${code}]\r\n`
        );
      } catch {}
    }
  );

  abrirVentanaVisibleParaShell(
    id,
    tipo,
    logPath
  );

  return entrada;
}

// ============================================================
// REGISTRO DE LAS HERRAMIENTAS MCP DEL INDEX
// ============================================================
//
// IMPORTANTE:
// Todas las herramientas reciben "mcp" como parametro.
//
// Antes:
//   server.registerTool(...)
//
// Ahora:
//   mcp.registerTool(...)
//
// Esto permite crear una instancia independiente de McpServer
// para cada solicitud HTTP.
//

function registrarHerramientasMcp(mcp) {

  // ==========================================================
  // LOGIN
  // ==========================================================

  mcp.registerTool(
    "iniciar_sesion",
    {
      title:
        "Iniciar sesion",

      description:
        "Inicia sesion con usuario y contrasena. Devuelve un token de sesion.",

      inputSchema: {
        usuario:
          z.string(),

        contrasena:
          z.string()
      }
    },

    async ({
      usuario,
      contrasena
    }) => {

      if (!usuarioConfigurado) {
        return {
          content: [{
            type: "text",
            text:
              "El servidor todavia no tiene un usuario configurado."
          }]
        };
      }

      if (
        usuario !==
        usuarioConfigurado.usuario
      ) {
        return {
          content: [{
            type: "text",
            text:
              "Usuario o contrasena incorrectos."
          }]
        };
      }

      const hashIntento =
        hashPassword(
          contrasena,
          usuarioConfigurado.salt
        );

      if (
        !compararSeguro(
          hashIntento,
          usuarioConfigurado.hash
        )
      ) {
        return {
          content: [{
            type: "text",
            text:
              "Usuario o contrasena incorrectos."
          }]
        };
      }

      const token =
        crearSesion();

      console.log(
        `[Login] Sesion tradicional iniciada para "${usuario}".`
      );

      return {
        content: [{
          type: "text",
          text:
            `Sesion iniciada. Token:\n${token}`
        }]
      };
    }
  );

  // ==========================================================
  // CERRAR SESION
  // ==========================================================

  mcp.registerTool(
    "cerrar_sesion",
    {
      title:
        "Cerrar sesion",

      description:
        "Invalida una sesion activa.",

      inputSchema: {
        clave:
          z.string()
      }
    },

    async ({ clave }) => {

      sesiones.delete(clave);

      for (
        const [
          hash,
          datos
        ]
        of oauthAccessTokens.entries()
      ) {
        if (
          datos.mcpSessionToken ===
          clave
        ) {
          oauthAccessTokens.delete(hash);
        }
      }

      return {
        content: [{
          type: "text",
          text:
            "Sesion cerrada."
        }]
      };
    }
  );

  // ==========================================================
  // LISTAR ARCHIVOS
  // ==========================================================

  mcp.registerTool(
    "listar_archivos",
    {
      title:
        "Listar archivos",

      description:
        "Lista los archivos y carpetas dentro de una ruta dada",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {
        const items =
          fs.readdirSync(
            ruta,
            {
              withFileTypes: true
            }
          );

        const resultado =
          items.map(
            (item) =>
              `${
                item.isDirectory()
                  ? "[DIR] "
                  : "[FILE]"
              } ${item.name}`
          ).join("\n");

        return {
          content: [{
            type: "text",
            text:
              resultado ||
              "(carpeta vacia)"
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // LEER ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "leer_archivo",
    {
      title:
        "Leer archivo",

      description:
        "Lee el contenido de un archivo de texto",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        const contenido =
          fs.readFileSync(
            ruta,
            "utf-8"
          );

        return {
          content: [{
            type: "text",
            text:
              contenido
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // CREAR ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "crear_archivo",
    {
      title:
        "Crear o sobrescribir archivo",

      description:
        "Crea un archivo nuevo o sobrescribe uno existente",

      inputSchema: {
        ruta:
          z.string(),

        contenido:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      contenido,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.writeFileSync(
          ruta,
          contenido,
          "utf-8"
        );

        return {
          content: [{
            type: "text",
            text:
              `Archivo creado/actualizado: ${ruta}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // EDITAR ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "editar_archivo",
    {
      title:
        "Editar archivo",

      description:
        "Reemplaza una porcion de texto dentro de un archivo existente",

      inputSchema: {
        ruta:
          z.string(),

        buscar:
          z.string(),

        reemplazar:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      buscar,
      reemplazar,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        const contenido =
          fs.readFileSync(
            ruta,
            "utf-8"
          );

        if (
          !contenido.includes(buscar)
        ) {
          return {
            content: [{
              type: "text",
              text:
                "No se encontro el texto a reemplazar."
            }]
          };
        }

        const nuevo =
          contenido.replace(
            buscar,
            reemplazar
          );

        fs.writeFileSync(
          ruta,
          nuevo,
          "utf-8"
        );

        return {
          content: [{
            type: "text",
            text:
              `Archivo editado: ${ruta}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // ELIMINAR ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "eliminar_archivo",
    {
      title:
        "Eliminar archivo",

      description:
        "Elimina un archivo",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.unlinkSync(ruta);

        return {
          content: [{
            type: "text",
            text:
              `Archivo eliminado: ${ruta}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // ELIMINAR CARPETA
  // ==========================================================

  mcp.registerTool(
    "eliminar_carpeta",
    {
      title:
        "Eliminar carpeta",

      description:
        "Elimina una carpeta y todo su contenido",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.rmSync(
          ruta,
          {
            recursive: true,
            force: true
          }
        );

        return {
          content: [{
            type: "text",
            text:
              `Carpeta eliminada: ${ruta}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // CREAR CARPETA
  // ==========================================================

  mcp.registerTool(
    "crear_carpeta",
    {
      title:
        "Crear carpeta",

      description:
        "Crea una carpeta y las intermedias",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.mkdirSync(
          ruta,
          {
            recursive: true
          }
        );

        return {
          content: [{
            type: "text",
            text:
              `Carpeta creada: ${ruta}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // RENOMBRAR
  // ==========================================================

  mcp.registerTool(
    "renombrar",
    {
      title:
        "Renombrar o mover archivo/carpeta",

      description:
        "Renombra o mueve un archivo o carpeta",

      inputSchema: {
        rutaOrigen:
          z.string(),

        rutaDestino:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      rutaOrigen,
      rutaDestino,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.renameSync(
          rutaOrigen,
          rutaDestino
        );

        return {
          content: [{
            type: "text",
            text:
              `Renombrado/movido de ${rutaOrigen} a ${rutaDestino}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // INFO ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "info_archivo",
    {
      title:
        "Informacion de archivo o carpeta",

      description:
        "Devuelve tamano, tipo y fechas",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        const stats =
          fs.statSync(ruta);

        const info = {
          tipo:
            stats.isDirectory()
              ? "carpeta"
              : "archivo",

          tamañoBytes:
            stats.size,

          creado:
            stats.birthtime,

          modificado:
            stats.mtime
        };

        return {
          content: [{
            type: "text",
            text:
              JSON.stringify(
                info,
                null,
                2
              )
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // TRANSFERENCIAS
  // ==========================================================

  const LIMITE_TRANSFERENCIA =
    25 * 1024 * 1024;

  // ==========================================================
  // DESCARGAR ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "descargar_archivo",
    {
      title:
        "Descargar archivo",

      description:
        "Devuelve un archivo codificado en base64",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        const stats =
          fs.statSync(ruta);

        if (stats.isDirectory()) {

          return {
            content: [{
              type: "text",
              text:
                "Esa ruta es una carpeta. Usa 'descargar_carpeta'."
            }]
          };
        }

        if (
          stats.size >
          LIMITE_TRANSFERENCIA
        ) {

          return {
            content: [{
              type: "text",
              text:
                "El archivo supera el limite de 25MB."
            }]
          };
        }

        const buffer =
          fs.readFileSync(ruta);

        return {
          content: [{
            type: "text",
            text:
              JSON.stringify({
                nombre:
                  path.basename(ruta),

                tamañoBytes:
                  buffer.length,

                base64:
                  buffer.toString("base64")
              })
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // DESCARGAR CARPETA
  // ==========================================================

  mcp.registerTool(
    "descargar_carpeta",
    {
      title:
        "Descargar carpeta",

      description:
        "Comprime una carpeta y la devuelve como base64",

      inputSchema: {
        ruta:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      ruta,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        const stats =
          fs.statSync(ruta);

        if (!stats.isDirectory()) {

          return {
            content: [{
              type: "text",
              text:
                "Esa ruta no es una carpeta."
            }]
          };
        }

        const zip =
          new AdmZip();

        zip.addLocalFolder(ruta);

        const buffer =
          zip.toBuffer();

        if (
          buffer.length >
          LIMITE_TRANSFERENCIA
        ) {

          return {
            content: [{
              type: "text",
              text:
                "El ZIP supera el limite de 25MB."
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text:
              JSON.stringify({
                nombre:
                  path.basename(ruta) +
                  ".zip",

                tamañoBytes:
                  buffer.length,

                base64:
                  buffer.toString("base64")
              })
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // SUBIR ARCHIVO
  // ==========================================================

  mcp.registerTool(
    "subir_archivo",
    {
      title:
        "Subir archivo",

      description:
        "Recibe un archivo en base64",

      inputSchema: {
        rutaDestino:
          z.string(),

        base64:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      rutaDestino,
      base64,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      try {

        fs.mkdirSync(
          path.dirname(rutaDestino),
          {
            recursive: true
          }
        );

        const buffer =
          Buffer.from(
            base64,
            "base64"
          );

        if (
          buffer.length >
          LIMITE_TRANSFERENCIA
        ) {
          return {
            content: [{
              type: "text",
              text:
                "La transferencia supera 25MB."
            }]
          };
        }

        fs.writeFileSync(
          rutaDestino,
          buffer
        );

        return {
          content: [{
            type: "text",
            text:
              `Archivo guardado: ${rutaDestino} (${buffer.length} bytes)`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };
      }
    }
  );

  // ==========================================================
  // SUBIR CARPETA
  // ==========================================================

  mcp.registerTool(
    "subir_carpeta",
    {
      title:
        "Subir carpeta",

      description:
        "Recibe un ZIP en base64 y lo extrae",

      inputSchema: {
        carpetaDestino:
          z.string(),

        base64Zip:
          z.string(),

        clave:
          z.string().optional()
      }
    },

    async ({
      carpetaDestino,
      base64Zip,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      let tempZip = null;

      try {

        fs.mkdirSync(
          carpetaDestino,
          {
            recursive: true
          }
        );

        const buffer =
          Buffer.from(
            base64Zip,
            "base64"
          );

        if (
          buffer.length >
          LIMITE_TRANSFERENCIA
        ) {
          return {
            content: [{
              type: "text",
              text:
                "El ZIP supera 25MB."
            }]
          };
        }

        tempZip =
          path.join(
            os.tmpdir(),
            `subida-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.zip`
          );

        fs.writeFileSync(
          tempZip,
          buffer
        );

        const zip =
          new AdmZip(tempZip);

        zip.extractAllTo(
          carpetaDestino,
          true
        );

        return {
          content: [{
            type: "text",
            text:
              `Carpeta extraida en: ${carpetaDestino}`
          }]
        };

      } catch (err) {

        return {
          content: [{
            type: "text",
            text:
              `Error: ${err.message}`
          }]
        };

      } finally {

        if (
          tempZip &&
          fs.existsSync(tempZip)
        ) {
          try {
            fs.unlinkSync(tempZip);
          } catch {}
        }
      }
    }
  );

  // ==========================================================
  // INICIAR SHELL
  // ==========================================================

  mcp.registerTool(
    "iniciar_shell",
    {
      title:
        "Iniciar shell persistente",

      description:
        "Abre una shell cmd o powershell",

      inputSchema: {
        tipo:
          z.enum([
            "cmd",
            "powershell"
          ]).optional(),

        shell:
          z.number()
            .int()
            .nonnegative()
            .optional(),

        clave:
          z.string().optional()
      }
    },

    async ({
      tipo,
      shell,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      const id =
        shell ??
        siguienteIdLibre();

      const existente =
        shells.get(id);

      if (
        existente &&
        existente.proceso
      ) {
        return {
          content: [{
            type: "text",
            text:
              `Ya hay una shell activa en el slot ${id}.`
          }]
        };
      }

      iniciarShellInterna(
        id,
        tipo || "cmd"
      );

      return {
        content: [{
          type: "text",
          text:
            `Shell ${id} (${tipo || "cmd"}) iniciada.`
        }]
      };
    }
  );

  // ==========================================================
  // LISTAR SHELLS
  // ==========================================================

  mcp.registerTool(
    "listar_shells",
    {
      title:
        "Listar shells activas",

      description:
        "Muestra las shells abiertas",

      inputSchema: {
        clave:
          z.string().optional()
      }
    },

    async ({ clave }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      if (shells.size === 0) {
        return {
          content: [{
            type: "text",
            text:
              "No hay ninguna shell abierta."
          }]
        };
      }

      const lineas =
        [...shells.entries()]
          .sort(
            (a, b) =>
              a[0] - b[0]
          )
          .map(
            ([id, e]) =>
              `shell ${id}: ${
                e.proceso
                  ? "activa"
                  : "cerrada"
              }`
          );

      return {
        content: [{
          type: "text",
          text:
            lineas.join("\n")
        }]
      };
    }
  );

  // ==========================================================
  // ENVIAR COMANDO
  // ==========================================================

  mcp.registerTool(
    "enviar_comando",
    {
      title:
        "Enviar comando a una shell",

      description:
        "Ejecuta un comando",

      inputSchema: {
        shell:
          z.number()
            .int()
            .nonnegative(),

        comando:
          z.string(),

        esperaMs:
          z.number().optional(),

        clave:
          z.string().optional()
      }
    },

    async ({
      shell,
      comando,
      esperaMs,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      const entrada =
        shells.get(shell);

      if (
        !entrada ||
        !entrada.proceso
      ) {
        return {
          content: [{
            type: "text",
            text:
              `No hay ninguna shell activa en el slot ${shell}.`
          }]
        };
      }

      entrada.buffer = "";

      entrada.proceso.stdin.write(
        comando + "\r\n"
      );

      await new Promise(
        (r) =>
          setTimeout(
            r,
            esperaMs || 2000
          )
      );

      return {
        content: [{
          type: "text",
          text:
            entrada.buffer ||
            "(sin salida todavia)"
        }]
      };
    }
  );

  // ==========================================================
  // LEER SALIDA SHELL
  // ==========================================================

  mcp.registerTool(
    "leer_salida_shell",
    {
      title:
        "Leer salida acumulada",

      description:
        "Lee la salida de una shell",

      inputSchema: {
        shell:
          z.number()
            .int()
            .nonnegative(),

        clave:
          z.string().optional()
      }
    },

    async ({
      shell,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      const entrada =
        shells.get(shell);

      if (!entrada) {
        return {
          content: [{
            type: "text",
            text:
              `No existe ninguna shell en el slot ${shell}.`
          }]
        };
      }

      const salida =
        entrada.buffer ||
        "(sin salida nueva)";

      entrada.buffer = "";

      return {
        content: [{
          type: "text",
          text:
            salida
        }]
      };
    }
  );

  // ==========================================================
  // ESPERAR SALIDA
  // ==========================================================

  mcp.registerTool(
    "esperar_salida",
    {
      title:
        "Esperar salida",

      description:
        "Espera output nuevo",

      inputSchema: {
        shell:
          z.number()
            .int()
            .nonnegative(),

        maxEsperaMs:
          z.number().optional(),

        clave:
          z.string().optional()
      }
    },

    async ({
      shell,
      maxEsperaMs,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      const entrada =
        shells.get(shell);

      if (
        !entrada ||
        !entrada.proceso
      ) {
        return {
          content: [{
            type: "text",
            text:
              `No hay ninguna shell activa en el slot ${shell}.`
          }]
        };
      }

      const limite =
        maxEsperaMs || 90000;

      const intervalo =
        500;

      let transcurrido =
        0;

      while (
        transcurrido <
        limite
      ) {

        if (
          entrada.buffer.length > 0
        ) {

          const salida =
            entrada.buffer;

          entrada.buffer = "";

          return {
            content: [{
              type: "text",
              text:
                salida
            }]
          };
        }

        await new Promise(
          (r) =>
            setTimeout(
              r,
              intervalo
            )
        );

        transcurrido +=
          intervalo;
      }

      return {
        content: [{
          type: "text",
          text:
            `(sin salida nueva despues de ${Math.round(limite / 1000)}s)`
        }]
      };
    }
  );

  // ==========================================================
  // DETENER SHELL
  // ==========================================================

  mcp.registerTool(
    "detener_shell",
    {
      title:
        "Detener una shell",

      description:
        "Detiene una shell",

      inputSchema: {
        shell:
          z.number()
            .int()
            .nonnegative(),

        clave:
          z.string().optional()
      }
    },

    async ({
      shell,
      clave
    }) => {

      if (
        !(await verificarAcceso(clave))
      )
        return errorClave();

      const entrada =
        shells.get(shell);

      if (!entrada) {
        return {
          content: [{
            type: "text",
            text:
              `No habia ninguna shell en el slot ${shell}.`
          }]
        };
      }

      if (entrada.proceso)
        entrada.proceso.kill();

      if (entrada.logPath) {
        try {
          fs.appendFileSync(
            entrada.logPath,
            `\r\n[Shell ${shell} detenida manualmente]\r\n`
          );
        } catch {}
      }

      shells.delete(shell);

      return {
        content: [{
          type: "text",
          text:
            `Shell ${shell} detenida.`
        }]
      };
    }
  );
}

// ============================================================
// MODULOS
// ============================================================

const modulesDir =
  path.join(
    process.cwd(),
    "modules"
  );

const apiRouter =
  express.Router();

const apiKey =
  obtenerOCrearApiKey();

const verificarApiKey =
  crearVerificador(apiKey);

const modulosCargados = [];

async function cargarModulos() {

  if (
    !fs.existsSync(modulesDir)
  )
    return;

  const carpetas =
    fs.readdirSync(
      modulesDir,
      {
        withFileTypes: true
      }
    )
    .filter(
      (d) => d.isDirectory()
    );

  for (
    const carpeta of carpetas
  ) {

    const rutaModule =
      path.join(
        modulesDir,
        carpeta.name,
        "module.js"
      );

    if (
      !fs.existsSync(rutaModule)
    )
      continue;

    const mod =
      (
        await import(
          `./modules/${carpeta.name}/module.js`
        )
      ).default;

    modulosCargados.push(mod);
  }

  const puertosUsados =
    new Set();

  for (
    const mod of modulosCargados
  ) {

    // IMPORTANTE:
    // registrarMcp YA NO se ejecuta aqui.
    //
    // Se ejecutara en crearMcpServer(), una vez por
    // instancia de McpServer.

    mod.registrarRest?.(
      apiRouter,
      {
        verificarApiKey
      }
    );

    let puerto = null;

    if (
      typeof mod.iniciar ===
      "function"
    ) {

      puerto =
        await asignarPuertoLibre(
          puertosUsados
        );

      await mod.iniciar(
        puerto
      );
    }

    console.log(
      `Modulo cargado: ${mod.nombre}${
        puerto
          ? ` (puerto ${puerto})`
          : ""
      }`
    );
  }
}

// ============================================================
// CREAR UNA INSTANCIA MCP NUEVA
// ============================================================
//
// ESTA ES LA CORRECCION PRINCIPAL.
//
// Cada POST /mcp obtiene:
//
//   McpServer nuevo
//        |
//        +-- herramientas del index
//        |
//        +-- herramientas de modulos
//        |
//        +-- transport nuevo
//
// Nunca se conecta el mismo McpServer a dos transports.
//

function crearMcpServer() {

  const mcp =
    new McpServer({
      name:
        "mi-servidor",

      version:
        "1.0.0"
    });

  // Herramientas del index.js
  registrarHerramientasMcp(mcp);

  // Herramientas de todos los modulos
  for (
    const mod
    of modulosCargados
  ) {

    if (
      typeof mod.registrarMcp ===
      "function"
    ) {

      mod.registrarMcp(
        mcp,
        {
          verificarAcceso,
          errorClave
        }
      );
    }
  }

  return mcp;
}

// ============================================================
// EXPRESS
// ============================================================

const app =
  express();

app.use(
  express.json({
    limit: "40mb"
  })
);

app.use(
  express.urlencoded({
    extended: false
  })
);

app.use(
  "/api",
  apiRouter
);

app.use(
  express.static(
    path.join(
      process.cwd(),
      "public"
    )
  )
);

// ============================================================
// OAUTH METADATA
// ============================================================

app.get(
  "/.well-known/oauth-protected-resource",
  (req, res) => {

    res.json({
      resource:
        URL_PUBLICA_MCP,

      authorization_servers: [
        URL_OAUTH_ISSUER
      ],

      scopes_supported: [
        "mcp",
        "offline_access"
      ],

      bearer_methods_supported: [
        "header"
      ]
    });
  }
);

app.get(
  "/.well-known/oauth-authorization-server",
  (req, res) => {

    res.json({
      issuer:
        URL_OAUTH_ISSUER,

      authorization_endpoint:
        `${URL_OAUTH_ISSUER}/oauth/authorize`,

      token_endpoint:
        `${URL_OAUTH_ISSUER}/oauth/token`,

      registration_endpoint:
        `${URL_OAUTH_ISSUER}/oauth/register`,

      scopes_supported: [
        "mcp",
        "offline_access"
      ],

      response_types_supported: [
        "code"
      ],

      response_modes_supported: [
        "query"
      ],

      grant_types_supported: [
        "authorization_code",
        "refresh_token"
      ],

      token_endpoint_auth_methods_supported: [
        "none"
      ],

      code_challenge_methods_supported: [
        "S256"
      ],

      service_documentation:
        `${URL_OAUTH_ISSUER}/`
    });
  }
);

// ============================================================
// DYNAMIC CLIENT REGISTRATION
// ============================================================

app.post(
  "/oauth/register",
  (req, res) => {

    const body =
      req.body || {};

    if (
      !Array.isArray(
        body.redirect_uris
      ) ||
      body.redirect_uris.length === 0
    ) {

      return res.status(400).json({
        error:
          "invalid_client_metadata",

        error_description:
          "redirect_uris es obligatorio."
      });
    }

    const redirectUris =
      body.redirect_uris;

    for (
      const uri of redirectUris
    ) {

      try {
        new URL(uri);
      } catch {

        return res.status(400).json({
          error:
            "invalid_redirect_uri",

          error_description:
            "Una redirect_uri no es valida."
        });
      }
    }

    const authMethod =
      body.token_endpoint_auth_method ||
      "none";

    if (
      authMethod !== "none"
    ) {

      return res.status(400).json({
        error:
          "invalid_client_metadata",

        error_description:
          "Este servidor utiliza clientes publicos con PKCE."
      });
    }

    const cliente =
      registrarClienteOAuth({
        ...body,

        redirect_uris:
          redirectUris,

        token_endpoint_auth_method:
          "none"
      });

    console.log(
      `[OAuth] Cliente registrado: ${cliente.client_id} (${cliente.client_name})`
    );

    return res.status(201).json(
      cliente
    );
  }
);

// ============================================================
// PAGINA DE AUTORIZACION
// ============================================================

const DOMINIOS_CONOCIDOS = [
  "chat.openai.com",
  "claude.ai"
];

function esDominioConocido(host) {
  if (!host)
    return false;

  return DOMINIOS_CONOCIDOS.some(
    (d) =>
      host === d ||
      host.endsWith(`.${d}`)
  );
}

function escaparHtml(valor) {

  return String(valor)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

function paginaLoginOAuth({
  csrf,
  params,
  error = null,
  clientName = null,
  redirectHost = null
}) {

  const hidden =
    Object.entries(params)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${escaparHtml(key)}" value="${escaparHtml(value ?? "")}">`
      )
      .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar MCP</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
.logo-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 6px;
}
.logo-wrap img {
  width: 72px;
  height: 72px;
  border-radius: 16px;
}
.brand {
  text-align: center;
  color: #cbb6ff;
  font-size: 13px;
  letter-spacing: 0.03em;
  margin: 2px 0 20px;
}
body {
  font-family: Arial, sans-serif;
  background: #111;
  color: #eee;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  margin: 0;
}
.card {
  width: min(420px, calc(100% - 40px));
  background: #1d1d1d;
  padding: 28px;
  border-radius: 14px;
  box-sizing: border-box;
}
h1 {
  margin-top: 0;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 11px;
  margin: 7px 0 15px;
  border-radius: 7px;
  border: 1px solid #555;
  background: #111;
  color: white;
}
button {
  width: 100%;
  padding: 12px;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
}
.error {
  background: #5c2020;
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 15px;
}
.small {
  color: #aaa;
  font-size: 13px;
}
.solicitante {
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 18px;
  border: 1px solid;
}
.solicitante.conocido {
  background: #14261f;
  border-color: #2a4a3a;
}
.solicitante.desconocido {
  background: #2b2210;
  border-color: #5c4a15;
}
.solicitante .nombre {
  font-weight: bold;
  font-size: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.solicitante .badge {
  font-size: 11px;
  font-weight: normal;
  padding: 2px 8px;
  border-radius: 20px;
}
.conocido .badge {
  background: #1f4030;
  color: #7be2a6;
}
.desconocido .badge {
  background: #4a3a10;
  color: #e8c25a;
}
.solicitante .redirect {
  font-size: 12px;
  margin-top: 4px;
  word-break: break-all;
}
.conocido .redirect {
  color: #9fd6b8;
}
.desconocido .redirect {
  color: #e8c25a;
}
.solicitante .aviso {
  font-size: 12px;
  margin-top: 6px;
  color: #aaa;
}
</style>
</head>
<body>
<div class="card">
<div class="logo-wrap"><img src="/logo.svg" alt="Juanmonopi's Model Context Protocol"></div>
<p class="brand">Juanmonopi's Model Context Protocol</p>
<h1>Autorizar MCP</h1>

${(() => {
  const conocido =
    esDominioConocido(
      redirectHost
    );

  return `<div class="solicitante ${conocido ? "conocido" : "desconocido"}">
  <div class="nombre">
    ${escaparHtml(clientName || "Aplicación desconocida")}
    <span class="badge">${conocido ? "✓ dominio conocido" : "⚠ dominio no reconocido"}</span>
  </div>
  ${
    redirectHost
      ? `<div class="redirect">Te va a devolver a: ${escaparHtml(redirectHost)}</div>`
      : ""
  }
  <div class="aviso">
    El nombre lo declara la app al registrarse, no está verificado.
    ${
      conocido
        ? "El dominio de destino sí está en tu lista de conocidos."
        : "El dominio de destino NO está en tu lista de conocidos — revisalo con cuidado."
    }
  </div>
</div>`;
})()}

<p class="small">
Solo continúa si reconocés la aplicación y el dominio de arriba.
</p>

${
  error
    ? `<div class="error">${escaparHtml(error)}</div>`
    : ""
}

<form method="POST" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${escaparHtml(csrf)}">
${hidden}

<label>Usuario</label>
<input
  name="usuario"
  autocomplete="username"
  required
>

<label>Contraseña</label>
<input
  type="password"
  name="contrasena"
  autocomplete="current-password"
  required
>

<button type="submit">
Autorizar acceso
</button>
</form>

</div>
</body>
</html>`;
}

// ============================================================
// GET /oauth/authorize
// ============================================================

app.get(
  "/oauth/authorize",
  (req, res) => {

    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method
    } = req.query;

    if (
      response_type !==
      "code"
    ) {
      return res.status(400).send(
        "response_type debe ser code."
      );
    }

    const cliente =
      obtenerCliente(
        client_id
      );

    if (!cliente) {

      return res.status(400).send(
        "Cliente OAuth desconocido."
      );
    }

    if (
      !redirectUriPermitida(
        cliente,
        redirect_uri
      )
    ) {

      return res.status(400).send(
        "redirect_uri no registrada."
      );
    }

    if (
      code_challenge_method !==
      "S256"
    ) {

      return res.status(400).send(
        "Este servidor requiere PKCE S256."
      );
    }

    if (!code_challenge) {

      return res.status(400).send(
        "Falta code_challenge."
      );
    }

    const csrf =
      randomToken(24);

    oauthLoginRequests.set(
      hashToken(csrf),
      {
        createdAt:
          Date.now(),

        expiresAt:
          Date.now() +
          10 * 60 * 1000
      }
    );

    const params = {
      response_type,
      client_id,
      redirect_uri,

      scope:
        scope ||
        "mcp offline_access",

      state:
        state || "",

      code_challenge,

      code_challenge_method
    };

    res
      .status(200)
      .send(
        paginaLoginOAuth({
          csrf,
          params,

          clientName:
            cliente.client_name,

          redirectHost:
            new URL(
              redirect_uri
            ).host
        })
      );
  }
);

// ============================================================
// POST /oauth/authorize
// ============================================================

app.post(
  "/oauth/authorize",
  (req, res) => {

    const {
      csrf,
      usuario,
      contrasena,

      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method
    } = req.body || {};

    const csrfData =
      oauthLoginRequests.get(
        hashToken(
          csrf || ""
        )
      );

    if (
      !csrfData ||
      Date.now() >
        csrfData.expiresAt
    ) {

      return res.status(400).send(
        "La solicitud de autorizacion expiro. Vuelve a intentarlo."
      );
    }

    oauthLoginRequests.delete(
      hashToken(csrf)
    );

    const cliente =
      obtenerCliente(
        client_id
      );

    if (!cliente) {

      return res.status(400).send(
        "Cliente OAuth desconocido."
      );
    }

    if (
      !redirectUriPermitida(
        cliente,
        redirect_uri
      )
    ) {

      return res.status(400).send(
        "redirect_uri no registrada."
      );
    }

    if (
      response_type !==
        "code" ||
      code_challenge_method !==
        "S256" ||
      !code_challenge
    ) {

      return res.status(400).send(
        "Solicitud OAuth/PKCE invalida."
      );
    }

    if (
      !usuarioConfigurado ||
      usuario !==
        usuarioConfigurado.usuario
    ) {

      return res
        .status(401)
        .send(
          paginaLoginOAuth({
            csrf:
              randomToken(24),

            params: {
              response_type,
              client_id,
              redirect_uri,
              scope,
              state,
              code_challenge,
              code_challenge_method
            },

            error:
              "Usuario o contraseña incorrectos.",

            clientName:
              cliente.client_name,

            redirectHost:
              new URL(
                redirect_uri
              ).host
          })
        );
    }

    const hashIntento =
      hashPassword(
        contrasena,
        usuarioConfigurado.salt
      );

    if (
      !compararSeguro(
        hashIntento,
        usuarioConfigurado.hash
      )
    ) {

      return res
        .status(401)
        .send(
          "Usuario o contraseña incorrectos."
        );
    }

    // Cada autorizacion crea una SESION MCP completamente nueva.
    const mcpSessionToken =
      crearSesion();

    const code =
      crearAuthorizationCode({
        clientId:
          client_id,

        redirectUri:
          redirect_uri,

        scope:
          scope ||
          "mcp offline_access",

        state:
          state || "",

        codeChallenge:
          code_challenge,

        codeChallengeMethod:
          code_challenge_method,

        mcpSessionToken
      });

    console.log(
      `[OAuth] Autorizacion concedida para ${cliente.client_name || client_id}.`
    );

    const destino =
      new URL(
        redirect_uri
      );

    destino.searchParams.set(
      "code",
      code
    );

    if (state) {
      destino.searchParams.set(
        "state",
        state
      );
    }

    return res.redirect(
      destino.toString()
    );
  }
);

// ============================================================
// TOKEN ENDPOINT
// ============================================================

function verificarPKCE(
  codeVerifier,
  codeChallenge
) {

  if (
    !codeVerifier ||
    !codeChallenge
  )
    return false;

  const hash =
    crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

  return compararSeguro(
    hash,
    codeChallenge
  );
}

app.post(
  "/oauth/token",
  express.urlencoded({
    extended: false
  }),
  (req, res) => {

    const {
      grant_type,
      code,
      redirect_uri,
      client_id,
      code_verifier,
      refresh_token
    } = req.body || {};

    // ========================================================
    // AUTHORIZATION CODE
    // ========================================================

    if (
      grant_type ===
      "authorization_code"
    ) {

      const datos =
        consumirAuthorizationCode(
          code
        );

      if (!datos) {

        return res.status(400).json({
          error:
            "invalid_grant",

          error_description:
            "Authorization code invalido o expirado."
        });
      }

      if (
        datos.clientId !==
        client_id
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }

      if (
        datos.redirectUri !==
        redirect_uri
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }

      if (
        !verificarPKCE(
          code_verifier,
          datos.codeChallenge
        )
      ) {

        sesiones.delete(
          datos.mcpSessionToken
        );

        return res.status(400).json({
          error:
            "invalid_grant",

          error_description:
            "PKCE verification failed."
        });
      }

      const cliente =
        obtenerCliente(
          client_id
        );

      if (!cliente) {

        return res.status(400).json({
          error:
            "invalid_client"
        });
      }

      const tokens =
        crearOAuthTokens({
          clientId:
            client_id,

          scope:
            datos.scope,

          mcpSessionToken:
            datos.mcpSessionToken
        });

      return res.json(
        tokens
      );
    }

    // ========================================================
    // REFRESH TOKEN
    // ========================================================

    if (
      grant_type ===
      "refresh_token"
    ) {

      const datos =
        oauthRefreshTokens.get(
          hashToken(
            refresh_token || ""
          )
        );

      if (!datos) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }

      if (
        datos.clientId !==
        client_id
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }

      const tokens =
        renovarOAuth(
          refresh_token
        );

      if (!tokens) {

        return res.status(400).json({
          error:
            "invalid_grant",

          error_description:
            "Refresh token invalido, expirado o ya utilizado."
        });
      }

      return res.json(
        tokens
      );
    }

    return res.status(400).json({
      error:
        "unsupported_grant_type"
    });
  }
);

// ============================================================
// REVOCACION
// ============================================================

app.post(
  "/oauth/revoke",
  express.urlencoded({
    extended: false
  }),
  (req, res) => {

    const token =
      req.body?.token;

    if (!token)
      return res.sendStatus(200);

    const accessHash =
      hashToken(token);

    const access =
      oauthAccessTokens.get(
        accessHash
      );

    if (access) {

      sesiones.delete(
        access.mcpSessionToken
      );

      oauthAccessTokens.delete(
        accessHash
      );
    }

    const refreshHash =
      hashToken(token);

    oauthRefreshTokens.delete(
      refreshHash
    );

    return res.sendStatus(200);
  }
);

// ============================================================
// MCP
// ============================================================
//
// CORRECCION DEL ERROR:
//
// Antes:
//
//   const server = new McpServer(...);
//
//   POST /mcp
//       server.connect(transport);
//
// Segunda peticion:
//
//       server.connect(otroTransport);
//
// => Already connected to a transport
//
// Ahora:
//
//   POST /mcp #1
//       crearMcpServer()
//       -> McpServer #1
//       -> Transport #1
//
//   POST /mcp #2
//       crearMcpServer()
//       -> McpServer #2
//       -> Transport #2
//
// Cada instancia tiene un unico transport.
//

app.post(
  "/mcp",
  async (req, res) => {

    let mcp = null;
    let transport = null;

    try {

      // ------------------------------------------------------
      // OAuth
      // ------------------------------------------------------

      const oauth =
        obtenerSesionOAuth(req);

      if (!oauth) {
        enviar401OAuth(res);
        return;
      }

      // ------------------------------------------------------
      // Copiar body
      // ------------------------------------------------------

      const body =
        JSON.parse(
          JSON.stringify(
            req.body || {}
          )
        );

      // ------------------------------------------------------
      // Inyectar sesion OAuth como "clave"
      // ------------------------------------------------------

      if (
        body?.method ===
          "tools/call" &&
        body.params &&
        typeof body.params.arguments ===
          "object" &&
        body.params.arguments !== null
      ) {

        body.params.arguments.clave =
          oauth.mcpSessionToken;
      }

      // ------------------------------------------------------
      // CREAR SERVIDOR MCP INDEPENDIENTE
      // ------------------------------------------------------

      mcp =
        crearMcpServer();

      // ------------------------------------------------------
      // CREAR TRANSPORT INDEPENDIENTE
      // ------------------------------------------------------

      transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator:
            undefined
        });

      // ------------------------------------------------------
      // Limpieza si el cliente cierra la conexion
      // ------------------------------------------------------

      res.on(
        "close",
        () => {

          try {
            transport?.close();
          } catch {}

          try {
            mcp?.close();
          } catch {}
        }
      );

      // ------------------------------------------------------
      // CONECTAR ESTE MCP SOLO A ESTE TRANSPORT
      // ------------------------------------------------------

      await mcp.connect(
        transport
      );

      // ------------------------------------------------------
      // PROCESAR REQUEST
      // ------------------------------------------------------

      await transport.handleRequest(
        req,
        res,
        body
      );

    } catch (err) {

      console.error(
        "[MCP] Error procesando solicitud:",
        err
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          error:
            "internal_server_error",

          error_description:
            err.message
        });
      }

    } finally {

      // Para Streamable HTTP stateless, cada request tiene
      // su propia instancia y puede cerrarse al terminar.

      try {
        transport?.close();
      } catch {}

      try {
        mcp?.close();
      } catch {}
    }
  }
);

// ============================================================
// GET /mcp
// ============================================================

app.get(
  "/mcp",
  (req, res) => {

    const oauth =
      obtenerSesionOAuth(req);

    if (!oauth) {

      enviar401OAuth(res);
      return;
    }

    res.status(200).json({
      name:
        "mi-servidor",

      version:
        "1.0.0",

      authenticated:
        true
    });
  }
);

// ============================================================
// CLOUDFLARED
// ============================================================
//
// Version publica/portable: usa un "quick tunnel" (URL random tipo
// https://palabra-palabra-palabra.trycloudflare.com), no un tunel nombrado
// con dominio propio -- para eso hace falta una cuenta de Cloudflare con un
// dominio delegado, que un usuario que clona este repo no va a tener.
//
// Trade-off real, para que quede claro: la URL cambia cada vez que se
// reinicia el servidor. Eso significa que cualquier cliente OAuth (Claude,
// ChatGPT) que ya se conecto una vez va a tener que re-autorizarse despues
// de un reinicio, porque el "issuer" que tenia guardado ya no responde.
// Si alguien quiere una URL fija para siempre, la alternativa es armar un
// tunel nombrado con su propio dominio (ver el README).

function iniciarCloudflared() {

  const rutaLocal =
    path.join(
      process.cwd(),
      "cloudflared.exe"
    );

  const ejecutable =
    fs.existsSync(rutaLocal)
      ? rutaLocal
      : "cloudflared";

  // --protocol http2: el default (QUIC) puede fallar en ciertas redes/routers.
  const cf =
    spawn(
      ejecutable,
      [
        "tunnel",
        "--url",
        `http://localhost:${PORT}`,
        "--protocol",
        "http2"
      ],
      {
        shell: false
      }
    );

  // Excluimos "api.trycloudflare.com": es el endpoint de control interno,
  // no el subdominio publico del tunel (que siempre trae varias palabras
  // separadas por guiones, ej: palabra-palabra-palabra.trycloudflare.com).
  const regexUrl =
    /https:\/\/(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com/;

  let avisoMostrado =
    false;

  const procesarSalida =
    (data) => {

      const texto =
        data.toString();

      for (
        const linea of
        texto.split("\n")
      ) {

        if (!linea.trim())
          continue;

        if (
          /\b(ERR|WRN)\b/.test(
            linea
          )
        ) {
          process.stderr.write(
            linea + "\n"
          );
        }
      }

      const match =
        texto.match(regexUrl);

      if (
        match &&
        !avisoMostrado
      ) {

        avisoMostrado = true;

        // Si el usuario fijo las URLs a mano por variable de entorno,
        // eso tiene prioridad y no se pisa con la URL random del tunel.
        if (
          !process.env.URL_PUBLICA_BASE
        ) {

          URL_PUBLICA_BASE =
            match[0];

          URL_PUBLICA_MCP =
            process.env.URL_PUBLICA ||
            `${URL_PUBLICA_BASE}/mcp`;

          URL_OAUTH_ISSUER =
            process.env.OAUTH_ISSUER ||
            URL_PUBLICA_BASE;
        }

        console.log(
          "\n=================================================="
        );

        console.log(
          " MCP publico:"
        );

        console.log(
          " " + URL_PUBLICA_MCP
        );

        console.log(
          "\n OAuth issuer:"
        );

        console.log(
          " " + URL_OAUTH_ISSUER
        );

        console.log(
          "\n OAuth metadata:"
        );

        console.log(
          " " +
          `${URL_OAUTH_ISSUER}/.well-known/oauth-authorization-server`
        );

        console.log(
          "\n (Esta URL cambia en cada reinicio -- ver README si queres una fija)"
        );

        console.log(
          "==================================================\n"
        );

        try {

          fs.writeFileSync(
            path.join(
              process.cwd(),
              "tunnel-url.txt"
            ),
            URL_PUBLICA_MCP,
            "utf8"
          );

        } catch {}
      }
    };

  cf.stdout.on(
    "data",
    procesarSalida
  );

  cf.stderr.on(
    "data",
    procesarSalida
  );

  cf.on(
    "error",
    (err) => {

      console.error(
        "No se pudo iniciar cloudflared. ¿Esta cloudflared.exe en la carpeta del proyecto? Error:",
        err.message
      );
    }
  );

  cf.on(
    "close",
    (code) => {

      console.log(
        `cloudflared se cerro (codigo ${code}).`
      );

      avisoMostrado = false;
    }
  );

  const limpiar =
    () => {

      if (
        cf &&
        !cf.killed
      ) {
        cf.kill();
      }
    };

  process.on(
    "exit",
    limpiar
  );

  process.on(
    "SIGINT",
    () => {

      limpiar();
      process.exit();
    }
  );

  return cf;
}

// ============================================================
// LIMPIEZA PERIODICA
// ============================================================

setInterval(
  () => {

    const ahora =
      Date.now();

    // Authorization codes
    for (
      const [
        hash,
        datos
      ]
      of oauthAuthorizationCodes
    ) {

      if (
        ahora >
        datos.expiresAt
      ) {
        oauthAuthorizationCodes.delete(
          hash
        );
      }
    }

    // Access tokens
    for (
      const [
        hash,
        datos
      ]
      of oauthAccessTokens
    ) {

      if (
        ahora >
        datos.expiresAt
      ) {
        oauthAccessTokens.delete(
          hash
        );
      }
    }

    // Refresh tokens
    for (
      const [
        hash,
        datos
      ]
      of oauthRefreshTokens
    ) {

      if (
        ahora >
        datos.expiresAt
      ) {
        oauthRefreshTokens.delete(
          hash
        );
      }
    }

    // CSRF
    for (
      const [
        hash,
        datos
      ]
      of oauthLoginRequests
    ) {

      if (
        ahora >
        datos.expiresAt
      ) {
        oauthLoginRequests.delete(
          hash
        );
      }
    }

    // Sesiones tradicionales
    for (
      const [
        token,
        expira
      ]
      of sesiones
    ) {

      if (
        ahora >
        expira
      ) {
        sesiones.delete(
          token
        );
      }
    }

  },
  60 * 1000
);

// ============================================================
// ARRANQUE
// ============================================================

async function iniciar() {

  // Usuario tradicional
  usuarioConfigurado =
    await configurarUsuarioSiHaceFalta();

  // Clientes OAuth registrados
  cargarOAuthPersistente();

  // Modulos:
  // - registrarRest()
  // - iniciar()
  //
  // registrarMcp() se ejecutara despues, dentro de
  // crearMcpServer(), para cada conexion MCP.

  await cargarModulos();

  app.listen(
    PORT,
    () => {

      console.log(
        `Servidor MCP local: http://localhost:${PORT}/mcp`
      );

      console.log(
        `MCP publico esperado: ${URL_PUBLICA_MCP}`
      );

      console.log(
        `OAuth issuer: ${URL_OAUTH_ISSUER}`
      );

      console.log(
        `OAuth metadata: ${URL_OAUTH_ISSUER}/.well-known/oauth-authorization-server`
      );

      console.log(
        "Iniciando tunel de cloudflared..."
      );

      iniciarCloudflared();
    }
  );
}

iniciar();