// modules/procesos/module.js
// Listar procesos y matarlos por nombre o PID (via PowerShell).
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

async function listar() {
  const { stdout } = await execFileP("powershell", [
    "-NoProfile", "-Command",
    "Get-Process | Sort-Object -Descending CPU | Select-Object -First 60 Id,ProcessName,CPU,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress",
  ]);
  const data = JSON.parse(stdout || "[]");
  return Array.isArray(data) ? data : [data];
}

async function matar({ nombre, pid }) {
  if (!nombre && !pid) throw new Error("hay que pasar 'nombre' o 'pid'");
  const cmd = pid
    ? `Stop-Process -Id ${Number(pid)} -Force`
    : `Stop-Process -Name "${String(nombre).replace(/"/g, '')}" -Force`;
  await execFileP("powershell", ["-NoProfile", "-Command", cmd]);
  return true;
}

export default {
  nombre: "procesos",
  info: { nombre: "procesos" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "listar_procesos",
      {
        title: "Listar procesos en ejecucion",
        description: "Devuelve los procesos corriendo (top 60 por uso de CPU) con su PID, nombre, CPU y memoria en MB.",
        inputSchema: { clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const procesos = await listar();
        return { content: [{ type: "text", text: JSON.stringify(procesos, null, 2) }] };
      }
    );

    server.registerTool(
      "matar_proceso",
      {
        title: "Terminar un proceso",
        description: "Termina (fuerza el cierre de) un proceso por nombre (ej. 'chrome') o por PID.",
        inputSchema: {
          nombre: z.string().optional(),
          pid: z.number().optional(),
          clave: z.string().optional(),
        },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        await matar(args);
        return { content: [{ type: "text", text: `Proceso ${args.nombre || args.pid} terminado.` }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/procesos", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json(await listar());
    });
    router.post("/procesos/matar", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      await matar(req.body || {});
      res.json({ ok: true });
    });
  },
};
