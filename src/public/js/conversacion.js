const socket = io();
const puntoConexion = document.getElementById("estado-conexion");

socket.on("connect", () => {
  puntoConexion.classList.add("conectado");
  socket.emit("unirse", { producto: PRODUCTO });
});
socket.on("disconnect", () => puntoConexion.classList.remove("conectado"));

socket.on("novedad", async (payload) => {
  if (payload.telefono !== TELEFONO) return;
  await refrescarMensajes();
});

async function refrescarMensajes() {
  try {
    const respuesta = await fetch(`/api/conversacion/${PRODUCTO}/${TELEFONO}`, {
      headers: { Accept: "application/json" },
    });
    if (!respuesta.ok) return;
    const datos = await respuesta.json();
    pintarMensajes(datos.conversacion.historial || []);
  } catch (error) {
    console.error("Error refrescando la conversación:", error);
  }
}

function pintarMensajes(historial) {
  const lista = document.getElementById("lista-mensajes");
  let diaAnterior = null;
  lista.innerHTML = historial
    .map((m) => {
      const fecha = m.timestamp ? new Date(m.timestamp) : null;
      const diaActual = fecha
        ? fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "long", year: "numeric" })
        : null;
      const horaTexto = fecha
        ? fecha.toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit" })
        : "hora no registrada";

      let separador = "";
      if (diaActual && diaActual !== diaAnterior) {
        separador = `<div class="separador-dia"><span>${diaActual}</span></div>`;
        diaAnterior = diaActual;
      }

      return `
        ${separador}
        <div class="burbuja burbuja-${m.role}">
          ${contenidoDeMensaje(m.content)}
          <span class="burbuja-hora">${horaTexto}</span>
        </div>
      `;
    })
    .join("");
  lista.scrollTop = lista.scrollHeight;
}

// El bot guarda las fotos/videos/documentos que manda como texto con la URL
// real en su propia línea (ver etiquetaMediaHistorial en el bot) — antes
// esto no se guardaba de ninguna forma, así que el CRM no mostraba ni
// rastro de que se había enviado algo así. Esta función detecta esa URL
// por su extensión y arma una imagen/video/link real en vez de mostrar el
// mensaje como texto plano con una URL suelta.
function detectarMediaEnMensaje(contenido) {
  const match = (contenido || "").match(/(https?:\/\/\S+)/);
  if (!match) return null;
  const url = match[0];
  const texto = contenido.replace(url, "").trim();
  const extension = url.split(".").pop().toLowerCase().split("?")[0];
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) return { tipo: "imagen", url, texto };
  if (["mp4", "webm", "mov", "ogg"].includes(extension)) return { tipo: "video", url, texto };
  if (extension === "pdf") return { tipo: "documento", url, texto };
  return null;
}

function contenidoDeMensaje(contenido) {
  const media = detectarMediaEnMensaje(contenido);
  const textoHtml = media?.texto
    ? `<span class="burbuja-texto">${escaparHtml(media.texto)}</span>`
    : media
    ? ""
    : `<span class="burbuja-texto">${escaparHtml(contenido)}</span>`;

  if (media?.tipo === "imagen") {
    return `${textoHtml}<a href="${escaparAtributo(media.url)}" target="_blank" rel="noopener"><img src="${escaparAtributo(media.url)}" class="burbuja-imagen" alt="Imagen enviada al cliente" loading="lazy" /></a>`;
  }
  if (media?.tipo === "video") {
    return `${textoHtml}<video controls preload="metadata" class="burbuja-video"><source src="${escaparAtributo(media.url)}" /></video>`;
  }
  if (media?.tipo === "documento") {
    return `${textoHtml}<a href="${escaparAtributo(media.url)}" target="_blank" rel="noopener" class="burbuja-documento">📄 Ver documento</a>`;
  }
  return textoHtml;
}

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

function escaparAtributo(texto) {
  return escaparHtml(texto).replace(/"/g, "&quot;");
}

const botonIntervenir = document.getElementById("boton-intervenir");
if (botonIntervenir) {
  botonIntervenir.addEventListener("click", async () => {
    botonIntervenir.disabled = true;
    try {
      const respuesta = await fetch("/acciones/intervenir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO }),
      });
      if (!respuesta.ok) throw new Error("No se pudo tomar control");
      location.reload();
    } catch (error) {
      alert(error.message);
      botonIntervenir.disabled = false;
    }
  });
}

