# Module API: versión detallada (referencia exacta)

Documentación exacta de la API que el servidor ofrece a un **módulo personalizado**: qué archivos reconoce, cuándo llama a cada función, qué recibe cada una, cómo se declaran ajustes configurables y qué pasa cuando algo falla.

Esta referencia se escribió leyendo el código real (`index.js`, `configuracion.js`, `modules/registro.js`, `modules/apikey.js`, `modules/_shared/*` y los módulos `portapapeles`, `ocr` y `discord`). Cuando algo es una **consecuencia deducida del código** y no un comportamiento documentado, se indica como *(observado en el código)*.

> **Módulo = conector.** En el código se llama *módulo*; [`MODULE_API.md`](MODULE_API.md) usa la palabra *conector* para lo mismo. Este documento es la versión detallada y técnica; `MODULE_API.md` es una guía más narrativa. Donde difieren, vale lo que dice este (ver [sección 17](#17-diferencias-y-puntos-delicados-detectados-en-el-código)).

## Índice

1. [Resumen del contrato](#1-resumen-del-contrato)
2. [Estructura de la carpeta](#2-estructura-de-la-carpeta)
3. [Ciclo de vida exacto](#3-ciclo-de-vida-exacto)
4. [El objeto exportado por `module.js`](#4-el-objeto-exportado-por-modulejs)
5. [Herramientas MCP: `registrarMcp`](#5-herramientas-mcp-registrarmcp)
6. [Rutas REST: `registrarRest`](#6-rutas-rest-registrarrest)
7. [Servicios propios y puertos: `iniciar`](#7-servicios-propios-y-puertos-iniciar)
8. [Ajustes: `configuracion.json`](#8-ajustes-configuracionjson)
9. [Cómo se guardan y cargan los ajustes (`.env`)](#9-cómo-se-guardan-y-cargan-los-ajustes-env)
10. [API del panel relacionada con módulos](#10-api-del-panel-relacionada-con-módulos)
11. [`module_info.json`](#11-module_infojson)
12. [Utilidades compartidas (`modules/_shared`)](#12-utilidades-compartidas-modulesshared)
13. [Workers en Python](#13-workers-en-python)
14. [Dependencias](#14-dependencias)
15. [Seguridad](#15-seguridad)
16. [Plantillas completas](#16-plantillas-completas)
17. [Diferencias y puntos delicados detectados en el código](#17-diferencias-y-puntos-delicados-detectados-en-el-código)
18. [Pruebas, depuración y errores frecuentes](#18-pruebas-depuración-y-errores-frecuentes)
19. [Checklist de publicación](#19-checklist-de-publicación)
20. [Tabla de límites y constantes](#20-tabla-de-límites-y-constantes)
21. [Qué no se verificó](#21-qué-no-se-verificó)

---

## 1. Resumen del contrato

Un módulo es una carpeta dentro de `modules/` que contiene un `module.js`. Ese archivo hace `export default` de un objeto con estas propiedades, todas opcionales salvo `nombre`:

| Propiedad | Firma | Quién la llama y cuándo |
| --------- | ----- | ----------------------- |
| `nombre` | `string` | Solo se usa en el log `Modulo cargado: <nombre>`. |
| `registrarMcp` | `(server, { verificarAcceso, errorClave }) => void` | Una vez **por cada `POST /mcp`** (instancia nueva de `McpServer` cada vez). |
| `registrarRest` | `(router, { verificarApiKey }) => void` | Una vez al arrancar. |
| `iniciar` | `async (puerto: number) => void` | Una vez al arrancar, con un puerto libre 9000–9999. |
| `info` | cualquier cosa | Nadie la lee. Es solo una convención. |
| `detener` | `() => void` | **Nadie la llama.** |

Además, la carpeta puede traer `configuracion.json` (ajustes que edita el panel), `module_info.json` (documentación) y cualquier otro archivo que tu código necesite.

```
Cliente MCP ──► POST /mcp ──► McpServer nuevo ──► tools del index + registrarMcp de cada módulo
Cliente HTTP ─► /api/...  ──► apiRouter ───────► registrarRest de cada módulo (x-api-key)
Tú ──────────► localhost:3100 (panel) ─────────► ajustes → modules/<nombre>/.env
```

---

## 2. Estructura de la carpeta

```
modules/
└── mi_modulo/
    ├── module.js            OBLIGATORIO. Sin él la carpeta se ignora por completo.
    ├── configuracion.json   Opcional. Ajustes que dibuja y valida el panel.
    ├── .env                 Lo escribe el panel. No se versiona (está en .gitignore).
    ├── module_info.json     Opcional. Documentación; el panel usa solo "descripcion".
    ├── package.json         Opcional. Dependencias de Node propias del módulo.
    ├── main.py              Opcional. Worker de Python.
    ├── requirements.txt     Opcional. Dependencias del worker.
    └── vendor/  venv/       Generadas por el instalador. No se versionan.
```

### Reglas de reconocimiento

| Regla | Detalle exacto |
| ----- | -------------- |
| Qué carpetas se examinan | Los **subdirectorios directos** de `modules/` (no recursivo). |
| Qué las convierte en módulo | Que exista `modules/<carpeta>/module.js`. |
| Qué las excluye | Estar en `modulos.deshabilitados` de `config.json` (interruptor del panel). |
| Carpetas auxiliares | Sin `module.js` se ignoran. Por eso `_shared/` no es un módulo. Usa el prefijo `_` por convención. |
| Orden de carga | El que devuelve `fs.readdirSync` (en NTFS, alfabético). No dependas de él. |
| Formato | Módulo ES (`import` / `export default`). El proyecto tiene `"type": "module"`. |

### Nombre de la carpeta

La carpeta es el **identificador del módulo** para el panel (interruptor, `config.json`, `.env`, ajustes). El panel solo acepta nombres que cumplan:

```
^[A-Za-z0-9_-]{1,64}$
```

Una carpeta con otro nombre (espacios, puntos, tildes…) **sí se carga**, pero:

- no se puede desactivar desde el panel (la lista `deshabilitados` rechaza nombres no válidos), y
- su `configuracion.json` se ignora (`leerEsquemaModulo` devuelve `null`).

Usa solo letras, números, `_` y `-`, y haz que coincida con el `nombre` que exportas.

---

## 3. Ciclo de vida exacto

### Arranque (`index.js`, función `iniciar()` → `cargarModulos()`)

1. Se inicia el panel de configuración y se resuelve el usuario (asistente la primera vez).
2. Se cargan los clientes OAuth guardados.
3. `cargarModulos()`:
   1. Lee `config.json` **en ese momento** y obtiene `modulos.deshabilitados`.
   2. Si `modules/` no existe, termina.
   3. **Bucle 1: importar.** Para cada subcarpeta no deshabilitada con `module.js`:
      1. `cargarEnvModulo(<carpeta>)`: si existe un `configuracion.json` válido, copia a `process.env` las claves declaradas que haya en su `.env` (sin pisar variables que ya existan).
      2. `await import("./modules/<carpeta>/module.js")` y toma `.default`.
      3. Lo agrega a `modulosCargados` (y el nombre de carpeta a la lista que ve el panel).
   4. **Bucle 2: registrar e iniciar.** Para cada módulo importado, en el mismo orden:
      1. `mod.registrarRest?.(apiRouter, { verificarApiKey })`
      2. Si `typeof mod.iniciar === "function"`: pide un puerto libre a `registro.js` y hace `await mod.iniciar(puerto)`.
      3. Imprime `Modulo cargado: <mod.nombre>` (con ` (puerto N)` si tenía `iniciar`).
4. Recién entonces `app.listen(PORT)` y después arranca el túnel.

Consecuencias:

- Todos los `import` ocurren **antes** que cualquier `registrarRest`/`iniciar`.
- `iniciar` se espera **en serie**. Si tarda, retrasa el arranque del servidor y del túnel *(observado en el código)*. Mantenlo corto.
- Como `cargarEnvModulo` corre antes del `import`, tus `process.env.X` ya están disponibles incluso en el nivel superior de `module.js`.

### Cada petición `POST /mcp`

1. Se comprueba el access token OAuth (si falta o es inválido: `401`).
2. Si es una llamada `tools/call` cuyo `params.arguments` es un objeto, el servidor **sobrescribe `arguments.clave`** con el token de sesión asociado.
3. `crearMcpServer()` crea un `McpServer` nuevo (`name: "mi-servidor"`, `version: "1.0.0"`), registra primero las herramientas del `index.js` y luego llama, en orden de carga, a `registrarMcp(mcp, { verificarAcceso, errorClave })` de cada módulo que lo defina.
4. Se crea un `StreamableHTTPServerTransport` sin sesión (`sessionIdGenerator: undefined`), se atiende la petición y al terminar se cierran el transporte y el `McpServer`.

El servidor MCP es **sin estado entre peticiones**. Todo lo que deba persistir (conexiones, cachés, procesos) vive en variables de **nivel de módulo**, nunca dentro de `registrarMcp`.

### Qué pasa cuando algo falla

| Dónde falla | Resultado |
| ----------- | --------- |
| `module.js` lanza al importarse | `cargarModulos()` se rechaza → `iniciar()` termina sin captura → **el servidor no arranca** (en Node ≥ 15 una promesa rechazada sin capturar termina el proceso) *(observado)*. |
| `registrarRest` lanza | Igual: el arranque falla. |
| `iniciar` lanza o se rechaza | Igual: el arranque falla. |
| `registrarMcp` lanza (p. ej. nombre de herramienta repetido) | Cada `POST /mcp` responde `500 {"error":"internal_server_error",...}`. **Todas** las herramientas dejan de funcionar, no solo las del módulo. |
| Un manejador de herramienta lanza | El SDK devuelve el error al cliente para esa llamada. El servidor sigue vivo. |
| Un manejador REST `async` lanza sin `try/catch` | Express 4 no captura la promesa rechazada; en Node ≥ 15 puede **terminar el proceso** *(observado)*. Usa siempre `try/catch`. |

Regla práctica: lo que pueda faltar (dependencia, token, binario) se atrapa y el módulo se **desactiva solo**, como hace `discord` (ver sección 16.3).

### Recarga

No hay recarga en caliente. Cambios en `module.js`, `configuracion.json`, `.env` o en la lista de módulos desactivados se aplican **al reiniciar el servidor** (botón *Reiniciar* del panel, o cerrar y abrir `iniciar.bat`).

---

## 4. El objeto exportado por `module.js`

```js
export default {
  nombre: "mi_modulo",
  registrarMcp(server, { verificarAcceso, errorClave }) { /* ... */ },
  registrarRest(router, { verificarApiKey }) { /* ... */ },
  async iniciar(puerto) { /* ... */ },
};
```

| Propiedad | Tipo | Obligatoria | Detalle |
| --------- | ---- | :---------: | ------- |
| `nombre` | `string` | Sí (en la práctica) | El servidor solo lo imprime. Si falta, el log dirá `Modulo cargado: undefined`. Debe coincidir con el nombre de la carpeta. |
| `registrarMcp` | `function` | No | Se invoca solo si `typeof === "function"`. |
| `registrarRest` | `function` | No | Se invoca con optional chaining (`mod.registrarRest?.(...)`). |
| `iniciar` | `function` | No | Su existencia determina si el módulo recibe un puerto. |
| `info` | libre | No | Convención: `{ nombre }` o el contenido de `module_info.json`. El servidor no la lee. |
| `detener` | `function` | No | **`index.js` nunca la invoca.** `discord` la define pero hoy no se ejecuta. Limpia tus recursos con `process.on("exit", ...)`. |

Las propiedades son opcionales de forma independiente: un módulo puede ser solo REST, solo MCP, solo un servicio, o cualquier combinación.

---

## 5. Herramientas MCP: `registrarMcp`

```js
registrarMcp(server, { verificarAcceso, errorClave }) {
  server.registerTool(nombre, definicion, manejador);
}
```

`server` es un `McpServer` de `@modelcontextprotocol/sdk` (versión `^1.30.0` según `package.json`). Los esquemas se escriben con `zod` (`^4.5.4`).

### 5.1 El contexto

| Campo | Qué es |
| ----- | ------ |
| `verificarAcceso(clave)` | `async`. Devuelve `true` si `clave` es un token de sesión vigente. |
| `errorClave()` | Devuelve `{ content: [{ type: "text", text: "Sesion invalida, expirada o faltante." }] }`. **No** lleva `isError: true`. |

### 5.2 El parámetro `clave`

- Con OAuth, el servidor inyecta el token en `arguments.clave` de cada `tools/call` (ver sección 3). Con el login tradicional, el cliente la obtiene de `iniciar_sesion` y la pasa a mano.
- **Declara `clave: z.string().optional()` en el `inputSchema` de todas tus herramientas.** Si no la declaras, el SDK descarta el campo al validar y `verificarAcceso(undefined)` fallará siempre.
- **No mencionar `clave` en la `description`:** con OAuth el modelo no necesita saberlo.
- **Primera línea de cada manejador:**

```js
if (!(await verificarAcceso(clave))) return errorClave();
```

- Si el cliente envía un `tools/call` **sin** `arguments`, el servidor no inyecta la clave y la verificación fallará *(observado en el código; ver sección 17)*.

### 5.3 Definición completa

```js
server.registerTool(
  "mi_modulo_buscar",                     // nombre único global
  {
    title: "Buscar cosas",                // nombre legible
    description: "Busca X en Y. Devuelve una lista JSON. Máximo 50 resultados.",
    inputSchema: {                        // objeto plano { campo: zod }
      consulta: z.string().min(1).max(200).describe("Texto a buscar"),
      limite: z.number().int().min(1).max(50).default(10),
      clave: z.string().optional(),
    },
    annotations: {                        // opcional
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async ({ consulta, limite, clave }) => {
    if (!(await verificarAcceso(clave))) return errorClave();
    // ...
    return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
  },
);
```

`discord` muestra una variante: si el esquema ya es un objeto zod, se amplía con `rawSchema.extend({ clave: z.string().optional() })` y se quita `clave` de los argumentos antes de pasarlos a la lógica interna.

### 5.4 Valores de retorno

```js
// Texto
{ content: [{ type: "text", text: "..." }] }

// Texto + imagen (base64 sin prefijo data:)
{ content: [
  { type: "text", text: "Captura tomada" },
  { type: "image", data: "<base64>", mimeType: "image/png" },
] }

// Error legible por el modelo
{ content: [{ type: "text", text: "No existe esa ruta" }], isError: true }
```

Los datos estructurados se devuelven como texto: `JSON.stringify(obj)` o `JSON.stringify(obj, null, 2)`. El SDK admite otros tipos de contenido; en este proyecto se usan `text` e `image`.

### 5.5 Nombres de herramientas

Los nombres son **globales**. Un nombre repetido hace que `registerTool` lance error → **todo `/mcp` devuelve 500** (sección 3).

- Prefija con el nombre del módulo: `mi_modulo_buscar`.
- Usa minúsculas, dígitos y `_`.
- Las herramientas del núcleo se registran **antes** que las de los módulos. Las que define `index.js` y que no puedes reutilizar:

`iniciar_sesion`, `cerrar_sesion`, `listar_archivos`, `leer_archivo`, `crear_archivo`, `editar_archivo`, `eliminar_archivo`, `eliminar_carpeta`, `crear_carpeta`, `renombrar`, `info_archivo`, `descargar_archivo`, `descargar_carpeta`, `subir_archivo`, `subir_carpeta`, `iniciar_shell`, `listar_shells`, `enviar_comando`, `leer_salida_shell`, `esperar_salida`, `detener_shell`.

- Los módulos incluidos aportan además (entre otros): `abrir`, `buscar_archivos`, `capturar_pantalla`, `control_remoto`, `verificar_coordenada`, `convertir_archivo`, `escaneres`, `escanear_documento`, `impresoras`, `imprimir_archivo`, `info_sistema`, `listar_ventanas`, `ventana_activa`, `notificar`, `notificar_progreso_crear`, `notificar_progreso_actualizar`, `notificar_finalizar`, `reconocer_texto_ocr`, `leer_portapapeles`, `escribir_portapapeles`, `listar_procesos`, `matar_proceso`, `red_info`, `red_ping`, `red_puerto`, `volumen` y las 99 `discord_*`.
- Tu instalación puede tener herramientas adicionales: comprueba la lista real que expone tu servidor antes de elegir un nombre.

### 5.6 `registrarMcp` se ejecuta muchas veces

Como se llama en cada `POST /mcp`:

- Debe ser **rápida y sin efectos secundarios**: no abras conexiones, no leas archivos pesados, no lances procesos.
- Los manejadores pueden ser closures sobre estado de nivel de módulo.
- Lee `process.env` **dentro** del manejador si quieres ver el valor vigente.

### 5.7 Buenas prácticas de diseño

- Una acción por herramienta, con nombre de verbo (`..._listar`, `..._crear`).
- `description` concreta: qué hace, qué devuelve, límites. El modelo decide con ese texto.
- Valida con zod (`min`, `max`, `enum`, `int`). No confíes en la entrada.
- Limita el tamaño de la salida (por ejemplo 100 000 caracteres) y avisa si recortas.
- Devuelve `isError: true` con un mensaje accionable en vez de dejar que se propague una excepción.
- Pon `timeout` a todo lo que espere algo externo.
- En operaciones destructivas: `annotations: { destructiveHint: true }` y, si es irreversible, un parámetro `confirmar: z.literal(true)`.

---

## 6. Rutas REST: `registrarRest`

```js
registrarRest(router, { verificarApiKey }) {
  router.get("/mi_modulo/estado", (req, res) => {
    if (!verificarApiKey(req.headers["x-api-key"])) {
      return res.status(401).json({ error: "API key invalida" });
    }
    res.json({ ok: true });
  });
}
```

### 6.1 Montaje y parseo

| Aspecto | Detalle |
| ------- | ------- |
| `router` | Un `express.Router()` (Express 4) montado con `app.use("/api", apiRouter)`. La ruta `/mi_modulo/estado` queda en `GET /api/mi_modulo/estado`. |
| Cuerpo JSON | `express.json({ limit: "40mb" })` global: `req.body` ya es un objeto. |
| Formularios | `express.urlencoded({ extended: false })` también está activo. |
| Orden | `/api` se monta **antes** que los archivos estáticos de `public/`. |
| Exposición | Las rutas **salen por el túnel**, igual que `/mcp`. Cualquiera con la URL puede llamarlas. |

### 6.2 Autenticación

`verificarApiKey(candidata)` devuelve `true` solo si `candidata` es un `string` **idéntico** (`===`) a la API key del servidor. Convención del proyecto: la clave llega en la cabecera `x-api-key`.

- La API key vive en `apikey.json` en la carpeta de trabajo. Se genera sola la primera vez (48 caracteres hexadecimales) y se imprime en consola. También se ve en el panel (*Seguridad*) y en `GET /api/apikey` del panel.
- Es distinta del login usuario/contraseña y de OAuth: **las rutas REST no pasan por OAuth**, solo por esta clave.
- La comparación es de igualdad simple, no de tiempo constante (ver sección 17).

### 6.3 Reglas

1. Verifica la API key al principio de **cada** ruta, sin excepciones.
2. Prefija las rutas con el nombre del módulo. Express no avisa de colisiones: gana la ruta registrada primero.
3. Envuelve los manejadores `async` en `try/catch` y responde `res.status(500).json({ error: err.message })`.
4. Devuelve códigos HTTP coherentes: `400` entrada inválida, `401` clave, `404` inexistente, `500` error interno.
5. Si sirves archivos estáticos con `express.static` desde un router de módulo, recuerda que **no tendrán protección** salvo que la agregues tú.

---

## 7. Servicios propios y puertos: `iniciar`

Si el módulo necesita un proceso o servidor propio (típicamente un worker en Python), define `iniciar(puerto)`. **No fijes puertos a mano.**

### 7.1 Cómo se asigna el puerto (`modules/registro.js`)

- Rango: **9000 a 9999** inclusive.
- Solo se asigna a módulos que definen `iniciar`.
- `asignarPuertoLibre(usados)` recorre el rango en orden, salta los puertos de `usados` (ya asignados en esta corrida) y comprueba que el puerto esté libre intentando escuchar en `127.0.0.1`.
- Devuelve el primero libre y lo añade a `usados`. Si no queda ninguno lanza `No quedan puertos libres en el rango 9000-9999`.
- El puerto **cambia entre corridas** según qué módulos estén activos y qué puertos haya libres. Nunca lo guardes en disco ni lo des por conocido. (El comentario `Puerto 9002` en `ocr/main.py` está desactualizado; el valor real llega por `--puerto`.)

### 7.2 Patrón estándar

```js
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { resolverPython } from "../_shared/python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let PUERTO = null;
let URL_WORKER = null;
let worker = null;

async function asegurarWorker() {
  try {
    const r = await fetch(`${URL_WORKER}/salud`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch {}
  if (worker) return true;

  worker = spawn(resolverPython(__dirname), ["main.py", "--puerto", String(PUERTO)], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => console.log(`[mi_modulo] ${d.toString().trim()}`));
  worker.stderr.on("data", (d) => console.error(`[mi_modulo:err] ${d.toString().trim()}`));
  worker.on("close", () => { worker = null; });
  process.on("exit", () => worker?.kill());

  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

export default {
  nombre: "mi_modulo",
  async iniciar(puerto) {
    PUERTO = puerto;
    URL_WORKER = `http://127.0.0.1:${PUERTO}`;
    await asegurarWorker();
  },
  // registrarMcp: llama a `await asegurarWorker()` antes de cada petición al worker.
};
```

Notas sobre el patrón (basado en `ocr/module.js`):

- Se consumen `stdout` y `stderr`: si no se leen, el buffer del pipe se llena y el worker se bloquea.
- La comprobación `/salud` con timeout corto permite **relanzar el worker perezosamente** si murió.
- `ocr` no registra `process.on("exit", ...)`, así que el worker puede quedar huérfano al cerrar el servidor. Es recomendable añadirlo.
- Mantén `iniciar` rápido (ver sección 3): la espera fija de 1,5 s del ejemplo se suma al arranque de todo el servidor.

---

## 8. Ajustes: `configuracion.json`

Si el módulo necesita valores editables (tokens, números, interruptores, listas), decláralos en `modules/<nombre>/configuracion.json`. El panel dibuja el formulario, valida en el servidor y guarda en `modules/<nombre>/.env`. No hace falta tocar el panel ni escribir HTML.

### 8.1 Estructura del archivo

```json
{
  "titulo": "Mi módulo",
  "descripcion": "Frase corta bajo el título.",
  "campos": [ ]
}
```

| Propiedad | Tipo | Límite | Obligatoria | Notas |
| --------- | ---- | ------ | :---------: | ----- |
| `titulo` | texto | 60 caracteres | No | Por defecto, el nombre de la carpeta. |
| `descripcion` | texto | 300 caracteres | No | |
| `campos` | lista | **1 a 50** elementos | Sí | Si falta o está vacía, el archivo es inválido. |

El archivo debe ser un objeto JSON. Se admite BOM al inicio. Todos los textos (`titulo`, `descripcion`, `etiqueta`, `ayuda`, `placeholder`, `mensajePatron`) rechazan caracteres de control (`\u0000`–`\u001f` y `\u007f`).

### 8.2 Propiedades de un campo

| Propiedad | Aplica a | Obligatoria | Regla exacta |
| --------- | -------- | :---------: | ------------ |
| `clave` | todos | Sí | `^[A-Z][A-Z0-9_]{0,63}$`. No repetida dentro del archivo y no reservada. |
| `etiqueta` | todos | Sí | Texto, máx. 80. |
| `tipo` | todos | No | `texto` (por defecto), `secreto`, `numero`, `booleano`, `opcion`. |
| `ayuda` | todos | No | Máx. 300. |
| `placeholder` | todos | No | Máx. 100. |
| `obligatorio` | todos | No | Debe ser booleano si se indica (otro tipo invalida el archivo). |
| `predeterminado` | todos **menos `secreto`** | No | Su tipo depende del `tipo` del campo (ver 8.3). |
| `longitudMax` | `texto`, `secreto` | No | Entero 1–4096. Por defecto 500. |
| `patron` | `texto`, `secreto` | No | Expresión regular **sin delimitadores `/`**, máx. 300, debe compilar. |
| `mensajePatron` | `texto`, `secreto` | No | Máx. 200. Error que se muestra si no cumple el patrón. |
| `quitarEspacios` | `texto`, `secreto` | No | Solo `true` tiene efecto: elimina **todos** los espacios en blanco antes de validar. |
| `min`, `max` | `numero` | No | Números finitos, inclusivos. |
| `opciones` | `opcion` | Sí (para ese tipo) | Lista de 1 a 50. |

### 8.3 Tipos

| Tipo | Control en el panel | `predeterminado` | Se guarda en `.env` como | Lectura en tu código |
| ---- | ------------------- | ---------------- | ------------------------ | -------------------- |
| `texto` | Caja de texto | `string` | El texto | `process.env.X` |
| `secreto` | Caja oculta | **No permitido** (invalida el archivo) | El texto | `process.env.X` |
| `numero` | Caja numérica | `number` finito | `String(n)` (ej. `9000`) | `Number(process.env.X)` |
| `booleano` | Interruptor | `boolean` | `true` o `false` | `process.env.X === "true"` |
| `opcion` | Lista desplegable | Uno de los `valor` | El `valor` elegido | `process.env.X` |

**`opciones`:** cada elemento es un `string` (valor y etiqueta iguales) o `{ "valor": "es", "etiqueta": "Español" }`. El `valor` debe ser un texto no vacío de hasta 100 caracteres, sin caracteres de control; la `etiqueta` un texto de hasta 100. Los valores no pueden repetirse.

### 8.4 Claves reservadas

Estas claves **no se pueden declarar** (invalidan el archivo):

`PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMFILES`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `PORT`, `SESSION_MINUTOS`, `ACCESS_TOKEN_MINUTOS`, `REFRESH_TOKEN_DIAS`, `OAUTH_CODE_MINUTOS`, `URL_PUBLICA_BASE`, `URL_PUBLICA`, `OAUTH_ISSUER`, `CONFIG_ABRIR`, `TUNNEL_TOKEN`, `TUNNEL_TRANSPORT_PROTOCOL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.

**Prefija siempre** con el nombre del módulo (`MIMODULO_TOKEN`): todos los módulos comparten el mismo `process.env`, y si dos declaran la misma clave gana el primero que se carga (ver 9.2).

### 8.5 Validación al guardar

Reglas que aplica el servidor del panel al recibir valores (`validarAjustes`):

| Tipo | Regla |
| ---- | ----- |
| `texto` / `secreto` | Debe ser `string`. Se recorta (o, con `quitarEspacios`, se le quitan todos los espacios). Vacío: en `texto` **borra** el valor; en `secreto` **se ignora** (conserva el actual). Luego: ≤ `longitudMax`, sin caracteres de control, cumple `patron` si existe, y debe poder escribirse en `.env` (ver 9.3). |
| `numero` | Número o texto que cumpla `^-?\d+(\.\d+)?$`. `""` borra. Debe estar entre `min` y `max` si existen. |
| `booleano` | Debe ser exactamente `true` o `false` (JSON). |
| `opcion` | `""` o `null` borran. Si no, debe ser uno de los `valor` declarados. |

Otras reglas:

- Una clave enviada que no existe en el esquema da error `El ajuste X no existe.`
- La lista `borrar` elimina esas claves del `.env` (única forma de quitar un secreto).
- **Obligatorios:** un campo `obligatorio` (no booleano) sin valor final, sin `predeterminado`, da error **solo** si estamos en el asistente de primera vez, o si ya tenía un valor guardado (no se puede vaciar). Así un módulo sin configurar no impide guardar los demás. Un campo con `predeterminado` se puede vaciar.

> **Importante: `patron` no se ancla solo.** El servidor evalúa `new RegExp(patron).test(valor)`, que busca coincidencias en **cualquier parte** del texto. Escribe `^` y `$` para exigir coincidencia completa (ver sección 17).

### 8.6 Cuando el archivo es inválido

Si `configuracion.json` no se puede leer o no valida, el servidor **lo ignora**: no aparece el bloque en el panel, el módulo funciona igual y en consola sale una vez:

```
[configuracion] modules/<nombre>/configuracion.json no es válido y se ignora:
 - campos[0].clave debe ser MAYUSCULAS, números y guiones bajos (ejemplo: MIMODULO_API_KEY).
```

Los mensajes de error indican el índice del campo (`campos[i]`).

### 8.7 Ejemplo con todos los tipos

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
      "quitarEspacios": true,
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
      "opciones": [ { "valor": "es", "etiqueta": "Español" }, { "valor": "en", "etiqueta": "Inglés" }, "pt" ],
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

Lectura en `module.js` aplicando los mismos valores por defecto:

```js
const cfg = () => ({
  apiKey:   process.env.TRADUCTOR_API_KEY || "",
  url:      process.env.TRADUCTOR_URL || "https://api.ejemplo.com",
  idioma:   process.env.TRADUCTOR_IDIOMA || "es",
  timeoutS: Number(process.env.TRADUCTOR_TIMEOUT ?? 15),
  cache:    (process.env.TRADUCTOR_CACHE ?? "true") === "true",
});
```

### 8.8 Asistente de primera vez

El asistente solo configura la cuenta, el túnel y, si existe y es válido, el módulo `discord`. Los ajustes de cualquier otro módulo se editan después en *Configuración → Módulos*.

---

## 9. Cómo se guardan y cargan los ajustes (`.env`)

### 9.1 Archivo

`modules/<nombre>/.env`: una línea `CLAVE=valor` por ajuste. Al guardar, el panel:

- cambia solo las líneas de las claves afectadas y **respeta el resto del archivo** (otras líneas y comentarios);
- borra la línea si el valor es `""`;
- escribe de forma atómica (archivo temporal + renombrado);
- crea la carpeta si no existe.

### 9.2 Carga en `process.env`

`cargarEnvModulo(nombre)` (llamada por `index.js` antes del `import`):

1. Si no hay `configuracion.json` válido, **no carga nada**. (Un `.env` sin `configuracion.json` lo ignora el servidor; el módulo puede leerlo por su cuenta, como hace `discord` con `dotenv`.)
2. Parsea el `.env` con la expresión `^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$` por línea, y quita un par de comillas simples o dobles que rodee el valor.
3. Para cada campo **declarado**: si el `.env` tiene la clave **y** `process.env[clave] === undefined`, la copia.

Consecuencias:

- **Gana el entorno del sistema.** Si la variable ya existe en el entorno del proceso, el valor del panel no se aplica.
- **Gana el primer módulo cargado** si dos declaran la misma clave.
- Solo se cargan claves declaradas; el resto del `.env` se ignora.
- Todo valor llega como `string`. Convierte tú números y booleanos.
- Los cambios del panel se escriben al instante en el `.env`, pero el módulo los ve **al reiniciar**.

### 9.3 Cómo se escribe un valor (`formatearValorEnv`)

| Caso | Se escribe |
| ---- | ---------- |
| Vacío | Se borra la línea |
| Solo `A-Z a-z 0-9 _ @ % + = : , . / -` | Tal cual |
| Contiene otros caracteres y no tiene `'` | Entre comillas simples: `'valor con espacios'` |
| Tiene `'`, no tiene `"` y no contiene `\n`, `\r` ni `\t` literales (barra + letra) | Entre comillas dobles |
| Cualquier otro caso (mezcla ambas comillas) | **Se rechaza** el valor |

Los saltos de línea reales nunca se aceptan (caracteres de control), por lo que no se puede inyectar otra variable.

---

## 10. API del panel relacionada con módulos

El panel es un servidor HTTP aparte que escucha **solo en `127.0.0.1`** (puerto 3100 por defecto; si está ocupado prueba hasta 20 puertos siguientes, saltando el del servidor MCP). El túnel nunca lo expone.

### 10.1 Acceso

1. Al arrancar se imprime `http://localhost:<puerto>/?t=<TOKEN>`; el token cambia en cada arranque.
2. Abrir ese enlace crea la cookie `mcp_cfg` (`HttpOnly`, `SameSite=Strict`).
3. Toda llamada a `/api/...` necesita la cookie **y** la cabecera `X-Configuracion: 1`.
4. Se rechaza todo `Host` que no sea `localhost:<puerto>` o `127.0.0.1:<puerto>`.
5. Los cuerpos deben ser `application/json` y pesar menos de 64 KB (`413` / `415` si no).

### 10.2 Rutas

| Ruta | Descripción |
| ---- | ----------- |
| `GET /api/estado` | Estado en vivo; incluye `modulosCargados` (nombres de carpeta). |
| `GET /api/config` | Configuración general y lista de módulos `{ nombre, descripcion, activo }`. |
| `PUT /api/config` | Acepta un subconjunto de `config.json`. `modulos.deshabilitados` es una lista de nombres válidos (máx. 200, sin duplicados). |
| `GET /api/modulos/ajustes` | Módulos con `configuracion.json` válido y sus valores actuales. |
| `PUT /api/modulos/ajustes` | Guarda ajustes de 1 a 100 módulos, **de forma atómica** (si algo falla, no se escribe nada). |
| `POST /api/servidor/reiniciar` | Relanza el servidor (solo Windows). |

### 10.3 `GET /api/modulos/ajustes`

```json
{
  "modulos": [
    {
      "nombre": "traductor",
      "titulo": "Traductor",
      "descripcion": "Conecta el módulo con tu servicio de traducción.",
      "activo": true,
      "campos": [
        { "clave": "TRADUCTOR_URL", "etiqueta": "Servidor", "tipo": "texto",
          "obligatorio": false, "longitudMax": 200,
          "predeterminado": "https://api.ejemplo.com", "valor": "" },
        { "clave": "TRADUCTOR_API_KEY", "etiqueta": "API key", "tipo": "secreto",
          "obligatorio": true, "longitudMax": 500, "guardado": true }
      ]
    }
  ]
}
```

- `secreto`: trae `guardado` (booleano) y **nunca** `valor`.
- `booleano`: `valor` booleano; si no hay nada guardado, usa `predeterminado === true`.
- Los demás: `valor` como texto (`""` si no hay).
- No se envían `patron`, `mensajePatron` ni `quitarEspacios`: la validación vive solo en el servidor.

### 10.4 `PUT /api/modulos/ajustes`

```json
{
  "modulos": {
    "traductor": {
      "valores": { "TRADUCTOR_URL": "https://api.otro.com", "TRADUCTOR_CACHE": false },
      "borrar": ["TRADUCTOR_API_KEY"]
    }
  }
}
```

Respuesta `200`: `{ "guardados": ["traductor"], "modulos": [ ... ] }`. Respuesta `400`: `{ "error": "...", "errores": ["Traductor: ...", "..."] }`. Un módulo que no declara ajustes válidos da `El módulo "x" no declara ajustes.`

### 10.5 Códigos de error

| Código | Significa |
| ------ | --------- |
| `400` | Datos inválidos |
| `401` | Falta o caducó la cookie |
| `403` | Falta `X-Configuracion: 1`, `Host` no permitido o contraseña incorrecta |
| `404` | Ruta inexistente |
| `409` | Estado incompatible (p. ej. asistente ya completado) |
| `413` / `415` | Cuerpo demasiado grande / no es JSON |
| `429` | Bloqueo de 60 s tras 5 contraseñas erróneas |
| `501` | Acción no disponible en esta instalación |

---

## 11. `module_info.json`

El **cargador no lo usa**. Es documentación del módulo; algunos módulos lo leen por su cuenta (`ocr` toma de ahí el nombre del script: `info.main`).

El panel solo usa su campo `descripcion`:

- Se muestra bajo el interruptor del módulo en *Módulos*.
- Se recorta a 160 caracteres (157 + `...`).
- Solo se consulta si el nombre de la carpeta **no** coincide con uno de los módulos incluidos (esos tienen su descripción fija en `configuracion.js`).

Estructura que usan los módulos del proyecto (convención, no obligatoria):

```json
{
  "nombre": "mi_modulo",
  "version": "1.0.0",
  "descripcion": "Una línea clara de lo que hace (se muestra en el panel).",
  "main": "main.py",
  "funciones": [
    {
      "nombre": "mi_modulo_accion",
      "descripcion": "Qué hace.",
      "expuestaComo": { "mcp": "mi_modulo_accion", "rest": "POST /api/mi_modulo/accion" },
      "parametros": { "dato": { "tipo": "string", "requerido": true } },
      "retorna": { "resultado": "string" }
    }
  ],
  "auth": { "mcp": "sesion (token de iniciar_sesion)", "rest": "api_key (header x-api-key)" },
  "componentes": {
    "python": { "version_minima": "3.10", "paquetes": ["..."] },
    "externos": [ { "nombre": "...", "ruta": "...", "autocontenido": false, "notas": "..." } ]
  },
  "endpointsInternos": [ { "metodo": "GET", "ruta": "/salud", "descripcion": "Worker activo" } ]
}
```

---

## 12. Utilidades compartidas (`modules/_shared`)

Importa con rutas relativas desde tu módulo: `import { ... } from "../_shared/ps.js"`. La carpeta no tiene `module.js`, por eso el cargador no la trata como módulo.

### 12.1 `python.js`

```js
resolverPython(carpetaModulo: string): string
```

Devuelve el intérprete a usar, por prioridad:

1. `<raíz>/python-embed/python.exe` si existe **y** existe `<carpetaModulo>/vendor`. (La raíz es `carpetaModulo/../..`.)
2. `<carpetaModulo>/venv/Scripts/python.exe` si existe.
3. `"python"` (el del `PATH`).

Pásale siempre `__dirname` del `module.js`.

### 12.2 `ps.js`

```js
ejecutarPS(script: string, { timeoutMs = 15000 } = {}): Promise<string>
limpiarParaPS(valor: any): string
aBase64(texto: string): string
```

| Función | Detalle |
| ------- | ------- |
| `ejecutarPS` | Ejecuta `powershell.exe -NoProfile -NonInteractive -Command <script>` con `execFile`. `maxBuffer` 20 MB. Devuelve `stdout`. Lanza si el proceso falla o supera `timeoutMs`. |
| `limpiarParaPS` | `String(valor)` quitando `"`, `'`, `` ` ``, `$`, `;`, `|` y `&`. Solo para interpolar un valor dentro del texto de un script. **No es un saneador completo** (no toca saltos de línea, paréntesis ni otros caracteres): si puedes, evita interpolar. |
| `aBase64` | Codifica el texto en **UTF-8** y devuelve base64. No sirve para `-EncodedCommand` (que exige UTF-16LE); sirve para pasar datos y decodificarlos dentro del script con `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(...))`. |

Alternativa más segura para pasar texto arbitrario: **stdin**, como hace `portapapeles`:

```js
const ps = spawn("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]);
ps.stdin.write(texto ?? "");
ps.stdin.end();
```

---

## 13. Workers en Python

Un módulo puede delegar trabajo pesado o específico (OCR, PDF, imágenes) en un script de Python que corre como servidor HTTP local. Es el patrón de `ocr`.

### 13.1 Contrato del worker

| Requisito | Detalle |
| --------- | ------- |
| Puerto | Lo recibe por argumento: `--puerto N`. |
| Interfaz | Solo `127.0.0.1`. Nunca `0.0.0.0`. |
| Salud | `GET /salud` devuelve `200` con JSON, por ejemplo `{ "modulo": "...", "estado": "activo", "puerto": N }`. |
| Respuestas | JSON UTF-8 con `Content-Length`. Errores con código HTTP `4xx/5xx` y `{ "error": "..." }`. |
| Logs | Por `stdout`/`stderr`; el módulo de Node los reenvía a la consola. |

### 13.2 Plantilla de `main.py`

```python
# modules/mi_modulo/main.py
import os as _os
import site as _site

# Dependencias instaladas por instalar-dependencias-python.ps1
_VENDOR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "vendor")
if _os.path.isdir(_VENDOR):
    _site.addsitedir(_VENDOR)
    _dlls = _os.path.join(_VENDOR, "pywin32_system32")   # solo si usas pywin32
    if _os.path.isdir(_dlls):
        _os.add_dll_directory(_dlls)

import argparse
import http.server
import json
import socketserver

_parser = argparse.ArgumentParser()
_parser.add_argument("--puerto", type=int, default=9000)
_args, _ = _parser.parse_known_args()
PORT = _args.puerto


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/salud":
            self._json(200, {"modulo": "mi_modulo", "estado": "activo", "puerto": PORT})
        else:
            self._json(404, {"error": "ruta no encontrada"})

    def do_POST(self):
        if self.path != "/accion":
            self._json(404, {"error": "ruta no encontrada"})
            return
        try:
            largo = int(self.headers.get("Content-Length", "0"))
            datos = json.loads(self.rfile.read(largo) or b"{}")
            self._json(200, {"ok": True, "eco": datos})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"[mi_modulo] worker escuchando en http://127.0.0.1:{PORT}")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
```

Notas:

- `ocr` enlaza a `localhost` y hace `fetch` a `http://localhost:<puerto>`. Funciona, pero `registro.js` comprueba la disponibilidad del puerto en `127.0.0.1`; para ser coherente, usa `127.0.0.1` en ambos lados.
- `ocr` recibe archivos como `multipart/form-data` con un parser manual; si no necesitas multipart, JSON es más simple.
- Los módulos Python se instalan con `instalar-dependencias-python.ps1`, que prepara `python-embed/` y `modules/<nombre>/vendor/`.

---

## 14. Dependencias

| Necesitas | Cómo |
| --------- | ---- |
| Paquetes del proyecto | Ya disponibles desde cualquier `module.js`: `zod`, `express`, `adm-zip`, `@modelcontextprotocol/sdk` (resolución normal hacia `node_modules/` de la raíz). |
| Paquetes propios | `modules/<nombre>/package.json` + `npm install --omit=dev` dentro de la carpeta. Añade `modules/<nombre>/node_modules/` al `.gitignore`. Atrapa el `import` si puede fallar (sección 16.3). |
| Python | `main.py` + `requirements.txt` (sección 13). |
| Binarios externos | No los incluyas en el repo. Documenta la instalación, busca en rutas conocidas y devuelve un `isError` claro si faltan. `instalar-todo.ps1` es el lugar para automatizar instalaciones comunes (Tesseract se instala allí). |
| Apps auxiliares (Electron, etc.) | Dentro de la carpeta del módulo, con rutas relativas a `__dirname`, lanzadas desde `iniciar` o bajo demanda. |

`discord` importa archivos `.ts` directamente (`./src/tools/index.ts`). Eso depende del Node 24 portable del proyecto (`node-embed/`); no lo asumas en tu módulo si no necesitas TypeScript.

---

## 15. Seguridad

El módulo corre con los permisos de tu usuario de Windows y el servidor suele estar publicado por un túnel. Trátalo así.

**Acceso**

- `verificarAcceso(clave)` al inicio de **cada** herramienta; `verificarApiKey(...)` al inicio de **cada** ruta REST. Sin excepciones.
- No abras servidores HTTP propios sin autenticación. Si abres un puerto, solo en `127.0.0.1`.
- Las sesiones están en memoria: se pierden al reiniciar y expiran a los `sesionMinutos` (120 por defecto). Con OAuth, renovar el access token no alarga la sesión *(observado en el código)*. Tus mensajes de error deben ser claros cuando `errorClave()` aparezca.

**Entradas**

- Valida con zod: tipos, longitudes, rangos, `enum`.
- Si recibes rutas de archivo, normalízalas con `path.resolve` y comprueba que queden dentro de la carpeta esperada.
- **Nunca construyas comandos concatenando texto.** Usa `execFile`/`spawn` con arreglo de argumentos y `shell: false`. Para PowerShell, prefiere stdin o argumentos; usa `limpiarParaPS` solo como último recurso.
- Limita tamaños de cuerpo, salida de procesos y archivos leídos. Recuerda que base64 aumenta el tamaño ~33 % y que el cuerpo HTTP máximo es 40 MB.

**Secretos**

- Declara tokens y claves con `tipo: "secreto"`: el panel nunca los devuelve al navegador.
- No los imprimas en consola ni los incluyas en la respuesta de una herramienta. Si registras parámetros, redacta los que parezcan secretos (`discord` oculta `token`, `password`, `contrasena`, `secret`, `authorization`, `webhook`).
- `modules/*/.env` está en `.gitignore`. No lo subas nunca.

**Operaciones destructivas**

- Indica el riesgo en la `description` y marca `annotations.destructiveHint: true`.
- En acciones irreversibles, exige `confirmar: z.literal(true)`.

**Robustez**

- Nada de excepciones sin capturar: en REST, `try/catch` siempre; en herramientas, `isError: true`.
- Limpia lo que abras (procesos, sockets, temporales) con `process.on("exit", ...)`, ya que `detener()` no se llama.

---

## 16. Plantillas completas

### 16.1 Módulo mínimo (solo MCP)

`modules/hola/module.js`

```js
import { z } from "zod";

export default {
  nombre: "hola",

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "hola_saludar",
      {
        title: "Saludar",
        description: "Devuelve un saludo para la persona indicada.",
        inputSchema: {
          nombre: z.string().min(1).max(100).describe("A quién saludar"),
          clave: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ nombre, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        return { content: [{ type: "text", text: `Hola, ${nombre}` }] };
      },
    );
  },
};
```

### 16.2 Módulo completo (MCP + REST + ajustes + destructivo)

`modules/notas/configuracion.json`

```json
{
  "titulo": "Notas",
  "descripcion": "Guarda notas de texto en una carpeta.",
  "campos": [
    { "clave": "NOTAS_CARPETA", "etiqueta": "Carpeta de notas", "tipo": "texto",
      "longitudMax": 260, "ayuda": "Vacío = carpeta 'datos' dentro del módulo." },
    { "clave": "NOTAS_MAX_BYTES", "etiqueta": "Tamaño máximo por nota (bytes)", "tipo": "numero",
      "min": 100, "max": 1000000, "predeterminado": 20000 }
  ]
}
```

`modules/notas/module.js`

```js
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Se leen al usarse, con los mismos valores por defecto que declara configuracion.json
const carpeta = () => process.env.NOTAS_CARPETA || path.join(__dirname, "datos");
const maxBytes = () => Number(process.env.NOTAS_MAX_BYTES ?? 20000);

function rutaNota(nombre) {
  const base = path.resolve(carpeta());
  const destino = path.resolve(base, `${nombre}.txt`);
  if (!destino.startsWith(base + path.sep)) throw new Error("Nombre de nota no válido");
  return destino;
}

const NOMBRE = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Nombre de la nota (letras, números, _ y -)");

const ok = (texto) => ({ content: [{ type: "text", text: texto }] });
const fallo = (err) => ({ content: [{ type: "text", text: `Error: ${err?.message || err}` }], isError: true });

export default {
  nombre: "notas",
  info: { nombre: "notas" },

  registrarMcp(server, { verificarAcceso, errorClave }) {
    server.registerTool(
      "notas_guardar",
      {
        title: "Guardar nota",
        description: "Crea o reemplaza una nota de texto. Máximo según el ajuste de tamaño del módulo.",
        inputSchema: { nombre: NOMBRE, texto: z.string(), clave: z.string().optional() },
      },
      async ({ nombre, texto, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try {
          if (Buffer.byteLength(texto, "utf-8") > maxBytes()) return fallo(new Error("La nota supera el tamaño máximo"));
          fs.mkdirSync(carpeta(), { recursive: true });
          fs.writeFileSync(rutaNota(nombre), texto, "utf-8");
          return ok(`Nota guardada: ${nombre}`);
        } catch (err) { return fallo(err); }
      },
    );

    server.registerTool(
      "notas_borrar",
      {
        title: "Borrar nota",
        description: "Elimina una nota. Irreversible: requiere confirmar=true.",
        inputSchema: { nombre: NOMBRE, confirmar: z.literal(true), clave: z.string().optional() },
        annotations: { destructiveHint: true },
      },
      async ({ nombre, clave }) => {
        if (!(await verificarAcceso(clave))) return errorClave();
        try { fs.unlinkSync(rutaNota(nombre)); return ok(`Nota borrada: ${nombre}`); }
        catch (err) { return fallo(err); }
      },
    );
  },

  registrarRest(router, { verificarApiKey }) {
    router.get("/notas/:nombre", (req, res) => {
      if (!verificarApiKey(req.headers["x-api-key"])) return res.status(401).json({ error: "API key invalida" });
      try {
        res.json({ texto: fs.readFileSync(rutaNota(req.params.nombre), "utf-8") });
      } catch (err) {
        res.status(404).json({ error: err.message });
      }
    });
  },
};
```

### 16.3 Módulo opcional que se desactiva solo si falta algo

Patrón de `discord`: importar dependencias dentro de `try/catch`, recordar el error y no registrar nada.

```js
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let libreria = null;
let errorCarga = null;

try {
  libreria = await import("una-dependencia-propia");
} catch (err) {
  errorCarga = err;
  console.warn("[mi_modulo] Módulo desactivado:", err?.message || err);
}

export default {
  nombre: "mi_modulo",

  registrarMcp(server, ctx) {
    if (errorCarga) return;       // el servidor sigue arrancando sin este módulo
    /* ...registerTool... */
  },
};
```

### 16.4 Módulo con worker en Python

Combina la sección 7.2 (`module.js` con `iniciar` y `asegurarWorker`) y la 13.2 (`main.py`). En cada herramienta:

```js
async ({ dato, clave }) => {
  if (!(await verificarAcceso(clave))) return errorClave();
  try {
    await asegurarWorker();
    const r = await fetch(`${URL_WORKER}/accion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dato }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }], isError: !r.ok };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
```

---

## 17. Diferencias y puntos delicados detectados en el código

Estos puntos salen de leer el código; no son errores documentados por el proyecto.

| # | Qué | Detalle | Qué hacer |
| - | --- | ------- | --------- |
| 1 | `patron` no está anclado | `MODULE_API.md` dice que se aplica "al valor completo". El código hace `new RegExp(patron).test(valor)`, que acepta coincidencias parciales. | Escribe siempre `^...$`. |
| 2 | `arguments` ausente | La inyección de `clave` solo ocurre si `params.arguments` es un objeto. Un `tools/call` sin `arguments` no recibe clave y falla con "Sesion invalida". | Muchos clientes envían `{}`; si una herramienta sin parámetros falla con OAuth, sospecha de esto. |
| 3 | REST `async` sin `try/catch` | Express 4 no captura el rechazo. En Node ≥ 15 una promesa rechazada sin capturar puede terminar el proceso. Algunos manejadores existentes (p. ej. `portapapeles`) no tienen `try/catch`. | `try/catch` en todo manejador `async`. |
| 4 | `verificarApiKey` | Compara con `===` (no es de tiempo constante), a diferencia del login, que usa `timingSafeEqual`. | Aceptable para uso personal; considera `crypto.timingSafeEqual` si lo expones mucho. |
| 5 | `detener()` | El servidor no la llama nunca. | `process.on("exit", ...)`. |
| 6 | `iniciar` bloquea el arranque | Se espera en serie antes de `app.listen`. | Mantenlo corto; no esperes a servicios lentos. |
| 7 | Claves de entorno compartidas | Todos los módulos escriben en el mismo `process.env`; gana la primera carga y el entorno del sistema. | Prefija las claves con el nombre del módulo. |
| 8 | Sesión OAuth | El access token se renueva con refresh token, pero la sesión MCP asociada conserva su caducidad original (`sesionMinutos`). | Tenlo presente al depurar "Sesion invalida" tras un rato. |

---

## 18. Pruebas, depuración y errores frecuentes

### Procedimiento

1. **Sintaxis:** `node --check modules/mi_modulo/module.js`.
2. **Ajustes:** abre el panel. Si no aparece el bloque, mira la consola: indica qué campo falló.
3. **Reinicia** el servidor y busca `Modulo cargado: <nombre>` (con `(puerto N)` si usa `iniciar`).
4. **Herramientas MCP:** pide a tu cliente que use la herramienta, o usa el [MCP Inspector](https://github.com/modelcontextprotocol/inspector) apuntando a `http://localhost:3000/mcp` (requiere token OAuth). Puerto distinto si cambiaste `servidor.puerto`.
5. **REST:** `curl.exe -H "x-api-key: TU_KEY" http://localhost:3000/api/mi_modulo/estado`.
6. **Ajustes:** cambia un valor en el panel, guarda y revisa `modules/<nombre>/.env`; reinicia y comprueba que tu código lo recibe (sin imprimir secretos reales).
7. **Aislar:** desactiva el módulo con su interruptor (o añádelo a `modulos.deshabilitados`).

### Errores frecuentes

| Síntoma | Causa probable | Solución |
| ------- | -------------- | -------- |
| La carpeta no se carga | Falta `module.js` o el archivo tiene otro nombre | Debe llamarse exactamente `module.js` |
| El servidor no arranca tras añadir el módulo | Excepción al importar, en `registrarRest` o en `iniciar` | Atrapa errores; desactiva el módulo si falta algo |
| `/mcp` devuelve 500 en todo | `registrarMcp` lanzó, normalmente por **nombre de herramienta repetido** | Prefija los nombres |
| Siempre "Sesion invalida" | `clave` no declarada en `inputSchema`, o `verificarAcceso` sin `clave`, o sesión caducada | `clave: z.string().optional()` y `verificarAcceso(clave)` |
| No aparece el bloque de ajustes | `configuracion.json` inválido, sin `campos`, o carpeta con nombre no válido | Revisa la consola y el nombre de la carpeta |
| `process.env.X` vacío | No reiniciaste, el campo está vacío, o ya existía en el entorno del sistema | Reinicia; el entorno del sistema gana al `.env` |
| El valor por defecto no se aplica | `predeterminado` solo lo muestra el panel | Usa `?? valor` en tu código |
| `clave "X" está reservada` | Declaraste una variable de sistema | Usa un prefijo propio |
| `ECONNREFUSED` al worker | No arrancó o usa otro puerto | Usa el que recibes en `iniciar(puerto)` y espera a `/salud` |
| Worker huérfano al cerrar | No se mata el proceso hijo | `process.on("exit", () => worker?.kill())` |
| El `.env` rechaza un valor | Mezcla comillas simples y dobles | Cambia el valor |

---

## 19. Checklist de publicación

- [ ] La carpeta cumple `^[A-Za-z0-9_-]{1,64}$` y coincide con `nombre`.
- [ ] Todas las herramientas llevan el prefijo del módulo y declaran `clave`.
- [ ] Todas las herramientas llaman a `verificarAcceso` y todas las rutas a `verificarApiKey`.
- [ ] Ningún nombre de herramienta choca con los de las secciones 5.5.
- [ ] `registrarMcp` no tiene efectos secundarios (se ejecuta en cada petición).
- [ ] Todos los manejadores `async` (MCP y REST) capturan errores.
- [ ] `configuracion.json` válido (se verifica abriendo el panel), claves con prefijo, y patrones anclados con `^...$`.
- [ ] El código aplica los mismos valores por defecto que `predeterminado`.
- [ ] No hay secretos, `.env` ni `node_modules` en la carpeta publicada.
- [ ] Los procesos hijos se limpian con `process.on("exit", ...)`.
- [ ] `module_info.json` con `nombre`, `version` y `descripcion` (≤ 160 caracteres).
- [ ] `README.md` del módulo: qué hace, herramientas, ajustes, dependencias externas, instalación.

Para **instalar** un módulo ajeno: copia su carpeta dentro de `modules/`, ejecuta `npm install --omit=dev` si trae `package.json`, reinicia el servidor y configúralo en *Configuración → Módulos*.

---

## 20. Tabla de límites y constantes

| Concepto | Valor |
| -------- | ----- |
| Rango de puertos para `iniciar` | 9000–9999 (`127.0.0.1`) |
| Puerto del servidor MCP | 3000 (configurable) |
| Puerto del panel | 3100 (configurable; prueba hasta +20 si está ocupado) |
| Cuerpo JSON máximo (`/mcp`, `/api`) | 40 MB |
| Cuerpo máximo del panel | 64 KB |
| Transferencia máxima de las herramientas de archivos del núcleo | 25 MB |
| Ajustes por módulo | 1–50 campos |
| Módulos por `PUT /api/modulos/ajustes` | 1–100 |
| Módulos en `modulos.deshabilitados` | hasta 200 |
| `titulo` / `descripcion` de ajustes | 60 / 300 caracteres |
| `etiqueta` / `ayuda` / `placeholder` | 80 / 300 / 100 caracteres |
| `longitudMax` | 1–4096 (500 por defecto) |
| `patron` / `mensajePatron` | 300 / 200 caracteres |
| `opciones` | 1–50; `valor` y `etiqueta` hasta 100 |
| `clave` de ajuste | `^[A-Z][A-Z0-9_]{0,63}$` |
| Nombre de módulo para el panel | `^[A-Za-z0-9_-]{1,64}$` |
| `descripcion` de `module_info.json` en el panel | 160 caracteres (157 + `...`) |
| `ejecutarPS` | timeout 15 000 ms, `maxBuffer` 20 MB |
| Sesión tradicional / OAuth (por defecto) | sesión 120 min; access token 60 min; refresh token 30 días; código OAuth 5 min |

---

## 21. Qué no se verificó

Para ser exactos sobre el alcance de esta referencia:

- **No se ejecutó** el servidor ni ningún módulo; todo sale de leer el código.
- **No se leyeron** los módulos `abrir`, `buscar_archivos`, `captura_pantalla`, `control_remoto`, `convertir`, `escanear`, `imprimir`, `info_sistema`, `listar_ventanas`, `notificacion`, `procesos`, `red` ni `volumen`; ni `configuracion-ui/`, ni los scripts `.ps1`/`.bat`.
- **No se abrió** `modules/module-example.zip`; no se sabe qué plantilla contiene.
- `mcp-server.exe` y la dependencia `@yao-pkg/pkg` sugieren que existe una versión empaquetada, pero **no se comprobó** cómo carga los módulos ese ejecutable (si lee `modules/` del disco o los incluye dentro).
- Los comportamientos propios del SDK de MCP (por ejemplo, el error exacto al repetir un nombre de herramienta) se describen según su comportamiento habitual; confírmalos contra la versión instalada (`^1.30.0`) si dependes de ellos.
