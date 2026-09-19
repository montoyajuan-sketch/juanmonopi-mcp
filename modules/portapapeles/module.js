// modules/portapapeles/module.js
// Leer/escribir el clipboard de Windows via PowerShell (Get-Clipboard / Set-Clipboard).
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

async function leer() {
  const { stdout } = await execFileP("powershell", [
    "-NoProfile", "-Command", "Get-Clipboard -Raw",
  ]);
  return stdout.replace(/\r?\n$/, "");
}

async function escribir(texto) {
  // Pasamos el texto por stdin en vez de como argumento, para evitar
  // problemas de escaping con comillas/caracteres especiales.
  await new Promise((resolve, reject) => {
    const ps = spawn("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]);
    ps.stdin.write(texto ?? "");
    ps.stdin.end();
    ps.on("error", reject);
    ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Set-Clipboard fallo, codigo " + code))));
  });
}

export default {
  nombre: "portapapeles",
  info: { nombre: "portapapeles" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "leer_portapapeles",
      {
        title: "Leer el portapapeles",
        description: "Devuelve el texto actualmente copiado en el portapapeles de Windows.",
        inputSchema: { clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const texto = await leer();
        return { content: [{ type: "text", text: texto }] };
      }
    );

    server.registerTool(
      "escribir_portapapeles",
      {
        title: "Escribir en el portapapeles",
        description: "Copia el texto dado al portapapeles de Windows (como si hicieras Ctrl+C de ese texto).",
        inputSchema: { texto: z.string(), clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        await escribir(args.texto);
        return { content: [{ type: "text", text: "Copiado al portapapeles." }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/portapapeles", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json({ texto: await leer() });
    });
    router.post("/portapapeles", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      await escribir(req.body?.texto ?? "");
      res.json({ ok: true });
    });
  },
};