const botonDevolver = document.getElementById("boton-devolver");
if (botonDevolver) {
  botonDevolver.addEventListener("click", async () => {
    botonDevolver.disabled = true;
    try {
      const respuesta = await fetch("/acciones/devolver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO }),
      });
      if (!respuesta.ok) throw new Error("No se pudo devolver el control");
      location.reload();
    } catch (error) {
      alert(error.message);
      botonDevolver.disabled = false;
    }
  });
}

const formMensaje = document.getElementById("form-mensaje");
if (formMensaje) {
  formMensaje.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const campo = document.getElementById("campo-mensaje");
    const mensaje = campo.value.trim();
    if (!mensaje) return;
    campo.disabled = true;
    try {
      const respuesta = await fetch("/acciones/mensaje", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO, mensaje }),
      });
      if (!respuesta.ok) throw new Error("No se pudo enviar el mensaje");
      campo.value = "";
      await refrescarMensajes();
    } catch (error) {
      alert(error.message);
    } finally {
      campo.disabled = false;
      campo.focus();
    }
  });
}

const selectorEtapa = document.getElementById("selector-etapa");
if (selectorEtapa) {
  selectorEtapa.addEventListener("change", async () => {
    try {
      const respuesta = await fetch("/acciones/etapa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          producto: PRODUCTO,
          telefono: TELEFONO,
          etapaId: Number(selectorEtapa.value),
        }),
      });
      if (!respuesta.ok) throw new Error("No se pudo cambiar la etapa");
    } catch (error) {
      alert(error.message);
    }
  });
}

const campoValorVenta = document.getElementById("campo-valor-venta-conversacion");
if (campoValorVenta) {
  campoValorVenta.addEventListener("blur", async () => {
    const valorAnterior = campoValorVenta.dataset.valorAnterior ?? campoValorVenta.defaultValue;
    const valorNuevo = campoValorVenta.value.trim();
    if (valorNuevo === (campoValorVenta.dataset.valorAnterior ?? campoValorVenta.defaultValue)) return;

    campoValorVenta.disabled = true;
    try {
      const respuesta = await fetch("/acciones/editar-campo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          producto: PRODUCTO,
          telefono: TELEFONO,
          campo: "valor_venta",
          valor: valorNuevo === "" ? null : Number(valorNuevo.replace(/[^\d.]/g, "")),
        }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar el valor");
      campoValorVenta.dataset.valorAnterior = valorNuevo;
    } catch (error) {
      console.error("Error guardando valor de venta:", error);
      campoValorVenta.value = valorAnterior;
      alert("No se pudo guardar el valor. Intenta de nuevo.");
    } finally {
      campoValorVenta.disabled = false;
    }
  });
}

const selectorAsesor = document.getElementById("selector-asesor");
if (selectorAsesor) {
  selectorAsesor.addEventListener("change", async () => {
    try {
      const respuesta = await fetch("/acciones/asignar-asesor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          producto: PRODUCTO,
          telefono: TELEFONO,
          asesorId: selectorAsesor.value ? Number(selectorAsesor.value) : null,
        }),
      });
      if (!respuesta.ok) throw new Error("No se pudo asignar el asesor");
      location.reload();
    } catch (error) {
      alert(error.message);
    }
  });
}

const botonAbrirTarea = document.getElementById("boton-abrir-tarea");
const formTarea = document.getElementById("form-tarea");
if (botonAbrirTarea && formTarea) {
  botonAbrirTarea.addEventListener("click", () => {
    formTarea.classList.toggle("oculta");
  });

  const selectorConcepto = document.getElementById("selector-concepto-tarea");
  const campoOtro = document.getElementById("campo-concepto-otro");
  selectorConcepto.addEventListener("change", () => {
    const esOtro = selectorConcepto.value === "otro";
    campoOtro.classList.toggle("oculta", !esOtro);
    if (esOtro) campoOtro.focus();
  });

  formTarea.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const concepto = selectorConcepto.value === "otro" ? campoOtro.value.trim() : selectorConcepto.value;
    const fecha = document.getElementById("campo-fecha-tarea").value;
    if (!concepto || !fecha) {
      alert("Escribe el concepto de la tarea y elige una fecha.");
      return;
    }

    const boton = formTarea.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      const respuesta = await fetch("/acciones/tareas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO, concepto, fecha }),
      });
      if (!respuesta.ok) throw new Error("No se pudo crear la tarea");
      window.location.reload();
    } catch (error) {
      alert(error.message);
      boton.disabled = false;
    }
  });
}

