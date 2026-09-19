// modules/notificacion/electron-overlay/preload.js
// Puente seguro entre la ventana overlay (notificacion.html) y el proceso
// principal de Electron. No expone ipcRenderer completo, solo lo puntual
// que necesita la pagina de notificaciones.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  // avisa si el mouse esta arriba de una tarjeta (para activar/desactivar
  // el click-through de la ventana)
  reportarHover: (sobreTarjeta) => ipcRenderer.send("notif-hover", sobreTarjeta),
  // avisa si hay alguna notificacion visible (para mostrar/ocultar la
  // ventana entera, asi no queda un rectangulo invisible tapando clicks)
  reportarContenido: (hayContenido) => ipcRenderer.send("notif-hay-contenido", hayContenido),
});
