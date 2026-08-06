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
  }
});

// ============ Formulario de reagendar (página /dashboard/visitas) ============
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