document.addEventListener("click", async (evento) => {
  const botonCompletar = evento.target.closest(".boton-completar-tarea-inline");
  if (!botonCompletar) return;

  const tareaId = botonCompletar.dataset.tareaId;
  botonCompletar.disabled = true;
  try {
    const respuesta = await fetch(`/acciones/tareas/${tareaId}/completar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO }),
    });
    if (!respuesta.ok) throw new Error("No se pudo completar la tarea");
    window.location.reload();
  } catch (error) {
    alert(error.message);
    botonCompletar.disabled = false;
  }
});

const botonSugerir = document.getElementById("boton-sugerir");
if (botonSugerir) {
  botonSugerir.addEventListener("click", async () => {
    const resultado = document.getElementById("resultado-sugerencia");
    botonSugerir.disabled = true;
    botonSugerir.textContent = "Pensando...";
    resultado.hidden = true;

    try {
      const respuesta = await fetch("/acciones/sugerir-siguiente-paso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO }),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new Error(datos.error || "No se pudo generar la sugerencia");

      resultado.textContent = datos.sugerencia;
      resultado.hidden = false;
    } catch (error) {
      console.error("Error obteniendo sugerencia:", error);
      alert(error.message);
    } finally {
      botonSugerir.disabled = false;
      botonSugerir.textContent = "Sugerir próximo paso (IA)";
    }
  });
}

const botonGuardarNotas = document.getElementById("boton-guardar-notas");
if (botonGuardarNotas) {
  botonGuardarNotas.addEventListener("click", async () => {
    const campoNotas = document.getElementById("campo-notas");
    const estadoNotas = document.getElementById("estado-notas");
    botonGuardarNotas.disabled = true;

    try {
      const respuesta = await fetch("/acciones/notas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO, notas: campoNotas.value }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar la nota");
      estadoNotas.textContent = "Guardado ✓";
      setTimeout(() => (estadoNotas.textContent = ""), 2000);
    } catch (error) {
      console.error("Error guardando notas:", error);
      estadoNotas.textContent = "No se pudo guardar";
    } finally {
      botonGuardarNotas.disabled = false;
    }
  });
}

const botonEliminarLead = document.getElementById("boton-eliminar-lead");
if (botonEliminarLead) {
  botonEliminarLead.addEventListener("click", async () => {
    // Motivo obligatorio: sigue preguntando hasta que escriba algo, o hasta
    // que cancele explícitamente (Cancelar en el prompt, o dejarlo vacío y
    // no insistir — en ese caso simplemente no se elimina nada).
    let motivo = null;
    while (motivo === null || motivo.trim() === "") {
      motivo = window.prompt(
        "¿Por qué estás eliminando este lead? (obligatorio)\n\nSe mueve a la sección de Eliminados — no borra el historial de WhatsApp, y se puede restaurar en cualquier momento."
      );
      if (motivo === null) return; // canceló el prompt, no se elimina nada
      if (motivo.trim() === "") alert("Tienes que escribir un motivo para poder eliminar el lead.");
    }

    botonEliminarLead.disabled = true;
    try {
      const respuesta = await fetch("/acciones/eliminar-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO, motivo: motivo.trim() }),
      });
      if (!respuesta.ok) throw new Error("No se pudo eliminar el lead");
      alert("Lead eliminado. Puedes restaurarlo desde la sección de Eliminados.");
      window.location.href = `/bandeja?producto=${PRODUCTO}`;
    } catch (error) {
      alert(error.message);
      botonEliminarLead.disabled = false;
    }
  });
}

// ============ Reagendar visita (desde la propia conversación) ============
const botonAbrirReagendar = document.getElementById("boton-abrir-reagendar");
const formReagendar = document.getElementById("form-reagendar-conversacion");
if (botonAbrirReagendar && formReagendar) {
  botonAbrirReagendar.addEventListener("click", () => {
    formReagendar.classList.toggle("oculta");
  });

  formReagendar.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const fechaISO = formReagendar.querySelector('[name="fechaISO"]').value;
    const hora = formReagendar.querySelector('[name="hora"]').value;
    const boton = formReagendar.querySelector('button[type="submit"]');
    boton.disabled = true;

    try {
      const respuesta = await fetch("/acciones/reagendar-visita", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono: TELEFONO, fechaISO, hora }),
      });
      if (!respuesta.ok) throw new Error("No se pudo reagendar la visita");
      window.location.reload();
    } catch (error) {
      alert(error.message);
      boton.disabled = false;
    }
  });
}
