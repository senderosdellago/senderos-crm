// Este archivo se usa en 3 páginas distintas (dashboard, dashboard-lista,
// dashboard-visitas) — cada bloque revisa si sus elementos existen antes de
// engancharse, así que es seguro cargarlo en las 3 sin que ninguna truene
// por buscar algo que no está en esa página.

const socketDisponible = typeof io === "function";
const puntoConexion = document.getElementById("estado-conexion");

if (socketDisponible && puntoConexion) {
  const socket = io();
  socket.on("connect", () => {
    puntoConexion.classList.add("conectado");
    socket.emit("unirse", { producto: PRODUCTO });
  });
  socket.on("disconnect", () => puntoConexion.classList.remove("conectado"));

  // Solo la página /dashboard (overview) tiene #grid-resumen — en las demás
  // páginas este evento simplemente no encuentra el elemento y no hace nada.
  socket.on("novedad", async () => {
    const gridResumen = document.getElementById("grid-resumen");
    if (!gridResumen) return;
    try {
      const respuesta = await fetch(`/api/dashboard?producto=${encodeURIComponent(PRODUCTO)}`, {
        headers: { Accept: "application/json" },
      });
      if (!respuesta.ok) return;
      const datos = await respuesta.json();
      actualizarResumen(datos.resumen);
    } catch (error) {
      console.error("Error refrescando el dashboard:", error);
    }
  });
}

function actualizarResumen(resumen) {
  const gridResumen = document.getElementById("grid-resumen");
  if (!gridResumen) return;
  gridResumen.innerHTML = `
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/tareas?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Tareas pendientes</p>
      <p class="tarjeta-resumen-numero">Ver tareas →</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/oportunidades?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Oportunidades activas</p>
      <p class="tarjeta-resumen-numero">Ver pipeline →</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/lista/intervencion?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Requieren intervención</p>
      <p class="tarjeta-resumen-numero numero-urgente">${resumen.requierenIntervencion}</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/lista/calientes?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Calientes sin agendar</p>
      <p class="tarjeta-resumen-numero numero-caliente">${resumen.calientesSinAgendar}</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/lista/enfriandose?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Se están enfriando</p>
      <p class="tarjeta-resumen-numero numero-enfriandose">${resumen.leadsEnfriandose}</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/lista/seguimiento?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">En seguimiento automático</p>
      <p class="tarjeta-resumen-numero">${resumen.enSeguimiento}</p>
    </a>
    <a class="tarjeta-resumen tarjeta-resumen-link" href="/dashboard/visitas?producto=${PRODUCTO}">
      <p class="tarjeta-resumen-etiqueta">Visitas agendadas</p>
      <p class="tarjeta-resumen-numero numero-exito">${resumen.visitasAgendadas}</p>
    </a>
  `;
}

// ============ Acciones rápidas: Nuevo Lead (página /dashboard) ============
const botonAbrirNuevoLead = document.getElementById("boton-abrir-nuevo-lead");
const formNuevoLead = document.getElementById("form-nuevo-lead");
if (botonAbrirNuevoLead && formNuevoLead) {
  botonAbrirNuevoLead.addEventListener("click", () => formNuevoLead.classList.toggle("oculta"));

  formNuevoLead.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const nombre = document.getElementById("lead-nombre").value.trim();
    const telefono = document.getElementById("lead-telefono").value.trim();
    const uso = document.getElementById("lead-uso").value.trim();
    const presupuesto = document.getElementById("lead-presupuesto").value.trim();

    const boton = formNuevoLead.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      const respuesta = await fetch("/acciones/crear-lead-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, nombre, uso, presupuesto }),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new Error(datos.error || "No se pudo crear el lead");
      window.location.href = `/conversacion/${PRODUCTO}/${telefono}`;
    } catch (error) {
      alert(error.message);
      boton.disabled = false;
    }
  });
}

