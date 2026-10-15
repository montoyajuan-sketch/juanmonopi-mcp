// Interfaz de la configuración. Todo el texto dinámico se inserta con
// textContent (nunca innerHTML), y la página solo habla con /api del mismo origen.
(() => {
  "use strict";

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

  const VISTAS = ["inicio", "cuenta", "tunel", "servidor", "modulos", "seguridad", "acerca"];
  const TITULOS = {
    inicio: "Inicio", cuenta: "Cuenta", tunel: "Túnel", servidor: "Servidor",
    modulos: "Módulos", seguridad: "Seguridad", acerca: "Acerca de"
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  let datosConfig = null;
  let apiKeyValor = null;
  let apiKeyVisible = false;
  let panelBloqueado = false;

  // ---------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------

  function crear(etiqueta, clase, texto) {
    const e = document.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  function icono(id, clase = "icono") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", clase);
    svg.setAttribute("aria-hidden", "true");
    const uso = document.createElementNS(SVG_NS, "use");
    uso.setAttribute("href", "#" + id);
    svg.append(uso);
    return svg;
  }

  async function api(ruta, { metodo = "GET", cuerpo } = {}) {
    const resp = await fetch("/api" + ruta, {
      method: metodo,
      headers: {
        "X-Configuracion": "1",
        ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      cache: "no-store"
    });

    let datos = {};
    try { datos = await resp.json(); } catch { /* sin cuerpo */ }

    if (!resp.ok) {
      const error = new Error(datos.error || `Error ${resp.status}`);
      error.status = resp.status;
      throw error;
    }
    return datos;
  }

  function toast(texto, tipo = "ok") {
    const caja = crear("div", `toast ${tipo}`);
    caja.append(icono(tipo === "ok" ? "i-ok" : "i-error"), crear("span", "", texto));
    $("#toasts").append(caja);
    setTimeout(() => caja.remove(), tipo === "ok" ? 4000 : 8000);
  }

  function confirmar(titulo, texto, boton = "Aceptar") {
    const dialogo = $("#dialogo");
    $("#dialogo-titulo").textContent = titulo;
    $("#dialogo-texto").textContent = texto;
    $("#dialogo-si").textContent = boton;
    dialogo.returnValue = "no";
    return new Promise((resolver) => {
      dialogo.addEventListener("close", () => resolver(dialogo.returnValue === "si"), { once: true });
      dialogo.showModal();
    });
  }

  async function ocupado(boton, tarea) {
    boton.disabled = true;
    try {
      await tarea();
    } catch (err) {
      if (err.status === 401) bloquearPanel();
      else toast(err.message || "Ocurrió un error.", "error");
    } finally {
      boton.disabled = false;
    }
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const area = crear("textarea");
      area.value = texto;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("Copiado al portapapeles.");
  }

  function duracion(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min`;
    return `${s} s`;
  }

  function mostrarCubierta(titulo, texto, conRueda) {
    $("#cubierta h2").textContent = titulo;
    $("#cubierta p").textContent = texto;
    $("#cubierta .rueda").hidden = !conRueda;
    $("#cubierta").hidden = false;
  }

  function bloquearPanel() {
    if (panelBloqueado) return;
    panelBloqueado = true;
    mostrarCubierta(
      "Sesión de configuración caducada",
      "Abre la configuración con el enlace que aparece en la ventana del servidor.",
      false
    );
  }

  // ---------------------------------------------------------------
  // Navegación
  // ---------------------------------------------------------------

  function mostrarVista(nombre) {
    if (!VISTAS.includes(nombre)) nombre = "inicio";
    $$(".vista").forEach((v) => { v.hidden = v.id !== "vista-" + nombre; });
    $$(".nav-item").forEach((b) => {
      if (b.dataset.vista === nombre) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    document.title = `${TITULOS[nombre]} · Configuración del servidor MCP`;
    $("#contenido").scrollTop = 0;
  }

  $$(".nav-item").forEach((b) => {
    b.addEventListener("click", () => { location.hash = b.dataset.vista; });
  });
  window.addEventListener("hashchange", () => mostrarVista(location.hash.slice(1)));

  // ---------------------------------------------------------------
  // Estado (Inicio y avisos)
  // ---------------------------------------------------------------

  function textoTunel(e) {
    const t = e.tunel || {};
    const activo = t.activo ? "activo" : "detenido";
    if (t.modo === "ninguno") return "Desactivado: el servidor solo responde en esta PC.";
    if (t.modo === "nombrado") return `Con nombre (Cloudflare) · ${activo}`;
    const listo = /^https:/.test(e.urlPublicaMcp || "");
    return `Rápido (Cloudflare) · ${t.activo ? (listo ? "conectado" : "esperando la dirección pública…") : "detenido"}`;
  }

  function mostrarAvisos(d) {
    $("#aviso-tunel").hidden = !d.tunelPendiente;
    $("#aviso-reinicio").hidden = !d.reinicioPendiente;
  }

  function pintarAcerca(e) {
    const filas = [
      ["i-server", "Node.js", e.nodeVersion],
      ["i-home", "Sistema", e.plataforma],
      ["i-link", "Carpeta del proyecto", e.carpeta],
      ["i-plug", "Puerto del servidor", String(e.puertoServidor)],
      ["i-sliders", "Puerto de la configuración", String(e.puertoPanel)],
      ["i-save", "Archivo de configuración", "config.json"]
    ];
    const cont = $("#acerca-lista");
    cont.textContent = "";
    for (const [ic, titulo, valor] of filas) {
      const fila = crear("div", "fila");
      const texto = crear("div", "fila-texto");
      texto.append(crear("div", "fila-titulo", titulo), crear("div", "fila-desc valor", valor || "—"));
      fila.append(icono(ic, "icono fila-icono"), texto);
      cont.append(fila);
    }
  }

  async function refrescarEstado() {
    if (panelBloqueado) return;
    try {
      const e = await api("/estado");
      $("#ini-punto").className = "punto ok";
      $("#ini-estado").textContent = "Servidor en ejecución";
      $("#ini-uptime").textContent = `Activo desde hace ${duracion(e.ahora - e.inicio)}`;
      $("#ini-local").textContent = e.urlLocal || `http://localhost:${e.puertoServidor}/mcp`;
      $("#ini-publica").textContent = e.urlPublicaMcp || "—";
      $("#ini-issuer").textContent = e.urlIssuer || "—";
      $("#ini-tunel").textContent = textoTunel(e);
      $("#ini-usuario").textContent = e.usuario || "—";

      const cargados = Array.isArray(e.modulosCargados) ? e.modulosCargados : null;
      $("#ini-modulos").textContent = cargados
        ? `${cargados.length} cargados${cargados.length ? ": " + cargados.join(", ") : ""}`
        : "—";

      mostrarAvisos(e);
      pintarAcerca(e);
    } catch (err) {
      if (err.status === 401) return bloquearPanel();
      $("#ini-punto").className = "punto error";
      $("#ini-estado").textContent = "Sin respuesta del servidor";
      $("#ini-uptime").textContent = "Puede estar reiniciándose.";
    }
  }

  // ---------------------------------------------------------------
  // Configuración
  // ---------------------------------------------------------------

  function modoTunelElegido() {
    const marcado = $('input[name="tunel-modo"]:checked');
    return marcado ? marcado.value : "rapido";
  }

  function adaptarModo() {
    const modo = modoTunelElegido();
    $$("#tarjeta-tunel [data-modos]").forEach((fila) => {
      fila.hidden = !fila.dataset.modos.split(" ").includes(modo);
    });
    $("#tunel-vacio").hidden = modo !== "ninguno";
  }

  function pintarToken(c) {
    $("#tunel-token").value = "";
    $("#tunel-token").placeholder = c.tunel.tokenGuardado
      ? "Guardado (déjalo vacío para conservarlo)"
      : "Pega aquí el token";
    $("#tunel-borrar-token").hidden = !c.tunel.tokenGuardado;
  }

  function pintarModulos(lista) {
    const cont = $("#lista-modulos");
    cont.textContent = "";
    for (const m of lista) {
      const id = "mod-" + m.nombre;
      const fila = crear("div", "fila");
      const texto = crear("div", "fila-texto");
      const titulo = crear("label", "fila-titulo", m.nombre);
      titulo.htmlFor = id;
      texto.append(titulo);
      if (m.descripcion) texto.append(crear("div", "fila-desc", m.descripcion));

      const control = crear("div", "fila-control");
      const interruptor = crear("input", "interruptor");
      interruptor.type = "checkbox";
      interruptor.id = id;
      interruptor.dataset.modulo = m.nombre;
      interruptor.checked = m.activo;
      control.append(interruptor);

      fila.append(icono("i-apps", "icono fila-icono"), texto, control);
      cont.append(fila);
    }
    if (!lista.length) cont.append(crear("div", "fila", "No se encontraron módulos."));
  }

  function aplicarConfig(d) {
    datosConfig = d;
    const c = d.config;

    $("#cuenta-usuario").value = d.usuario || "";

    $$('input[name="tunel-modo"]').forEach((r) => { r.checked = r.value === c.tunel.modo; });
    $("#tunel-protocolo").value = c.tunel.protocolo;
    $("#tunel-url").value = c.tunel.urlPublica;
    $("#tunel-actualizar").checked = c.tunel.actualizarCloudflared;
    pintarToken(c);
    adaptarModo();

    $("#srv-puerto").value = c.servidor.puerto;
    $("#srv-panel-puerto").value = c.panel.puerto;
    $("#srv-abrir").checked = c.panel.abrirAlIniciar;
    $("#srv-sesion").value = c.servidor.sesionMinutos;
    $("#srv-access").value = c.servidor.accessTokenMinutos;
    $("#srv-refresh").value = c.servidor.refreshTokenDias;

    pintarModulos(d.modulos);
    mostrarAvisos(d);
  }

  async function cargarConfig() {
    aplicarConfig(await api("/config"));
  }

  async function guardarConfig(cuerpo, mensaje = "Cambios guardados.") {
    const d = await api("/config", { metodo: "PUT", cuerpo });
    datosConfig = { ...datosConfig, ...d };
    pintarToken(d.config);
    mostrarAvisos(d);
    if (mensaje) toast(mensaje);
    return d;
  }

  function leerTunel() {
    const tunel = {
      modo: modoTunelElegido(),
      protocolo: $("#tunel-protocolo").value,
      urlPublica: $("#tunel-url").value.trim(),
      actualizarCloudflared: $("#tunel-actualizar").checked
    };
    const token = $("#tunel-token").value.trim();
    if (token) tunel.token = token;
    return { tunel };
  }

  function leerServidor() {
    return {
      servidor: {
        puerto: $("#srv-puerto").value,
        sesionMinutos: $("#srv-sesion").value,
        accessTokenMinutos: $("#srv-access").value,
        refreshTokenDias: $("#srv-refresh").value
      },
      panel: {
        puerto: $("#srv-panel-puerto").value,
        abrirAlIniciar: $("#srv-abrir").checked
      }
    };
  }

  function leerModulos() {
    const desactivados = $$("#lista-modulos .interruptor")
      .filter((i) => !i.checked)
      .map((i) => i.dataset.modulo);
    // Conserva nombres desactivados de módulos que ya no están en la carpeta.
    const presentes = new Set($$("#lista-modulos .interruptor").map((i) => i.dataset.modulo));
    const previos = (datosConfig && datosConfig.config.modulos.deshabilitados) || [];
    for (const nombre of previos) {
      if (!presentes.has(nombre) && !desactivados.includes(nombre)) desactivados.push(nombre);
    }
    return { modulos: { deshabilitados: desactivados } };
  }

  // ---------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------

  async function reiniciarTunel() {
    await api("/tunel/reiniciar", { metodo: "POST" });
    toast("Túnel reiniciado. La dirección pública puede tardar unos segundos.");
    setTimeout(refrescarEstado, 1500);
    setTimeout(refrescarEstado, 5000);
  }

  async function reiniciarServidor() {
    await api("/servidor/reiniciar", { metodo: "POST" });
    mostrarCubierta(
      "Reiniciando el servidor…",
      "En unos segundos se abrirá una pestaña nueva con la configuración. Puedes cerrar esta.",
      true
    );
  }

  async function confirmarReinicioServidor() {
    return confirmar(
      "Reiniciar el servidor",
      "Se cortarán las conexiones activas durante unos segundos y el servidor volverá a arrancar en una ventana nueva.",
      "Reiniciar"
    );
  }

  async function confirmarReinicioTunel() {
    return confirmar(
      "Reiniciar el túnel",
      "La dirección pública dejará de responder unos segundos. En modo rápido, la dirección cambiará.",
      "Reiniciar"
    );
  }

  // Inicio / avisos
  $("#ini-reiniciar-tunel").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    if (await confirmarReinicioTunel()) await reiniciarTunel();
  }));
  $("#ini-reiniciar-servidor").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    if (await confirmarReinicioServidor()) await reiniciarServidor();
  }));
  $("#aviso-tunel-boton").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    if (await confirmarReinicioTunel()) await reiniciarTunel();
  }));
  $("#aviso-reinicio-boton").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    if (await confirmarReinicioServidor()) await reiniciarServidor();
  }));

  // Copiar direcciones
  $$("[data-copiar]").forEach((b) => {
    b.addEventListener("click", () => {
      const texto = $("#" + b.dataset.copiar).textContent.trim();
      if (texto && texto !== "—") copiar(texto);
    });
  });

  // Mostrar / ocultar contraseñas
  $$("[data-ojo]").forEach((b) => {
    b.addEventListener("click", () => {
      const campo = $("#" + b.dataset.ojo);
      const visible = campo.type === "text";
      campo.type = visible ? "password" : "text";
      b.querySelector("use").setAttribute("href", visible ? "#i-eye" : "#i-eye-off");
      b.setAttribute("aria-label", visible ? "Mostrar" : "Ocultar");
    });
  });

  // Cuenta
  $("#cuenta-guardar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    const usuarioNuevo = $("#cuenta-usuario").value.trim();
    const contrasenaActual = $("#cuenta-actual").value;
    const contrasenaNueva = $("#cuenta-nueva").value;
    const repetir = $("#cuenta-repetir").value;

    if (!contrasenaActual) throw new Error("Escribe tu contraseña actual para confirmar.");
    if (contrasenaNueva !== repetir) throw new Error("Las contraseñas nuevas no coinciden.");
    if (contrasenaNueva && contrasenaNueva.length < 8) throw new Error("La contraseña nueva debe tener al menos 8 caracteres.");

    const r = await api("/cuenta", {
      metodo: "POST",
      cuerpo: {
        usuarioNuevo,
        contrasenaActual,
        contrasenaNueva,
        revocarConectores: $("#cuenta-revocar").checked
      }
    });

    $("#cuenta-actual").value = "";
    $("#cuenta-nueva").value = "";
    $("#cuenta-repetir").value = "";
    $("#cuenta-usuario").value = r.usuario;
    $("#ini-usuario").textContent = r.usuario;
    toast(r.contrasenaCambiada ? "Contraseña actualizada. Se cerraron las sesiones." : "Usuario actualizado. Se cerraron las sesiones.");
  }));

  // Túnel
  $$('input[name="tunel-modo"]').forEach((r) => r.addEventListener("change", adaptarModo));

  $("#tunel-guardar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    await guardarConfig(leerTunel());
  }));

  $("#tunel-aplicar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    await guardarConfig(leerTunel(), "");
    await reiniciarTunel();
  }));

  $("#tunel-borrar-token").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    if (!(await confirmar("Borrar el token", "Se eliminará el token guardado en config.json. El túnel con nombre dejará de poder arrancar hasta que pegues uno nuevo.", "Borrar"))) return;
    await guardarConfig({ tunel: { borrarToken: true } }, "Token borrado.");
  }));

  // Servidor
  $("#srv-guardar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    await guardarConfig(leerServidor());
  }));

  $("#srv-reiniciar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    const cuerpo = leerServidor();
    if (!(await confirmarReinicioServidor())) return;
    await guardarConfig(cuerpo, "");
    await reiniciarServidor();
  }));

  // Módulos
  $("#mod-guardar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    await guardarConfig(leerModulos());
  }));

  $("#mod-reiniciar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    const cuerpo = leerModulos();
    if (!(await confirmarReinicioServidor())) return;
    await guardarConfig(cuerpo, "");
    await reiniciarServidor();
  }));

  // Seguridad
  $("#seg-cerrar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    const incluir = $("#seg-revocar").checked;
    const texto = incluir
      ? "Se cerrarán todas las sesiones y se revocará el acceso de los conectores autorizados."
      : "Se cerrarán todas las sesiones abiertas con usuario y contraseña.";
    if (!(await confirmar("Cerrar sesiones", texto, "Cerrar sesiones"))) return;
    await api("/sesiones/cerrar", { metodo: "POST", cuerpo: { revocarConectores: incluir } });
    toast("Sesiones cerradas.");
  }));

  async function obtenerApiKey() {
    if (apiKeyValor === null) apiKeyValor = (await api("/apikey")).apiKey;
    return apiKeyValor;
  }

  $("#apikey-mostrar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    const boton = ev.currentTarget;
    apiKeyVisible = !apiKeyVisible;
    $("#apikey-valor").textContent = apiKeyVisible ? await obtenerApiKey() : "••••••••••••••••••••••••";
    boton.querySelector("use").setAttribute("href", apiKeyVisible ? "#i-eye-off" : "#i-eye");
    boton.setAttribute("aria-label", apiKeyVisible ? "Ocultar API key" : "Mostrar API key");
  }));

  $("#apikey-copiar").addEventListener("click", (ev) => ocupado(ev.currentTarget, async () => {
    await copiar(await obtenerApiKey());
  }));

  // ---------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------

  mostrarVista(location.hash.slice(1));

  (async () => {
    try {
      await Promise.all([cargarConfig(), refrescarEstado()]);
    } catch (err) {
      if (err.status === 401) bloquearPanel();
      else toast(err.message || "No se pudo cargar la configuración.", "error");
    }
  })();

  setInterval(() => { if (!document.hidden) refrescarEstado(); }, 4000);
})();
