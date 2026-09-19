// modules/listar_ventanas/module.js
import { z } from "zod";
import { ejecutarPS } from "../_shared/ps.js";

const SCRIPT_VENTANA_ACTIVA = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class VentanaActivaHelper {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [VentanaActivaHelper]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[VentanaActivaHelper]::GetWindowText($h, $sb, 256) | Out-Null
$sb.ToString()
`;

export default {
  nombre: "listar_ventanas",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "listar_ventanas",
      {
        title: "Listar ventanas abiertas",
        description: "Lista las ventanas abiertas actualmente (PID, proceso, título de la ventana).",
        inputSchema: { clave: z.string().optional() },
      },
      async ({ clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          const raw = await ejecutarPS(
            `Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress`,
          );
          const datos = raw.trim() ? JSON.parse(raw) : [];
          const lista = Array.isArray(datos) ? datos : [datos];
          if (!lista.length) return { content: [{ type: "text", text: "No hay ventanas con título visible." }] };
          const texto = lista.map((v) => `${v.Id}\t${v.ProcessName}\t${v.MainWindowTitle}`).join("\n");
          return { content: [{ type: "text", text: `PID\tProceso\tTítulo\n${texto}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );

    server.registerTool(
      "ventana_activa",
      {
        title: "Ventana activa",
        description: "Devuelve el título de la ventana que tiene el foco en este momento.",
        inputSchema: { clave: z.string().optional() },
      },
      async ({ clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          const titulo = await ejecutarPS(SCRIPT_VENTANA_ACTIVA);
          return { content: [{ type: "text", text: titulo.trim() || "(sin título)" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  },
};