// ============ Acciones rápidas: Crear Tarea (página /dashboard) ============
const botonAbrirTareaRapida = document.getElementById("boton-abrir-tarea-rapida");
const formTareaRapida = document.getElementById("form-tarea-rapida");
if (botonAbrirTareaRapida && formTareaRapida) {
  botonAbrirTareaRapida.addEventListener("click", () => formTareaRapida.classList.toggle("oculta"));

  const selectorConceptoRapido = document.getElementById("tarea-rapida-concepto");
  const campoOtroRapido = document.getElementById("tarea-rapida-otro");
  selectorConceptoRapido.addEventListener("change", () => {
    const esOtro = selectorConceptoRapido.value === "otro";
    campoOtroRapido.classList.toggle("oculta", !esOtro);
  });

  formTareaRapida.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const telefono = document.getElementById("tarea-rapida-lead").value;
    const concepto = selectorConceptoRapido.value === "otro" ? campoOtroRapido.value.trim() : selectorConceptoRapido.value;
    const fecha = document.getElementById("tarea-rapida-fecha").value;
    if (!telefono || !concepto || !fecha) {
      alert("Elige un lead, escribe el concepto y una fecha.");
      return;
    }

    const boton = formTareaRapida.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      const respuesta = await fetch("/acciones/tareas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, concepto, fecha }),
      });
      if (!respuesta.ok) throw new Error("No se pudo crear la tarea");
      window.location.reload();
    } catch (error) {
      alert(error.message);
      boton.disabled = false;
    }
  });
}

