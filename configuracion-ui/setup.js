// Asistente de configuración inicial. Texto dinámico siempre con textContent.
(() => {
  "use strict";

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

  let pasos = ["cuenta", "tunel", "discord"];
  let actual = 0;
  let enviando = false;
  let tokenDiscordGuardado = false;

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

  function mostrarError(texto) {
    $("#s-error-texto").textContent = texto || "";
    $("#s-error").hidden = !texto;
  }

  function modoElegido() {
    const m = $('input[name="s-modo"]:checked');
    return m ? m.value : "rapido";
  }

  function adaptarModo() {
    const modo = modoElegido();
    $$("#s-tarjeta-tunel [data-modos]").forEach((f) => {
      f.hidden = !f.dataset.modos.split(" ").includes(modo);
    });
  }

  function adaptarDiscord() {
    const activo = $("#s-dc-activar").checked;
    $$("[data-dc]").forEach((f) => { f.hidden = !activo; });
  }

  function mostrarPaso(i) {
    actual = Math.max(0, Math.min(pasos.length - 1, i));
    mostrarError("");
    $$(".vista").forEach((v) => { v.hidden = v.id !== "paso-" + pasos[actual]; });
    $$(".paso").forEach((p) => {
      const idx = pasos.indexOf(p.dataset.paso);
      p.hidden = idx < 0;
      p.classList.toggle("actual", idx === actual);
      p.classList.toggle("hecho", idx >= 0 && idx < actual);
      if (idx === actual) p.setAttribute("aria-current", "step");
      else p.removeAttribute("aria-current");
    });
    $("#s-atras").hidden = actual === 0;
    $("#s-siguiente-texto").textContent = actual === pasos.length - 1 ? "Terminar" : "Siguiente";
    const primero = $("#paso-" + pasos[actual] + " input:not([type=radio]):not([type=checkbox]):not([hidden])");
    if (primero && primero.offsetParent !== null) primero.focus();
  }

  function validarPaso(nombre) {
    if (nombre === "cuenta") {
      const usuario = $("#s-usuario").value.trim();
      const clave = $("#s-clave").value;
      if (!usuario) return "Escribe un nombre de usuario.";
      if (clave.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
      if (clave !== $("#s-clave2").value) return "Las contraseñas no coinciden.";
    }
    if (nombre === "tunel" && modoElegido() === "nombrado") {
      if (!$("#s-token").value.trim()) return "Pega el token del túnel de Cloudflare.";
      if (!$("#s-url").value.trim()) return "Indica la dirección pública del túnel.";
    }
    if (nombre === "discord" && $("#s-dc-activar").checked) {
      if (!$("#s-dc-token").value.trim() && !tokenDiscordGuardado) return "Pega el token del bot de Discord o apaga el módulo.";
    }
    return "";
  }

  function construirCuerpo() {
    const tunel = { modo: modoElegido() };
    const token = $("#s-token").value.trim();
    const url = $("#s-url").value.trim();
    if (token && tunel.modo === "nombrado") tunel.token = token;
    if (url && tunel.modo !== "rapido") tunel.urlPublica = url;

    const cuerpo = {
      usuario: $("#s-usuario").value.trim(),
      contrasena: $("#s-clave").value,
      tunel
    };

    if (pasos.includes("discord")) {
      const activar = $("#s-dc-activar").checked;
      cuerpo.discord = { activar };
      if (activar) {
        cuerpo.discord.token = $("#s-dc-token").value.trim();
        cuerpo.discord.guilds = $("#s-dc-guilds").value;
        cuerpo.discord.logChannel = $("#s-dc-log").value;
      }
    }
    return cuerpo;
  }

  async function terminar() {
    enviando = true;
    $("#s-siguiente").disabled = true;
    try {
      await api("/setup", { metodo: "POST", cuerpo: construirCuerpo() });
      $("#cubierta").hidden = false;
      setTimeout(() => { location.replace("/?listo=1#inicio"); }, 1800);
    } catch (err) {
      enviando = false;
      $("#s-siguiente").disabled = false;
      if (err.status === 401) {
        mostrarError("La sesión de configuración caducó. Abre el enlace que aparece en la ventana del servidor.");
      } else if (err.status === 409) {
        location.replace("/?listo=1#inicio");
      } else {
        mostrarError(err.message || "No se pudo guardar la configuración.");
      }
    }
  }

  $("#s-siguiente").addEventListener("click", () => {
    if (enviando) return;
    const error = validarPaso(pasos[actual]);
    if (error) return mostrarError(error);
    if (actual === pasos.length - 1) return terminar();
    mostrarPaso(actual + 1);
  });

  $("#s-atras").addEventListener("click", () => { if (!enviando) mostrarPaso(actual - 1); });

  $$(".asistente input").forEach((i) => {
    i.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && i.type !== "radio" && i.type !== "checkbox") {
        ev.preventDefault();
        $("#s-siguiente").click();
      }
    });
  });

  $$('input[name="s-modo"]').forEach((r) => r.addEventListener("change", adaptarModo));
  $("#s-dc-activar").addEventListener("change", adaptarDiscord);

  $$("[data-ojo]").forEach((b) => {
    b.addEventListener("click", () => {
      const campo = $("#" + b.dataset.ojo);
      const visible = campo.type === "text";
      campo.type = visible ? "password" : "text";
      b.querySelector("use").setAttribute("href", visible ? "#i-eye" : "#i-eye-off");
      b.setAttribute("aria-label", visible ? "Mostrar" : "Ocultar");
    });
  });

  (async () => {
    try {
      const e = await api("/setup/estado");
      if (!e.pendiente) return location.replace("/?listo=1#inicio");
      if (!e.discord || !e.discord.disponible) {
        pasos = ["cuenta", "tunel"];
      } else if (e.discord.tokenGuardado) {
        tokenDiscordGuardado = true;
        $("#s-dc-token").placeholder = "Ya hay un token guardado (déjalo vacío para conservarlo)";
      }
      if (e.discord) {
        $("#s-dc-guilds").value = e.discord.guilds || "";
        $("#s-dc-log").value = e.discord.logChannel || "";
      }
      if (e.tunel && e.tunel.urlPublica) $("#s-url").value = e.tunel.urlPublica;
    } catch (err) {
      mostrarError(err.status === 401
        ? "La sesión de configuración caducó. Abre el enlace que aparece en la ventana del servidor."
        : (err.message || "No se pudo cargar el asistente."));
    }
    adaptarModo();
    adaptarDiscord();
    mostrarPaso(0);
  })();
})();
