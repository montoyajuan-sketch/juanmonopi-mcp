// modules/notificacion/electron-overlay/main.js
// Ventana Electron transparente, sin bordes, siempre encima, anclada
// abajo a la derecha de la pantalla. Carga la misma pagina HTML que
// generaba el mcpserver (http://localhost:PUERTO/pagina) pero esta vez
// con transparencia real de verdad (no la aproximacion con chrome --app).
//
// Uso: electron main.js --puerto=9005
//
// El renderer (notificacion.html) manda mensajes por IPC para:
//  - avisar si el mouse esta arriba de una tarjeta o no (para hacer la
//    ventana "click-through" cuando no hay nada abajo del cursor)
//  - avisar si hay alguna notificacion visible o no (para esconder la
//    ventana del todo cuando no hay nada que mostrar, en vez de dejar
//    un rectangulo transparente pero clickeable tapando el escritorio)

const { app, BrowserWindow, ipcMain, screen } = require("electron");

const ANCHO_VENTANA = 380;
const ALTO_VENTANA = 480;
const MARGEN_DERECHA = 12;
const MARGEN_ABAJO = 56; // deja espacio para la barra de tareas

function leerArg(nombre, porDefecto) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : porDefecto;
}

const PUERTO = leerArg("puerto", "9005");

let ventana = null;

function crearVentana() {
  const { width: w, height: h } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.max(0, w - ANCHO_VENTANA - MARGEN_DERECHA);
  const y = Math.max(0, h - ALTO_VENTANA - MARGEN_ABAJO);

  ventana = new BrowserWindow({
    width: ANCHO_VENTANA,
    height: ALTO_VENTANA,
    x,
    y,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // no le roba el foco a lo que estes usando
    webPreferences: {
      preload: require("path").join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ventana.setAlwaysOnTop(true, "screen-saver");
  ventana.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Por default, que no intercepte clicks (deja pasar el mouse al escritorio
  // o a lo que haya debajo). Se desactiva momentaneamente cuando el mouse
  // esta arriba de una tarjeta, ver ipcMain.on("notif-hover", ...) abajo.
  ventana.setIgnoreMouseEvents(true, { forward: true });

  ventana.loadURL(`http://localhost:${PUERTO}/pagina`);
  ventana.hide(); // arranca oculta, se muestra cuando hay algo que notificar

  ventana.on("closed", () => { ventana = null; });
}

ipcMain.on("notif-hover", (_event, sobreTarjeta) => {
  if (!ventana) return;
  ventana.setIgnoreMouseEvents(!sobreTarjeta, { forward: true });
});

ipcMain.on("notif-hay-contenido", (_event, hayContenido) => {
  if (!ventana) return;
  if (hayContenido) {
    if (!ventana.isVisible()) ventana.showInactive(); // se muestra sin robar foco
  } else {
    ventana.hide();
  }
});

app.disableHardwareAcceleration(); // evita parpadeos raros en ventanas transparentes

app.whenReady().then(crearVentana);

app.on("window-all-closed", (e) => {
  // esta ventanita vive todo lo que vive el proceso: no queremos que Electron
  // se cierre solo por "todas las ventanas cerradas" en un momento raro.
  e.preventDefault?.();
});
