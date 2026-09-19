// modules/volumen/module.js
//
// Sin instalar nada extra (nircmd, pycaw, etc), la forma confiable de tocar
// el volumen maestro desde PowerShell es simular las teclas multimedia de
// verdad via keybd_event de user32 -- por eso esto sube/baja en pasos en
// vez de fijar un porcentaje exacto. Si en algun momento hace falta un
// numero preciso, hay que sumar pycaw (Python) o nircmd.exe.

import { z } from "zod";
import { ejecutarPS } from "../_shared/ps.js";

const VK = {
  subir: 0xaf, // VK_VOLUME_UP
  bajar: 0xae, // VK_VOLUME_DOWN
  mutear: 0xad, // VK_VOLUME_MUTE (toggle)
};

function scriptParaTecla(vk, veces) {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VolumenHelper {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
for ($i = 0; $i -lt ${veces}; $i++) {
  [VolumenHelper]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
  [VolumenHelper]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
`;
}

export default {
  nombre: "volumen",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "volumen",
      {
        title: "Control de volumen",
        description:
          "Sube, baja o mutea/desmutea el volumen maestro de Windows. 'pasos' controla cuánto (cada paso es un 'click' de volumen del sistema, típicamente ~2%).",
        inputSchema: {
          accion: z.enum(["subir", "bajar", "mutear"]),
          pasos: z.number().optional(),
          clave: z.string().optional(),
        },
      },
      async ({ accion, pasos, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          const veces = accion === "mutear" ? 1 : pasos || 2;
          await ejecutarPS(scriptParaTecla(VK[accion], veces));
          return {
            content: [
              {
                type: "text",
                text:
                  accion === "mutear"
                    ? "Mute alternado (si estaba mudo, ahora suena; y viceversa)."
                    : `Volumen ${accion === "subir" ? "subido" : "bajado"} (${veces} pasos).`,
              },
            ],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }
      },
    );
  },
};
