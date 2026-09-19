// modules/abrir/module.js
// Abrir un archivo o programa con su app predeterminada (tipo Start-Process).
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

async function abrir({ ruta, argumentos }) {
  const args = ["-NoProfile", "-Command", "Start-Process", "-FilePath", ruta];
  if (argumentos) {
    args.push("-ArgumentList", argumentos);
  }
  await execFileP("powershell", args);
  return true;
}

export default {
  nombre: "abrir",
  info: { nombre: "abrir" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "abrir",
      {
        title: "Abrir archivo o programa",
        description: "Abre un archivo con su aplicacion predeterminada, o lanza un programa por su ruta/nombre (ej. 'excel', 'C:\\\\ruta\\\\factura.pdf', 'notepad').",
        inputSchema: {
          ruta: z.string(),
          argumentos: z.string().optional().describe("Argumentos de linea de comandos a pasarle al programa, si aplica"),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        await abrir(args);
        return { content: [{ type: "text", text: `Abriendo: ${args.ruta}` }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.post("/abrir", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      await abrir(req.body || {});
      res.json({ ok: true });
    });
  },
};
