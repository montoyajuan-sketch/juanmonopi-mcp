// modules/red/module.js
// IP actual, ping a un host, y chequeo de puerto abierto. Util para
// diagnosticar el propio tunel/servidor si algo falla.
import { z } from "zod";
import os from "os";
import net from "net";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

function ipsLocales() {
  const ifaces = os.networkInterfaces();
  const resultado = [];
  for (const [nombre, direcciones] of Object.entries(ifaces)) {
    for (const dir of direcciones || []) {
      if (dir.family === "IPv4" && !dir.internal) {
        resultado.push({ interfaz: nombre, ip: dir.address });
      }
    }
  }
  return resultado;
}

async function ping(host, intentos = 4) {
  try {
    const { stdout } = await execFileP("ping", ["-n", String(intentos), host]);
    const perdidaMatch = stdout.match(/\((\d+)% perdidos?\)|\((\d+)% loss\)/i);
    const tiempoMatch = stdout.match(/Media\s*=\s*(\d+)ms|Average\s*=\s*(\d+)ms/i);
    return {
      alcanzable: !stdout.toLowerCase().includes("100% loss") && !stdout.includes("100% perdidos"),
      porcentajePerdida: perdidaMatch ? Number(perdidaMatch[1] || perdidaMatch[2]) : null,
      msPromedio: tiempoMatch ? Number(tiempoMatch[1] || tiempoMatch[2]) : null,
      salidaCruda: stdout,
    };
  } catch (err) {
    return { alcanzable: false, error: err.message };
  }
}

function puertoAbierto(host, puerto, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let listo = false;
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { listo = true; socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); if (!listo) resolve(false); });
    socket.once("error", () => { if (!listo) resolve(false); });
    socket.connect(puerto, host);
  });
}

export default {
  nombre: "red",
  info: { nombre: "red" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "red_info",
      {
        title: "IP local actual",
        description: "Devuelve las IPs locales (IPv4) de la PC.",
        inputSchema: { clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        return { content: [{ type: "text", text: JSON.stringify(ipsLocales(), null, 2) }] };
      }
    );

    server.registerTool(
      "red_ping",
      {
        title: "Hacer ping a un host",
        description: "Hace ping a un host/IP y devuelve si respondio, % de perdida y latencia promedio.",
        inputSchema: { host: z.string(), clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const resultado = await ping(args.host);
        return { content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }] };
      }
    );

    server.registerTool(
      "red_puerto",
      {
        title: "Chequear si un puerto esta abierto",
        description: "Intenta conectarse a host:puerto y devuelve true/false segun si esta abierto/alcanzable.",
        inputSchema: { host: z.string(), puerto: z.number(), clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const abierto = await puertoAbierto(args.host, args.puerto);
        return { content: [{ type: "text", text: abierto ? "abierto" : "cerrado/no alcanzable" }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/red/info", (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json(ipsLocales());
    });
    router.get("/red/ping", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json(await ping(req.query.host));
    });
    router.get("/red/puerto", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json({ abierto: await puertoAbierto(req.query.host, Number(req.query.puerto)) });
    });
  },
};
