// modules/info_sistema/module.js
// CPU, RAM, disco, bateria y uptime, todo via una sola llamada a PowerShell/CIM.
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

const SCRIPT = `
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$ramTotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,2)
$ramLibreGB = [math]::Round($os.FreePhysicalMemory/1MB,2)
$uptimeSeg = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
$discos = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [PSCustomObject]@{
    unidad = $_.DeviceID
    totalGB = [math]::Round($_.Size/1GB,1)
    libreGB = [math]::Round($_.FreeSpace/1GB,1)
  }
}
$bateria = Get-CimInstance Win32_Battery | Select-Object -First 1
$resultado = [PSCustomObject]@{
  cpuPorcentaje = $cpu
  ramTotalGB = $ramTotalGB
  ramUsadaGB = [math]::Round($ramTotalGB - $ramLibreGB,2)
  uptimeSegundos = $uptimeSeg
  discos = $discos
  bateriaPorcentaje = if ($bateria) { $bateria.EstimatedChargeRemaining } else { $null }
  bateriaCargando = if ($bateria) { $bateria.BatteryStatus -eq 6 } else { $null }
}
$resultado | ConvertTo-Json -Compress -Depth 4
`;

async function obtener() {
  const { stdout } = await execFileP("powershell", ["-NoProfile", "-Command", SCRIPT]);
  return JSON.parse(stdout);
}

export default {
  nombre: "info_sistema",
  info: { nombre: "info_sistema" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "info_sistema",
      {
        title: "Estado del sistema",
        description: "Devuelve uso de CPU (%), RAM (GB usados/total), espacio libre por disco, bateria (si hay) y tiempo desde el ultimo arranque.",
        inputSchema: { clave: z.string().optional() },
      },
      async (args) => {
        if (!(await verificarAcceso(args.clave))) return errorClave();
        const info = await obtener();
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/info_sistema", async (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json(await obtener());
    });
  },
};
