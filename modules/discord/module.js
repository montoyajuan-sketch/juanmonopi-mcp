// modules/discord/module.js
// Expone las herramientas de Discord (basadas en discord.js) como tools MCP.
//
// Configuracion (archivo modules/discord/.env, ver .env.example):
//   DISCORD_TOKEN              Token del bot (obligatorio)
//   DISCORD_ALLOWED_GUILDS     Opcional: limita el bot a ciertos servidores
//   DISCORD_LOG_CHANNEL_ID     Opcional: canal donde se registra cada tool ejecutada
//
// Dependencias propias de este modulo: antes de usarlo, corre una vez
//   npm install --omit=dev
// dentro de modules/discord. Si faltan, el modulo se desactiva solo y el
// resto del servidor arranca igual.

import path from "path";
import { z } from "zod";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let getAllDefinitions, getAllSchemas, handleTool, ensureConnected, discord;
let errorCarga = null;

try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(__dirname, ".env") });
  dotenv.config();

  ({ getAllDefinitions, getAllSchemas, handleTool } = await import("./src/tools/index.ts"));
  ({ ensureConnected, discord } = await import("./src/client.ts"));
} catch (err) {
  errorCarga = err;
  console.warn(
    "[discord] Modulo desactivado: " + (err?.message || err) +
      "\n[discord] Revisa que hayas corrido 'npm install --omit=dev' en modules/discord y que exista modules/discord/.env con DISCORD_TOKEN.",
  );
}

const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID || "";

function parametrosParaLog(args) {
  const limpio = { ...(args || {}) };
  delete limpio.clave;

  for (const key of Object.keys(limpio)) {
    if (/token|password|contrasena|secret|authorization|webhook/i.test(key)) {
      limpio[key] = "[REDACTADO]";
    }
  }

  let texto;
  try {
    texto = JSON.stringify(limpio, null, 2);
  } catch {
    texto = String(limpio);
  }

  if (!texto || texto === "{}") texto = "(sin parametros)";
  return texto;
}

async function registrarLogMcp(nombreTool, args, resultado) {
  if (!LOG_CHANNEL_ID) return;

  try {
    const canal = await discord.channels.fetch(LOG_CHANNEL_ID);
    if (!canal || !canal.isTextBased()) return;

    const estado = resultado?.isError ? "❌ ERROR" : "✅";
    const mensaje =
      `${estado} El bot ejecutó \`${nombreTool}\` con parametros:\n` +
      "```json\n" +
      parametrosParaLog(args) +
      "\n```";

    await canal.send(mensaje.slice(0, 1990));
  } catch (logError) {
    console.error("[discord] No se pudo escribir en el canal de logs:", logError?.message || logError);
  }
}

export default {
  nombre: "discord",

  registrarMcp(mcp, { verificarAcceso, errorClave } = {}) {
    if (errorCarga) return;

    const schemas = getAllSchemas();

    for (const tool of getAllDefinitions()) {
      const rawSchema = schemas.get(tool.name);
      if (!rawSchema) throw new Error(`No Zod schema found for Discord tool: ${tool.name}`);

      // El MCP principal puede anadir "clave" a cualquier llamada. Hay que
      // aceptarlo en la validacion del SDK y quitarlo antes de ejecutar Discord.
      const inputSchema = typeof rawSchema.extend === "function"
        ? rawSchema.extend({ clave: z.string().optional() })
        : rawSchema;

      mcp.registerTool(tool.name, {
        title: tool.annotations?.title || tool.name,
        description: tool.description,
        inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }, async (args) => {
        // Mismo control de acceso que el resto de las herramientas del servidor.
        if (verificarAcceso && !(await verificarAcceso(args?.clave))) return errorClave();

        try {
          await ensureConnected();

          const discordArgs = { ...(args || {}) };
          delete discordArgs.clave;

          const resultado = await handleTool(tool.name, discordArgs);
          await registrarLogMcp(tool.name, discordArgs, resultado);
          return resultado;
        } catch (err) {
          const resultadoError = {
            content: [{
              type: "text",
              text: `Discord: ${err?.message || String(err)}`,
            }],
            isError: true,
          };

          await registrarLogMcp(tool.name, args, resultadoError);
          return resultadoError;
        }
      });
    }
  },

  async detener() {
    try { discord?.destroy(); } catch {}
  },
};