// ============ Botón "Tomar caso" (página /dashboard/lista/intervencion) ============
document.addEventListener("click", async (evento) => {
  const botonTomarCaso = evento.target.closest(".boton-tomar-caso");
  if (botonTomarCaso) {
    const telefono = botonTomarCaso.dataset.telefono;
    botonTomarCaso.disabled = true;
    botonTomarCaso.textContent = "Tomando...";
    try {
      const respuesta = await fetch("/acciones/intervenir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono }),
      });
      if (!respuesta.ok) throw new Error("No se pudo tomar el caso");
      window.location.href = `/conversacion/${PRODUCTO}/${telefono}`;
    } catch (error) {
      console.error("Error tomando el caso:", error);
      botonTomarCaso.disabled = false;
      botonTomarCaso.textContent = "Tomar caso";
      alert("No se pudo tomar el caso. Intenta de nuevo.");
    }
    return;
  }

  // ============ Botones de resultado de visita (página /dashboard/visitas) ============
  const botonResultado = evento.target.closest(".boton-visita-resultado");
  if (botonResultado) {
    const telefono = botonResultado.dataset.telefono;
    const resultado = botonResultado.dataset.resultado;
    const fila = botonResultado.closest("tr");
    const botones = fila.querySelectorAll("button");
    botones.forEach((b) => (b.disabled = true));
    try {
      const respuesta = await fetch("/acciones/visita-resultado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, resultado }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar el resultado");
      fila.remove();
    } catch (error) {
      console.error("Error guardando resultado de visita:", error);
      botones.forEach((b) => (b.disabled = false));
      alert("No se pudo guardar. Intenta de nuevo.");
    }
    return;
  }

  // ============ Abrir/cerrar el formulario de reagendar (página /dashboard/visitas) ============
  const botonAbrirReagendar = evento.target.closest(".boton-abrir-reagendar");
  if (botonAbrirReagendar) {
    const telefono = botonAbrirReagendar.dataset.telefono;
    const filaForm = document.querySelector(`.fila-reagendar[data-telefono-form="${telefono}"]`);
    if (filaForm) filaForm.classList.toggle("oculta");
    return;
  }

  // ============ Completar tarea (página /dashboard/tareas) ============
  const botonCompletarTarea = evento.target.closest(".boton-completar-tarea");
  if (botonCompletarTarea) {
    const tareaId = botonCompletarTarea.dataset.tareaId;
    const telefono = botonCompletarTarea.dataset.telefono;
    const fila = botonCompletarTarea.closest("tr");
    botonCompletarTarea.disabled = true;
    try {
      const respuesta = await fetch(`/acciones/tareas/${tareaId}/completar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono }),
      });
      if (!respuesta.ok) throw new Error("No se pudo completar la tarea");
      fila.remove();
    } catch (error) {
      console.error("Error completando tarea:", error);
      botonCompletarTarea.disabled = false;
      alert("No se pudo completar. Intenta de nuevo.");
    }
  }
});

// ============ Selector de etapa en línea (página /dashboard/oportunidades) ============
document.addEventListener("change", async (evento) => {
  const selector = evento.target.closest(".selector-etapa-inline");
  if (selector) {
    const telefono = selector.dataset.telefono;
    const etapaIdAnterior = selector.dataset.valorAnterior || "";
    selector.disabled = true;
    try {
      const respuesta = await fetch("/acciones/etapa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, etapaId: Number(selector.value) }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar la etapa");
      selector.dataset.valorAnterior = selector.value;
    } catch (error) {
      console.error("Error guardando etapa:", error);
      selector.value = etapaIdAnterior;
      alert("No se pudo guardar el cambio de etapa. Intenta de nuevo.");
    } finally {
      selector.disabled = false;
    }
  }
});

// ============ Meta mensual editable (página /dashboard/equipo, solo admin) ============
document.addEventListener(
  "blur",
  async (evento) => {
    const campo = evento.target.closest?.(".campo-meta-mensual");
    if (!campo) return;

    const usuarioId = campo.dataset.usuarioId;
    const valorAnterior = campo.dataset.valorAnterior ?? campo.defaultValue;
    const valorNuevo = campo.value.trim();
    if (valorNuevo === (campo.dataset.valorAnterior ?? campo.defaultValue)) return;

    campo.disabled = true;
    try {
      const respuesta = await fetch("/acciones/meta-mensual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usuarioId: Number(usuarioId),
          monto: valorNuevo === "" ? null : Number(valorNuevo.replace(/[^\d.]/g, "")),
        }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar la meta");
      campo.dataset.valorAnterior = valorNuevo;
    } catch (error) {
      console.error("Error guardando meta mensual:", error);
      campo.value = valorAnterior;
      alert("No se pudo guardar la meta. Intenta de nuevo.");
    } finally {
      campo.disabled = false;
    }
  },
  true
);

// ============ Valor de venta editable (página /dashboard/oportunidades) ============
document.addEventListener(
  "blur",
  async (evento) => {
    const campo = evento.target.closest?.(".campo-valor-venta");
    if (!campo) return;

    const telefono = campo.dataset.telefono;
    const valorAnterior = campo.dataset.valorAnterior ?? campo.defaultValue;
    const valorNuevo = campo.value.trim();
    if (valorNuevo === (campo.dataset.valorAnterior ?? campo.defaultValue)) return; // no cambió, no llama al servidor

    campo.disabled = true;
    try {
      const respuesta = await fetch("/acciones/editar-campo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          producto: PRODUCTO,
          telefono,
          campo: "valor_venta",
          valor: valorNuevo === "" ? null : Number(valorNuevo.replace(/[^\d.]/g, "")),
        }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar el valor");
      campo.dataset.valorAnterior = valorNuevo;
    } catch (error) {
      console.error("Error guardando valor de venta:", error);
      campo.value = valorAnterior;
      alert("No se pudo guardar el valor. Intenta de nuevo.");
    } finally {
      campo.disabled = false;
    }
  },
  true // captura, porque "blur" no burbujea de forma normal
);
document.addEventListener("submit", async (evento) => {
  const form = evento.target.closest(".form-reagendar");
  if (!form) return;
  evento.preventDefault();

  const telefono = form.dataset.telefono;
  const fechaISO = form.querySelector('[name="fechaISO"]').value;
  const hora = form.querySelector('[name="hora"]').value;
  const boton = form.querySelector('button[type="submit"]');
  boton.disabled = true;

  try {
    const respuesta = await fetch("/acciones/reagendar-visita", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ producto: PRODUCTO, telefono, fechaISO, hora }),
    });
    if (!respuesta.ok) throw new Error("No se pudo reagendar la visita");
    window.location.reload();
  } catch (error) {
    console.error("Error reagendando:", error);
    alert("No se pudo reagendar. Intenta de nuevo.");
    boton.disabled = false;
  }
});
