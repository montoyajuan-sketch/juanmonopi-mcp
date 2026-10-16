# Module API

> Esta es la guía principal. Para la referencia exacta, con el comportamiento verificado contra el código, ver [`MODULE_API_DETAILED.md`](MODULE_API_DETAILED.md).


Guía completa para escribir un **conector** (en el código se llama *módulo*): una carpeta dentro de `modules/` que agrega herramientas al servidor MCP, rutas REST o ajustes configurables desde el panel de configuración.

> En esta guía "conector" y "módulo" significan lo mismo. El servidor no distingue nada más: cualquier carpeta de `modules/` con un `module.js` se carga sola.

## Índice

1. [Qué es un conector](#1-qué-es-un-conector)
2. [Tu primer conector en 5 minutos](#2-tu-primer-conector-en-5-minutos)
3. [Estructura de la carpeta](#3-estructura-de-la-carpeta)
4. [Ciclo de vida: cómo carga el servidor un módulo](#4-ciclo-de-vida-cómo-carga-el-servidor-un-módulo)
5. [El objeto que exporta `module.js`](#5-el-objeto-que-exporta-modulejs)
6. [Herramientas MCP (`registrarMcp`)](#6-herramientas-mcp-registrarmcp)
7. [Rutas REST (`registrarRest`)](#7-rutas-rest-registrarrest)
8. [Servicios propios y puertos (`iniciar`)](#8-servicios-propios-y-puertos-iniciar)
9. [Ajustes configurables: `configuracion.json`](#9-ajustes-configurables-configuracionjson)
10. [Cómo se ven los ajustes en el panel](#10-cómo-se-ven-los-ajustes-en-el-panel)
11. [Referencia de la API del panel](#11-referencia-de-la-api-del-panel)
12. [Referencia de `configuracion.js` (API de JavaScript)](#12-referencia-de-configuracionjs-api-de-javascript)
13. [`config.json` y variables de entorno](#13-configjson-y-variables-de-entorno)
14. [Dependencias: Node, Python y binarios externos](#14-dependencias-node-python-y-binarios-externos)
15. [Seguridad y buenas prácticas](#15-seguridad-y-buenas-prácticas)
16. [Probar y depurar](#16-probar-y-depurar)
17. [Publicar tu conector](#17-publicar-tu-conector)
18. [Errores frecuentes](#18-errores-frecuentes)
19. [Referencia rápida](#19-referencia-rápida)

---

## 1. Qué es un conector

Un conector puede aportar cualquiera de estas tres cosas (o varias a la vez):

| Aporta | Cómo | Quién lo usa |
| ------ | ---- | ------------ |
| **Herramientas MCP** | `registrarMcp(server, ctx)` | Claude, ChatGPT y cualquier cliente MCP |
| **Rutas REST** | `registrarRest(router, ctx)` bajo `/api/...` | Tu frontend o Worker, protegido con API key |
| **Un servicio propio** | `iniciar(puerto)` | El propio módulo (por ejemplo un worker en Python) |

Además, puede declarar **ajustes** (`configuracion.json`) y el panel de configuración dibuja el formulario solo: tokens, números, interruptores y listas, con validación y guardado en `modules/<nombre>/.env`.

```
Cliente MCP ──► POST /mcp ──► McpServer ──► herramientas del servidor + de cada módulo
Tu frontend ──► /api/...  ──► apiRouter ──► rutas REST de cada módulo
Tú ───────────► localhost:3100 ► panel ───► ajustes de cada módulo (.env)
```

---

## 2. Tu primer conector en 5 minutos

Un conector `saludo` con una herramienta, una ruta REST y dos ajustes.

**`modules/saludo/module.js`**

```js
import { z } from "zod";

// Los ajustes llegan por process.env (ver configuracion.json).
// Si el usuario no los tocó, el .env no existe: aplica tus valores por defecto aquí.
const frase = () => process.env.SALUDO_FRASE || "Hola";
const gritar = () => process.env.SALUDO_GRITAR === "true";

function saludar(nombre) {
  const texto = `${frase()}, ${nombre}`;
  return gritar() ? texto.toUpperCase() + "!" : texto;
}

export default {
  nombre: "saludo",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "saludo_decir_hola",
      {
        title: "Saludar",
        description: "Devuelve un saludo para la persona indicada.",
        inputSchema: {
          nombre: z.string().describe("A quién saludar"),
          clave: z.string().optional(), // la inyecta el servidor, ver sección 6
        },
      },
      async ({ nombre, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        return { content: [{ type: "text", text: saludar(nombre) }] };
      },
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/saludo/:nombre", (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) {
        return res.status(401).json({ error: "API key invalida" });
      }
      res.json({ saludo: saludar(req.params.nombre) });
    });
  },
};
```

**`modules/saludo/configuracion.json`**

```json
{
  "titulo": "Saludo",
  "descripcion": "Personaliza cómo saluda el conector.",
  "campos": [
    {
      "clave": "SALUDO_FRASE",
      "etiqueta": "Frase de saludo",
      "tipo": "texto",
      "predeterminado": "Hola",
      "longitudMax": 60,
      "ayuda": "Lo que se dice antes del nombre."
    },
    {
      "clave": "SALUDO_GRITAR",
      "etiqueta": "Gritar",
      "tipo": "booleano",
      "predeterminado": false,
      "ayuda": "Devuelve el saludo en mayúsculas."
    }
  ]
}
```

Reinicia el servidor. Verás `Modulo cargado: saludo` en la consola, la herramienta `saludo_decir_hola` en tu cliente MCP y un bloque **Saludo** en *Configuración → Módulos*.

---

## 3. Estructura de la carpeta

```
modules/
└── mi_conector/
    ├── module.js            ← OBLIGATORIO. Sin este archivo la carpeta se ignora.
    ├── configuracion.json   ← opcional. Ajustes que edita el panel.
    ├── .env                 ← lo escribe el panel (no se versiona).
    ├── module_info.json     ← opcional. Documentación del módulo (ver abajo).
    ├── package.json         ← opcional. Dependencias de Node propias del módulo.
    ├── main.py              ← opcional. Worker en Python.
    ├── requirements.txt     ← opcional. Dependencias del worker.
    └── vendor/ venv/        ← generados por el instalador (no se versionan).
```

Reglas del cargador:

- Se carga **toda carpeta de `modules/` que tenga `module.js`**, en orden alfabético del sistema de archivos.
- Una carpeta **sin `module.js` se ignora**. Por eso `modules/_shared/` (utilidades) no es un módulo. Usa el prefijo `_` para carpetas auxiliares.
- El **nombre de la carpeta** es el identificador del módulo para el panel (`config.json`, `.env`, el interruptor de activar/desactivar). Usa solo letras, números, `_` y `-` (máximo 64).
- `module.js` es un módulo ES (`import`/`export default`), igual que el resto del proyecto.

`module_info.json` no lo usa el cargador. Es una convención para documentar el módulo (nombre, versión, funciones, dependencias) y algunos módulos lo leen ellos mismos. El panel solo usa su campo `descripcion` (texto de hasta 160 caracteres) para mostrar una línea bajo el interruptor en *Módulos*.

---

## 4. Ciclo de vida: cómo carga el servidor un módulo

Al arrancar, `index.js` hace esto, en este orden:

1. Lee `config.json` y descarta las carpetas que aparezcan en `modulos.deshabilitados` (los interruptores del panel).
2. Para cada carpeta restante con `module.js`:
   1. Si tiene `configuracion.json` válido, carga su `.env` en `process.env` (solo las claves declaradas y sin pisar variables que ya existan).
   2. Importa `module.js` y toma su `export default`.
3. Para cada módulo cargado, en orden:
   1. Llama a `registrarRest(apiRouter, { verificarApiKey })` si existe.
   2. Si existe `iniciar`, pide un puerto libre del rango 9000–9999 y llama a `await iniciar(puerto)`.
   3. Imprime `Modulo cargado: <nombre> (puerto N)`.

Después, **en cada petición `POST /mcp`** el servidor crea un `McpServer` nuevo y llama a `registrarMcp(server, { verificarAcceso, errorClave })` de cada módulo. Consecuencias importantes:

- `registrarMcp` se ejecuta **muchas veces**. Debe ser rápido y no tener efectos secundarios: nada de abrir conexiones, leer archivos pesados ni arrancar procesos ahí dentro. Pon el estado y las conexiones a nivel de módulo (fuera de la función) o en `iniciar`.
- Los valores de `process.env` se leen en el momento de usarlos (dentro de los manejadores), no al importar, si quieres que reflejen la configuración vigente.

Si `module.js` **lanza una excepción al importarse, el arranque entero falla**. Si tu módulo depende de algo que puede faltar (un paquete sin instalar, una variable obligatoria), atrapa el error y desactívate sin tirar el servidor, como hace el módulo de Discord:

```js
let errorCarga = null;
try {
  ({ algo } = await import("./src/algo.js"));
} catch (err) {
  errorCarga = err;
  console.warn("[mi_conector] Módulo desactivado:", err.message);
}

export default {
  nombre: "mi_conector",
  registrarMcp(server, ctx) {
    if (errorCarga) return; // no registra nada
    /* ... */
  },
};
```

> Los cambios en `module.js`, `configuracion.json` o `.env` se aplican **al reiniciar el servidor** (botón *Reiniciar* del panel o cerrar y abrir `iniciar.bat`).

---

## 5. El objeto que exporta `module.js`

```js
export default {
  nombre: "mi_conector",
  registrarMcp(server, { verificarAcceso, errorClave }) { /* ... */ },
  registrarRest(router, { verificarApiKey }) { /* ... */ },
  async iniciar(puerto) { /* ... */ },
};
```

| Propiedad | Obligatoria | La usa el servidor | Para qué |
| --------- | :---------: | :----------------: | -------- |
| `nombre` | Sí | Sí | Aparece en el log `Modulo cargado: ...`. Usa el mismo texto que la carpeta. |
| `registrarMcp(server, ctx)` | No | Sí | Registra herramientas MCP. Ver [sección 6](#6-herramientas-mcp-registrarmcp). |
| `registrarRest(router, ctx)` | No | Sí | Registra rutas bajo `/api`. Ver [sección 7](#7-rutas-rest-registrarrest). |
| `iniciar(puerto)` | No | Sí | Levanta un servicio propio. Ver [sección 8](#8-servicios-propios-y-puertos-iniciar). |
| `info` | No | No | Convención: `info: { nombre: "..." }` o el contenido de `module_info.json`. |
| `detener()` | No | **No** | El servidor **no** la llama hoy. Si abres procesos, límpialos tú con `process.on("exit", ...)`. |

---

## 6. Herramientas MCP (`registrarMcp`)

```js
registrarMcp(server, { verificarAcceso, errorClave }) {
  server.registerTool(nombre, definicion, manejador);
}
```

`server` es un `McpServer` del SDK oficial (`@modelcontextprotocol/sdk`). `ctx` trae dos funciones:

| Función | Qué hace |
| ------- | -------- |
| `await verificarAcceso(clave)` | `true` si `clave` es una sesión válida. Llámala **siempre** al inicio del manejador. |
| `errorClave()` | Devuelve la respuesta de error estándar ("Sesion invalida, expirada o faltante.") para que la devuelvas tal cual. |

### El parámetro `clave`

Cuando un cliente se conecta por OAuth, el servidor **inyecta la sesión en `arguments.clave`** de cada llamada a herramienta. Por eso:

1. Declara `clave: z.string().optional()` en el `inputSchema` de **todas** tus herramientas. Si no lo declaras, el SDK descarta el campo al validar y `verificarAcceso(undefined)` siempre fallará.
2. Empieza cada manejador con `if (!(await verificarAcceso(clave))) return errorClave();`.
3. No pidas `clave` en la `description`: el modelo no tiene que saberlo en OAuth. (Con el inicio de sesión tradicional, el modelo la obtiene de la herramienta `iniciar_sesion`.)

### Definición de la herramienta

```js
server.registerTool(
  "mi_conector_buscar",                 // nombre único, ver abajo
  {
    title: "Buscar cosas",              // nombre legible
    description: "Busca X en Y. Devuelve Z.",  // lo que lee el modelo: sé concreto
    inputSchema: {                      // forma plana de zod: { campo: zod }
      consulta: z.string().min(1).max(200).describe("Texto a buscar"),
      limite: z.number().int().min(1).max(50).default(10),
      clave: z.string().optional(),
    },
    annotations: {                      // opcional: pistas para el cliente
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async ({ consulta, limite, clave }) => {
    if (!(await verificarAcceso(clave))) return errorClave();
    /* ...trabajo... */
    return { content: [{ type: "text", text: "resultado" }] };
  },
);
```

### Valores de retorno

```js
// Texto
{ content: [{ type: "text", text: "..." }] }

// Varios bloques (texto + imagen en base64)
{ content: [
  { type: "text", text: "Captura tomada" },
  { type: "image", data: "<base64>", mimeType: "image/png" },
] }

// Error que el modelo puede leer y corregir
{ content: [{ type: "text", text: "No existe esa ruta" }], isError: true }
```

Los datos estructurados se devuelven como texto: `JSON.stringify(objeto)` (o `JSON.stringify(objeto, null, 2)` para que sea legible).

### Nombres de herramientas

Los nombres son **globales y únicos**: si dos herramientas se llaman igual (de módulos distintos o del servidor), el SDK lanza un error al registrarlas y las peticiones `/mcp` dejan de funcionar.

- **Prefija con el nombre de tu conector**: `mi_conector_buscar`, no `buscar`.
- Usa solo `a-z`, `0-9` y `_` (minúsculas con guion bajo es lo que usa el resto del proyecto).
- Nombres que ya existen y no puedes usar: `iniciar_sesion`, `cerrar_sesion`, `listar_archivos`, `leer_archivo`, `crear_archivo`, `editar_archivo`, `eliminar_archivo`, `eliminar_carpeta`, `crear_carpeta`, `renombrar`, `info_archivo`, `descargar_archivo`, `descargar_carpeta`, `subir_archivo`, `subir_carpeta`, `iniciar_shell`, `listar_shells`, `enviar_comando`, `leer_salida_shell`, `esperar_salida`, `detener_shell`, `abrir`, `buscar_archivos`, `capturar_pantalla`, `control_remoto`, `verificar_coordenada`, `convertir_archivo`, `escaneres`, `escanear_documento`, `impresoras`, `imprimir_archivo`, `info_sistema`, `listar_ventanas`, `ventana_activa`, `notificar`, `notificar_progreso_crear`, `notificar_progreso_actualizar`, `notificar_finalizar`, `reconocer_texto_ocr`, `leer_portapapeles`, `escribir_portapapeles`, `listar_procesos`, `matar_proceso`, `red_info`, `red_ping`, `red_puerto`, `volumen` y todas las de Discord.

### Cómo escribir buenas herramientas

- **Una acción por herramienta**, con nombre de verbo (`..._listar`, `..._crear`).
- **`description` útil**: qué hace, qué devuelve y límites. El modelo decide con ese texto cuándo usarla.
- **Valida con zod** (`min`, `max`, `enum`, `int`). Nunca confíes en lo que llega.
- **Limita el tamaño de la salida** (por ejemplo 100 000 caracteres) y avisa cuando recortes.
- **Errores con `isError: true`** y un mensaje accionable, en vez de lanzar excepciones.
- **Timeouts** en todo lo que espere a algo externo (red, procesos).

---

## 7. Rutas REST (`registrarRest`)

```js
registrarRest(router, { verificarApiKey }) {
  router.get("/mi_conector/estado", (req, res) => {
    if (!verificarApiKey(req.headers["x-api-key"])) {
      return res.status(401).json({ error: "API key invalida" });
    }
    res.json({ ok: true });
  });
}
```

- `router` es un `express.Router()` montado en **`/api`**: la ruta `/mi_conector/estado` queda en `GET /api/mi_conector/estado`.
- El cuerpo JSON se lee con `express.json` (límite 40 MB), así que `req.body` ya viene como objeto. Los formularios `application/x-www-form-urlencoded` también se leen.
- Estas rutas **salen por el túnel** igual que `/mcp`: cualquiera que conozca la URL puede llamarlas. **Exige siempre la API key** con `verificarApiKey(req.headers["x-api-key"])`.
- La API key es la de *Configuración → Seguridad*. Está en `apikey.json`; se genera sola la primera vez.
- Prefija las rutas con el nombre de tu módulo para no chocar con otras (`/api/mi_conector/...`).
- Maneja errores con `try/catch` y responde `res.status(500).json({ error: err.message })`; un `throw` sin atrapar dentro de un manejador async no llega a Express.

---

## 8. Servicios propios y puertos (`iniciar`)

Si tu módulo necesita un proceso aparte (un worker en Python, un servidor local), define `iniciar(puerto)`. El servidor te asigna un **puerto libre entre 9000 y 9999** (`modules/registro.js`), distinto para cada módulo. **No fijes puertos a mano.**

```js
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { resolverPython } from "../_shared/python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let PUERTO = null;
let worker = null;

async function asegurarWorker() {
  try {
    const r = await fetch(`http://127.0.0.1:${PUERTO}/salud`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return;
  } catch {}
  if (worker) return;

  worker = spawn(resolverPython(__dirname), ["main.py", "--puerto", String(PUERTO)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => console.log(`[mi_conector] ${d.toString().trim()}`));
  worker.stderr.on("data", (d) => console.error(`[mi_conector:err] ${d.toString().trim()}`));
  worker.on("close", () => { worker = null; });
  process.on("exit", () => worker?.kill());

  await new Promise((r) => setTimeout(r, 1500));
}

export default {
  nombre: "mi_conector",
  async iniciar(puerto) {
    PUERTO = puerto;
    await asegurarWorker();
  },
  /* registrarMcp ... usa asegurarWorker() antes de cada llamada */
};
```

Consejos:

- Haz que el worker escuche solo en **`127.0.0.1`**, nunca en `0.0.0.0`.
- Recibe el puerto por argumento (`--puerto N`) y ofrece una ruta `/salud` para comprobar que está vivo.
- Si falla al arrancar, no tires el servidor: registra el error y responde con `isError: true` cuando alguien use la herramienta.
- `modules/_shared/python.js` (`resolverPython`) elige el Python correcto: el embebido del proyecto (`python-embed`), un `venv` del módulo o el del sistema. `modules/_shared/ps.js` (`ejecutarPS`, `limpiarParaPS`, `aBase64`) ayuda a lanzar PowerShell de forma segura.

---

## 9. Ajustes configurables: `configuracion.json`

Para que un ajuste (token, puerto, idioma…) se edite desde el panel, declara el campo en `modules/<nombre>/configuracion.json`. **No hace falta tocar el panel ni escribir HTML.**

### Cómo funciona

1. El panel lee `configuracion.json` y dibuja un formulario.
2. El servidor del panel **valida** cada valor con las reglas del campo (tipo, rango, patrón, longitud).
3. Los valores se guardan en **`modules/<nombre>/.env`** (una línea `CLAVE=valor` por ajuste).
4. Al arrancar, antes de importar tu `module.js`, el servidor carga ese `.env` en `process.env`. Lees tus ajustes con `process.env.MI_CLAVE`.

Solo se cargan las claves **declaradas** en `configuracion.json`, y **nunca pisan** una variable de entorno que ya exista (las de la consola o el sistema tienen prioridad).

### Estructura del archivo

```json
{
  "titulo": "Mi conector",
  "descripcion": "Frase corta bajo el título.",
  "campos": [ /* de 1 a 50 campos */ ]
}
```

| Propiedad | Tipo | Obligatoria | Descripción |
| --------- | ---- | :---------: | ----------- |
| `titulo` | texto (máx. 60) | No | Encabezado del bloque. Por defecto, el nombre de la carpeta. |
| `descripcion` | texto (máx. 300) | No | Párrafo bajo el título. |
| `campos` | lista (1–50) | Sí | Los ajustes. |

### Propiedades de cada campo

| Propiedad | Tipos | Obligatoria | Descripción |
| --------- | ----- | :---------: | ----------- |
| `clave` | todos | Sí | Nombre de la variable: `MAYÚSCULAS`, números y `_`, empieza con letra, máx. 64. Sin repetir. **Prefija con tu módulo** (`MICONECTOR_TOKEN`). |
| `etiqueta` | todos | Sí | Texto visible (máx. 80). |
| `tipo` | todos | No | `texto` (por defecto), `secreto`, `numero`, `booleano` u `opcion`. |
| `ayuda` | todos | No | Texto de apoyo bajo la etiqueta (máx. 300). |
| `placeholder` | texto, secreto, numero | No | Texto de ejemplo dentro del campo (máx. 100). |
| `obligatorio` | todos | No | `true` para marcarlo con `*` y exigir valor (ver reglas abajo). |
| `predeterminado` | todos menos `secreto` | No | Valor inicial que muestra el panel. **No se escribe en el `.env`.** |
| `longitudMax` | texto, secreto | No | Máximo de caracteres (1–4096, por defecto 500). |
| `patron` | texto, secreto | No | Expresión regular (sin `/`), máx. 300. Se evalúa sobre el valor ya recortado y **no se ancla solo**: acepta coincidencias parciales, así que usa `^...$` para exigir coincidencia completa. |
| `mensajePatron` | texto, secreto | No | Mensaje de error si no cumple el patrón (máx. 200). |
| `quitarEspacios` | texto, secreto | No | `true` quita **todos** los espacios antes de validar (útil para listas de IDs). |
| `min`, `max` | numero | No | Límites inclusivos. |
| `opciones` | opcion | Sí | Lista de 1–50: `"valor"` o `{ "valor": "es", "etiqueta": "Español" }`. |

### Tipos de campo

| Tipo | Control en el panel | Qué se guarda en `.env` | Cómo lo lees |
| ---- | ------------------- | ----------------------- | ------------ |
| `texto` | Caja de texto | El texto | `process.env.X` |
| `secreto` | Caja oculta con botón de ver y de borrar | El texto | `process.env.X` |
| `numero` | Caja numérica | El número como texto (`9000`) | `Number(process.env.X)` |
| `booleano` | Interruptor | `true` o `false` | `process.env.X === "true"` |
| `opcion` | Lista desplegable | El `valor` elegido | `process.env.X` |

Comportamientos que conviene conocer:

- **Secretos**: el servidor del panel **nunca los devuelve al navegador**; solo informa si hay uno guardado. Dejar el campo vacío al guardar **conserva** el valor; para quitarlo se usa el botón *Borrar*.
- **Texto vacío** al guardar **borra** la línea del `.env` (vuelve a "sin valor").
- **Valores raros**: si el valor tiene espacios, `#` o comillas, se escribe entre comillas para que `dotenv` lo lea igual. Un valor que mezcla comillas simples y dobles se rechaza. Los saltos de línea nunca se aceptan, así que no se puede inyectar otra variable.
- **`predeterminado`**: solo lo muestra el panel (placeholder, interruptor o lista). Si el usuario no cambia nada, el `.env` no existe y `process.env.X` es `undefined`. **Tu código debe aplicar el mismo valor por defecto**: `process.env.X ?? "valor"`.
- **`obligatorio`**: en el asistente de primera vez exige valor al activar el módulo. En el panel solo impide *vaciar* un campo que ya tenía valor; así un módulo sin configurar no bloquea el guardado de los demás. Tu módulo debe tolerar que falte (por ejemplo, desactivarse con un aviso).
- **Claves reservadas**: no puedes declarar variables del sistema o del servidor (`PATH`, `NODE_OPTIONS`, `PORT`, `HTTP_PROXY`, `TUNNEL_TOKEN`, `CONFIG_ABRIR`…). El archivo se considera inválido.
- Si `configuracion.json` es **inválido**, el servidor lo ignora, imprime en consola qué campo falló y el módulo funciona sin formulario.

### Ejemplo con todos los tipos

```json
{
  "titulo": "Traductor",
  "descripcion": "Conecta el módulo con tu servicio de traducción.",
  "campos": [
    {
      "clave": "TRADUCTOR_API_KEY",
      "etiqueta": "API key",
      "tipo": "secreto",
      "obligatorio": true,
      "patron": "^sk-[A-Za-z0-9]{20,}$",
      "mensajePatron": "Debe empezar por sk- y tener al menos 20 caracteres.",
      "ayuda": "La encuentras en el panel de tu proveedor."
    },
    {
      "clave": "TRADUCTOR_URL",
      "etiqueta": "Servidor",
      "tipo": "texto",
      "predeterminado": "https://api.ejemplo.com",
      "patron": "^https?://",
      "mensajePatron": "Debe empezar por http:// o https://",
      "longitudMax": 200
    },
    {
      "clave": "TRADUCTOR_IDIOMA",
      "etiqueta": "Idioma de destino",
      "tipo": "opcion",
      "opciones": [
        { "valor": "es", "etiqueta": "Español" },
        { "valor": "en", "etiqueta": "Inglés" },
        "pt"
      ],
      "predeterminado": "es"
    },
    {
      "clave": "TRADUCTOR_TIMEOUT",
      "etiqueta": "Tiempo de espera (s)",
      "tipo": "numero",
      "min": 1,
      "max": 120,
      "predeterminado": 15
    },
    {
      "clave": "TRADUCTOR_CACHE",
      "etiqueta": "Guardar traducciones en caché",
      "tipo": "booleano",
      "predeterminado": true
    }
  ]
}
```

Y cómo leerlos en `module.js`:

```js
const cfg = () => ({
  apiKey: process.env.TRADUCTOR_API_KEY || "",
  url: process.env.TRADUCTOR_URL || "https://api.ejemplo.com",
  idioma: process.env.TRADUCTOR_IDIOMA || "es",
  timeoutS: Number(process.env.TRADUCTOR_TIMEOUT ?? 15),
  cache: (process.env.TRADUCTOR_CACHE ?? "true") === "true",
});
```

### Asistente de primera vez

El asistente solo configura la cuenta, el túnel y, si existe, el módulo `discord`. Los ajustes de los demás conectores se editan después en *Configuración → Módulos*.

---

## 10. Cómo se ven los ajustes en el panel

En **Configuración → Módulos**:

1. Arriba, la lista de todos los módulos con su interruptor (activar o desactivar).
2. Debajo, **un bloque por cada módulo que tenga `configuracion.json` válido**, en orden alfabético: título, descripción, una fila por campo y una nota con la ruta del `.env`.
3. Al final, un único par de botones: **Guardar** (activación + todos los ajustes) y **Guardar y reiniciar**.

Detalles:

- Los campos obligatorios llevan `*` junto a la etiqueta.
- Un módulo desactivado conserva su bloque y muestra la etiqueta *desactivado*.
- Si el servidor rechaza algún valor, **no se guarda ningún cambio de ningún módulo** y se muestra el motivo en un aviso.
- Los secretos guardados muestran el texto *Guardado (déjalo vacío para conservarlo)* y un botón *Borrar*.
- Los cambios se aplican al reiniciar el servidor.

---

## 11. Referencia de la API del panel

El panel es un servidor HTTP aparte, de solo lectura local: escucha **únicamente en `127.0.0.1`** (puerto 3100 por defecto, distinto al del servidor MCP), así que el túnel nunca lo expone.

### Acceso y seguridad

1. Al arrancar, el servidor imprime un enlace `http://localhost:3100/?t=<TOKEN>`. El token es aleatorio y cambia en cada arranque.
2. Abrir ese enlace valida el token y crea la cookie `mcp_cfg` (`HttpOnly`, `SameSite=Strict`).
3. Toda llamada a `/api/...` necesita:
   - la cookie `mcp_cfg`, y
   - la cabecera **`X-Configuracion: 1`** (protección anti CSRF).
4. Se rechazan las peticiones cuyo `Host` no sea `localhost:<puerto>` o `127.0.0.1:<puerto>` (anti DNS rebinding).
5. Los cuerpos deben ser `application/json` y pesar menos de 64 KB.

Códigos de error comunes:

| Código | Significa |
| ------ | --------- |
| `400` | Datos inválidos. Cuerpo: `{ "error": "...", "errores": ["...", "..."] }` |
| `401` | Falta o caducó la cookie del panel |
| `403` | Falta `X-Configuracion: 1`, `Host` no permitido o contraseña incorrecta |
| `404` | Ruta o recurso inexistente |
| `409` | Estado incompatible (por ejemplo, el asistente ya se completó) |
| `413` / `415` | Cuerpo demasiado grande / no es JSON |
| `429` | Demasiados intentos de contraseña (bloqueo de 60 s tras 5 fallos) |
| `501` | Acción no disponible en esta instalación |

### Probarla desde la consola

```powershell
# 1) Entra con el enlace de la consola del servidor (guarda la cookie)
curl.exe -s -c cookies.txt -o NUL "http://localhost:3100/?t=TU_TOKEN"

# 2) Llama a la API con la cookie y la cabecera
curl.exe -s -b cookies.txt -H "X-Configuracion: 1" http://localhost:3100/api/modulos/ajustes

# 3) Para enviar JSON desde PowerShell, usa un archivo (evita problemas de comillas)
'{"modulos":{"saludo":{"valores":{"SALUDO_FRASE":"Buenas"}}}}' | Set-Content cuerpo.json -Encoding ascii
curl.exe -s -b cookies.txt -X PUT -H "X-Configuracion: 1" -H "Content-Type: application/json" --data-binary "@cuerpo.json" http://localhost:3100/api/modulos/ajustes
```

### Ajustes de módulos

#### `GET /api/modulos/ajustes`

Lista los módulos con `configuracion.json` válido y sus valores actuales.

```json
{
  "modulos": [
    {
      "nombre": "saludo",
      "titulo": "Saludo",
      "descripcion": "Personaliza cómo saluda el conector.",
      "activo": true,
      "campos": [
        { "clave": "SALUDO_FRASE", "etiqueta": "Frase de saludo", "tipo": "texto",
          "ayuda": "", "placeholder": "", "obligatorio": false,
          "longitudMax": 60, "predeterminado": "Hola", "valor": "Buenas" },
        { "clave": "TRADUCTOR_API_KEY", "etiqueta": "API key", "tipo": "secreto",
          "obligatorio": true, "longitudMax": 500, "guardado": true }
      ]
    }
  ]
}
```

- Los campos de tipo `secreto` traen `guardado` (booleano) y **nunca** `valor`.
- `booleano` devuelve `valor` como booleano (aplica el `predeterminado` si no hay nada guardado).
- Los demás devuelven `valor` como texto (`""` si no hay).
- No se incluyen `patron`, `mensajePatron` ni `quitarEspacios`: la validación vive solo en el servidor.

#### `PUT /api/modulos/ajustes`

Guarda ajustes de uno o varios módulos **de forma atómica**: se validan todos y, si alguno falla, no se escribe nada.

Cuerpo:

```json
{
  "modulos": {
    "saludo": {
      "valores": { "SALUDO_FRASE": "Buenas", "SALUDO_GRITAR": true },
      "borrar": ["SALUDO_OTRA"]
    }
  }
}
```

| Propiedad | Descripción |
| --------- | ----------- |
| `modulos.<nombre>.valores` | Mapa `CLAVE → valor`. Tipos: texto/secreto/opción como texto; número como número o texto; booleano como `true`/`false`. |
| `modulos.<nombre>.borrar` | Lista de claves a eliminar del `.env` (la forma de quitar un secreto). |

Reglas por tipo:

- `texto` / `secreto`: se recorta (o se quitan todos los espacios con `quitarEspacios`). Un texto vacío borra el valor; **un secreto vacío se ignora** (conserva el actual). Debe cumplir `longitudMax` y `patron`, y no puede tener caracteres de control ni mezclar comillas simples y dobles.
- `numero`: entero o decimal (`-?\d+(\.\d+)?`), dentro de `min` y `max`. `""` borra el valor.
- `booleano`: debe ser `true` o `false` (JSON).
- `opcion`: debe ser uno de los `valor` declarados. `""` borra el valor.
- Claves que no existen en el esquema, o módulos sin `configuracion.json`, devuelven `400`.
- Un campo `obligatorio` no se puede dejar vacío si ya tenía valor.

Respuesta `200`:

```json
{ "guardados": ["saludo"], "modulos": [ /* igual que el GET */ ] }
```

Respuesta `400`:

```json
{
  "error": "Saludo: Puerto debe estar entre 1024 y 65535. Traductor: API key es obligatorio.",
  "errores": [
    "Saludo: Puerto debe estar entre 1024 y 65535.",
    "Traductor: API key es obligatorio."
  ]
}
```

Los cambios se **escriben en el `.env` al instante**, pero el módulo los ve al reiniciar el servidor.

### Configuración general

#### `GET /api/config`

```json
{
  "config": {
    "servidor": { "puerto": 3000, "sesionMinutos": 120, "accessTokenMinutos": 60, "refreshTokenDias": 30 },
    "tunel": { "modo": "rapido", "protocolo": "http2", "urlPublica": "", "actualizarCloudflared": true, "tokenGuardado": false },
    "modulos": { "deshabilitados": [] },
    "panel": { "puerto": 3100, "abrirAlIniciar": true },
    "tema": { "acento": "" }
  },
  "usuario": "juan",
  "modulos": [ { "nombre": "abrir", "descripcion": "Abre archivos...", "activo": true } ],
  "reinicioPendiente": false,
  "tunelPendiente": false
}
```

El token del túnel nunca se devuelve: solo `tunel.tokenGuardado`.

#### `PUT /api/config`

Acepta cualquier subconjunto de `config.json` (lo que falte se conserva). Valida todo y guarda de forma atómica.

```json
{
  "tunel": { "modo": "nombrado", "token": "eyJhIjoi...", "urlPublica": "https://mcp.tudominio.com" },
  "modulos": { "deshabilitados": ["ocr", "discord"] }
}
```

- `tunel.borrarToken: true` elimina el token guardado.
- Reglas cruzadas: el modo `nombrado` exige `token` y `urlPublica`, y el puerto del servidor no puede ser igual al del panel.
- Respuesta: `{ config, modulos, reinicioPendiente, tunelPendiente }`. `reinicioPendiente` indica que hay cambios de puertos, sesiones, módulos o panel que requieren reiniciar el servidor; `tunelPendiente`, que el túnel en marcha difiere de lo guardado.

### Tema (color de acento)

El color vive en `tema.acento` de `config.json`, así que se lee y se guarda con `GET /api/config` y `PUT /api/config`:

```json
{ "tema": { "acento": "#7c3aed" } }
```

- Formato `#RRGGBB` (se guarda en minúsculas). Una cadena vacía o `null` vuelve al predeterminado. Cualquier otro valor devuelve `400`.
- Se aplica **al instante**, sin reiniciar: no cuenta como cambio pendiente.
- `GET /tema.css` devuelve el CSS del color guardado (vacío si es el predeterminado). Con `?acento=%23rrggbb` devuelve la vista previa de ese color sin guardarlo; es lo que usa la pestaña Temas. Como las demás rutas del panel, necesita la cookie de sesión.

### Estado y acciones

| Ruta | Cuerpo | Respuesta | Descripción |
| ---- | ------ | --------- | ----------- |
| `GET /api/estado` | — | `{ ahora, inicio, nodeVersion, plataforma, carpeta, usuario, puertoServidor, puertoPanel, urlLocal, urlPublicaMcp, urlIssuer, tunel: { modo, activo }, modulosCargados: [..], reinicioPendiente, tunelPendiente }` | Estado en vivo. El panel lo consulta cada 4 s. |
| `POST /api/tunel/reiniciar` | — | `{ ok: true }` | Detiene y vuelve a lanzar cloudflared con lo guardado en `config.json`. |
| `POST /api/servidor/reiniciar` | — | `{ ok: true }` | Relanza el servidor en una ventana nueva (solo Windows). Responde primero y reinicia después. |
| `POST /api/cuenta` | `{ usuarioNuevo?, contrasenaActual, contrasenaNueva?, revocarConectores? }` | `{ ok, usuario, contrasenaCambiada }` | Cambia usuario y/o contraseña (mín. 8 caracteres). Cierra las sesiones; con `revocarConectores: true` revoca también Claude, ChatGPT, etc. `403` si la actual es incorrecta, `429` tras 5 fallos. |
| `POST /api/sesiones/cerrar` | `{ revocarConectores? }` | `{ ok: true }` | Invalida las sesiones activas. |
| `GET /api/apikey` | — | `{ apiKey }` | La API key del REST (`404` si aún no existe). |

### Asistente de primera vez

| Ruta | Descripción |
| ---- | ----------- |
| `GET /api/setup/estado` | `{ pendiente, discord: { disponible, activo, tokenGuardado, guilds, logChannel }, tunel: { modo, urlPublica } }`. `pendiente` es `true` mientras no exista `usuarios.json`. |
| `POST /api/setup` | Completa la configuración inicial. `409` si ya estaba completa. |

Cuerpo de `POST /api/setup`:

```json
{
  "usuario": "juan",
  "contrasena": "UnaClaveLarga123",
  "tunel": { "modo": "rapido" },
  "discord": { "activar": true, "token": "xxx.yyy.zzz", "guilds": "123456789012345678", "logChannel": "" }
}
```

Crea `usuarios.json`, escribe `config.json` y (si activas Discord) `modules/discord/.env`, y reanuda el arranque del servidor, que esperaba en la consola. Si `discord.activar` es `false`, el módulo queda en `modulos.deshabilitados`.

---

## 12. Referencia de `configuracion.js` (API de JavaScript)

`configuracion.js` (en la raíz del proyecto) exporta:

| Exportación | Descripción |
| ----------- | ----------- |
| `cargarConfiguracion()` | Lee `config.json` y devuelve la configuración completa y validada (con valores por defecto). Nunca lanza: si el archivo no existe o es ilegible usa los valores por defecto y avisa en consola. |
| `normalizarConfig(entrada, base?)` | Valida una configuración parcial y la combina con `base`. Devuelve `{ config, errores }`. |
| `RUTA_CONFIG` | Ruta absoluta de `config.json` (`<carpeta de trabajo>/config.json`). |
| `cssTema(acento)` | Devuelve el CSS que aplica un color de acento (`#rrggbb`) en modo claro y oscuro, ajustando el brillo si hace falta para que se lea. Devuelve `""` si el color es el predeterminado o no es válido, así que es seguro incrustarlo en una página. La usan el panel y la página de autorización de `index.js`. |
| `leerEsquemaModulo(nombre)` | Lee y valida `modules/<nombre>/configuracion.json`. Devuelve `{ titulo, descripcion, campos }` normalizado, o `null` si no existe o es inválido. |
| `cargarEnvModulo(nombre)` | Carga en `process.env` las claves declaradas del `.env` del módulo (sin pisar las existentes). `index.js` la llama antes de importar cada módulo. |
| `iniciarPanelConfiguracion({ config, puertoServidor, hooks })` | Levanta el panel. Devuelve `Promise<{ puerto, url, setupPendiente(), cerrar() }>`. |

### Hooks de `iniciarPanelConfiguracion`

El panel no conoce el estado interno del servidor; `index.js` se lo da con funciones opcionales:

```js
await iniciarPanelConfiguracion({
  config,                  // resultado de cargarConfiguracion()
  puertoServidor: PORT,
  hooks: {
    estado: () => ({ urlLocal, urlPublicaMcp, urlIssuer, tunel: { modo, activo }, modulosCargados: [] }),
    recargarUsuario: () => { /* vuelve a leer usuarios.json */ },
    cerrarSesiones: ({ revocarOAuth }) => { /* invalida sesiones (y tokens OAuth si revocarOAuth) */ },
    reiniciarTunel: async () => { /* detiene y relanza cloudflared */ },
    setupCompleto: () => { /* el asistente terminó: sigue el arranque */ },
  },
});
```

Si falta un hook, la ruta que lo necesita responde `501`.

### Variables que afectan al panel

| Variable | Efecto |
| -------- | ------ |
| `CONFIG_ABRIR=1` | Abre siempre el navegador al iniciar el panel. |
| `CONFIG_ABRIR=0` | No abre nunca el navegador (el enlace sigue en la consola). |

Sin esa variable se abre si `panel.abrirAlIniciar` es `true` o si es la primera vez (asistente).

---

## 13. `config.json` y variables de entorno

`config.json` (en la carpeta desde la que arrancas el servidor) lo escribe el panel y está en `.gitignore`: puede contener el token del túnel. Todos los campos son opcionales.

```json
{
  "servidor": { "puerto": 3000, "sesionMinutos": 120, "accessTokenMinutos": 60, "refreshTokenDias": 30 },
  "tunel": {
    "modo": "rapido",
    "protocolo": "http2",
    "urlPublica": "",
    "token": "",
    "actualizarCloudflared": true
  },
  "modulos": { "deshabilitados": [] },
  "panel": { "puerto": 3100, "abrirAlIniciar": true },
  "tema": { "acento": "" }
}
```

| Campo | Valores | Descripción |
| ----- | ------- | ----------- |
| `servidor.puerto` | 1–65535 | Puerto del servidor MCP. |
| `servidor.sesionMinutos` | 5–10080 | Duración del inicio de sesión tradicional. |
| `servidor.accessTokenMinutos` | 5–1440 | Duración del token de acceso OAuth. |
| `servidor.refreshTokenDias` | 1–365 | Duración del token de refresco OAuth. |
| `tunel.modo` | `rapido`, `nombrado`, `ninguno` | Quick tunnel de Cloudflare (URL aleatoria), túnel con nombre (URL fija, necesita `token` y `urlPublica`) o sin túnel. |
| `tunel.protocolo` | `http2`, `quic`, `auto` | Protocolo de cloudflared. |
| `tunel.urlPublica` | URL sin `/mcp` | Dirección pública en los modos `nombrado` y `ninguno`. |
| `tunel.token` | texto | Token del túnel con nombre. |
| `tunel.actualizarCloudflared` | `true`/`false` | Comprueba si hay una versión nueva de cloudflared en cada arranque (solo descarga si hace falta). |
| `modulos.deshabilitados` | lista de carpetas | Módulos que no se cargan. |
| `panel.puerto` | 1024–65535 | Puerto del panel (si está ocupado prueba los siguientes). |
| `panel.abrirAlIniciar` | `true`/`false` | Abre el navegador al arrancar. |
| `tema.acento` | `""` o `#rrggbb` | Color de acento de la interfaz. `""` es el predeterminado (azul de Windows). Se cambia en **Configuración → Temas** y también lo usa la página de autorización. |

**Prioridad:** las variables de entorno siempre ganan a `config.json`: `PORT`, `SESSION_MINUTOS`, `ACCESS_TOKEN_MINUTOS`, `REFRESH_TOKEN_DIAS`, `OAUTH_CODE_MINUTOS`, `URL_PUBLICA_BASE`, `URL_PUBLICA` y `OAUTH_ISSUER`.

---

## 14. Dependencias: Node, Python y binarios externos

**Paquetes de Node que ya están disponibles** para tu módulo sin instalar nada: los de la raíz del proyecto (`zod`, `express`, `adm-zip`, `@modelcontextprotocol/sdk`…).

**Dependencias propias** (como `discord.js`): crea `modules/<nombre>/package.json` y haz `npm install --omit=dev` dentro de esa carpeta. Importa con normalidad desde tu `module.js`. Si el import puede fallar, atrápalo (ver [sección 4](#4-ciclo-de-vida-cómo-carga-el-servidor-un-módulo)). Añade `modules/<nombre>/node_modules/` a `.gitignore`.

**Python:** pon el worker en `main.py`, las dependencias en `requirements.txt` y lánzalo con `resolverPython(__dirname)` (`modules/_shared/python.js`). El instalador (`instalar-dependencias-python.ps1`) prepara un Python embebido y la carpeta `vendor/`; haz que tu `main.py` la añada al `sys.path` como los demás:

```python
import os, site
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_VENDOR):
    site.addsitedir(_VENDOR)
```

**Binarios externos** (Tesseract, ffmpeg…): no los incluyas en el repo. Documenta cómo instalarlos, busca en rutas conocidas y, si no están, devuelve un `isError` claro. `instalar-todo.ps1` es el lugar para automatizar la instalación de los que sean comunes.

**Apps de escritorio auxiliares** (como la superposición de notificaciones, en Electron): inclúyelas dentro de la carpeta del módulo y lánzalas desde `iniciar` o bajo demanda, con rutas relativas a `__dirname`.

---

## 15. Seguridad y buenas prácticas

Tu conector se ejecuta con los permisos de tu usuario de Windows y suele ser accesible desde internet a través del túnel. Trátalo así.

**Acceso**

- Llama a `verificarAcceso(clave)` **al inicio de cada herramienta** y a `verificarApiKey(...)` al inicio de cada ruta REST. Sin excepciones.
- No registres rutas fuera de `registrarRest` (por ejemplo, otro servidor HTTP) sin autenticación; si abres un puerto propio, solo en `127.0.0.1`.

**Entradas**

- Valida todo con zod: tipos, longitudes, rangos, `enum`.
- Si recibes rutas de archivo, normalízalas con `path.resolve` y comprueba que quedan dentro de la carpeta que esperas.
- **Nunca construyas comandos concatenando texto.** Usa `execFile`/`spawn` con un arreglo de argumentos (`shell: false`). Si debes interpolar en PowerShell, usa `limpiarParaPS` de `modules/_shared/ps.js`.
- Limita tamaños (cuerpos, salida de procesos, archivos leídos) y pon `timeout` a todo lo externo.

**Secretos**

- Declara tokens y claves como `tipo: "secreto"`: el panel nunca los devuelve al navegador.
- No los imprimas en la consola ni los metas en la respuesta de una herramienta. Si registras parámetros, redacta los que parezcan secretos (el módulo de Discord oculta `token`, `password`, `secret`…).
- `modules/*/.env` está en `.gitignore`. No subas nunca un `.env`.

**Operaciones destructivas**

- Describe el riesgo en la `description` y marca `annotations: { destructiveHint: true }` en borrados y similares.
- Considera pedir confirmación explícita con un parámetro (`confirmar: z.literal(true)`) en acciones irreversibles.

**Robustez**

- Un fallo en tu módulo no debe tirar el servidor: atrapa los errores y devuelve `isError: true`.
- Limpia lo que abras (procesos, sockets, archivos temporales) al salir: `process.on("exit", ...)`.

---

## 16. Probar y depurar

1. **Sintaxis:** `node --check modules/mi_conector/module.js`.
2. **JSON de ajustes:** abre el panel. Si tu `configuracion.json` es inválido no aparece el bloque, y en la consola del servidor sale una línea `[configuracion] modules/<nombre>/configuracion.json no es válido y se ignora:` con la lista de problemas.
3. **Reinicia** el servidor y busca `Modulo cargado: <nombre>`.
4. **Herramientas MCP:** pídele a tu cliente que use la herramienta, o ábrela con el [MCP Inspector](https://github.com/modelcontextprotocol/inspector) apuntando a `http://localhost:3000/mcp` (necesita un token de OAuth).
5. **REST:** `curl.exe -H "x-api-key: TU_KEY" http://localhost:3000/api/mi_conector/estado`.
6. **Ajustes:** cambia un valor en el panel, guarda y comprueba `modules/<nombre>/.env`. Reinicia y verifica que tu código lo recibe (`console.log` de `process.env.MI_CLAVE`, sin imprimir secretos reales).
7. **Aislar un módulo:** desactívalo con su interruptor en *Módulos* (o añádelo a `modulos.deshabilitados` en `config.json`) para comprobar si el problema es suyo.

---

## 17. Publicar tu conector

Lista de comprobación antes de compartirlo:

- [ ] La carpeta se llama igual que `nombre` en `module.js` y usa solo `a-z`, `0-9`, `_` y `-`.
- [ ] Todas las herramientas llevan el prefijo del conector y declaran `clave`.
- [ ] Todas las herramientas y rutas verifican el acceso.
- [ ] `configuracion.json` es válido (prueba abriendo el panel) y cada `clave` lleva el prefijo del módulo.
- [ ] Tu código aplica los mismos valores por defecto que declaras en `predeterminado`.
- [ ] No hay secretos, `.env` ni `node_modules` dentro de la carpeta.
- [ ] Hay un `README.md` en la carpeta con: qué hace, herramientas, ajustes, dependencias externas e instalación.
- [ ] `module_info.json` con `nombre`, `version` y `descripcion` (la línea que verá el usuario bajo el interruptor).

Para instalar un conector ajeno: copia su carpeta dentro de `modules/`, ejecuta `npm install --omit=dev` si trae `package.json`, reinicia el servidor y configúralo en *Configuración → Módulos*.

---

## 18. Errores frecuentes

| Síntoma | Causa probable | Solución |
| ------- | -------------- | -------- |
| La carpeta no se carga | Falta `module.js`, o el nombre empieza distinto | Comprueba que el archivo se llama exactamente `module.js` |
| El arranque falla al importar el módulo | Una dependencia o variable falta y no se atrapó | Envuelve el `import` en `try/catch` (sección 4) |
| La herramienta siempre responde "Sesion invalida" | No declaraste `clave` en el `inputSchema`, o no pasas `clave` a `verificarAcceso` | `clave: z.string().optional()` y `verificarAcceso(clave)` |
| `/mcp` deja de responder tras añadir el módulo | Nombre de herramienta repetido | Prefija los nombres con el del conector |
| El bloque de ajustes no aparece | `configuracion.json` inválido o sin `campos` | Mira la consola: indica qué campo falló |
| `process.env.X` llega vacío | No reiniciaste, el campo está vacío o ya existía la variable en el sistema | Reinicia; recuerda que el entorno del sistema gana al `.env` |
| El valor por defecto no se aplica | `predeterminado` solo lo muestra el panel | Aplica `?? valor` en tu código |
| `clave "X" está reservada` | Declaraste una variable del sistema (`PATH`, `PORT`…) | Usa una clave con el prefijo de tu módulo |
| `400` al guardar con "obligatorio" | Intentaste vaciar un campo obligatorio que ya tenía valor | Escribe un valor nuevo o quita `obligatorio` |
| `ECONNREFUSED` hacia tu worker | El worker no arrancó o usa otro puerto | Usa el que recibes en `iniciar(puerto)` y espera a `/salud` |
| El worker queda huérfano al cerrar | No se mata el proceso hijo | `process.on("exit", () => worker?.kill())` |

---

## 19. Referencia rápida

```js
// modules/mi_conector/module.js
import { z } from "zod";

export default {
  nombre: "mi_conector",

  // Una vez por cada POST /mcp: rápido y sin efectos secundarios
  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "mi_conector_accion",
      {
        title: "Acción",
        description: "Qué hace y qué devuelve.",
        inputSchema: { dato: z.string(), clave: z.string().optional() },
      },
      async ({ dato, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        return { content: [{ type: "text", text: `ok: ${dato}` }] };
      },
    );
  },

  // Rutas bajo /api, siempre con API key
  registrarRest(router, { verificarApiKey }) {
    router.get("/mi_conector/estado", (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      res.json({ ok: true });
    });
  },

  // Solo si necesitas un servicio propio; recibe un puerto libre (9000–9999)
  async iniciar(puerto) {},
};
```

```json
// modules/mi_conector/configuracion.json
{
  "titulo": "Mi conector",
  "campos": [
    { "clave": "MICONECTOR_TOKEN", "etiqueta": "Token", "tipo": "secreto", "obligatorio": true },
    { "clave": "MICONECTOR_MODO", "etiqueta": "Modo", "tipo": "opcion", "opciones": ["rapido", "completo"], "predeterminado": "rapido" },
    { "clave": "MICONECTOR_LIMITE", "etiqueta": "Límite", "tipo": "numero", "min": 1, "max": 100, "predeterminado": 10 },
    { "clave": "MICONECTOR_DEBUG", "etiqueta": "Depuración", "tipo": "booleano" }
  ]
}
```

| Quiero… | Hago… |
| ------- | ----- |
| Añadir una herramienta MCP | `registrarMcp` + `server.registerTool`, con `clave` y `verificarAcceso` |
| Añadir una ruta REST | `registrarRest` + `router.get/post`, con `verificarApiKey` |
| Un servicio propio | `iniciar(puerto)` y escuchar en `127.0.0.1:puerto` |
| Un ajuste editable | Un campo en `configuracion.json`; léelo con `process.env.CLAVE` |
| Un token | `tipo: "secreto"` |
| Desactivarlo sin borrarlo | Interruptor en *Configuración → Módulos* |
| Aplicar cambios | Reiniciar el servidor |

---

Si quieres más detalles, ve a [Module API Detailed](MODULE_API_DETAILED.md).
