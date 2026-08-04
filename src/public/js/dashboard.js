const socket = io();
const puntoConexion = document.getElementById("estado-conexion");

socket.on("connect", () => {
  puntoConexion.classList.add("conectado");
  socket.emit("unirse", { producto: PRODUCTO });
});

socket.on("disconnect", () => {
  puntoConexion.classList.remove("conectado");
});

socket.on("novedad", async () => {
  try {
    const respuesta = await fetch(`/api/dashboard?producto=${encodeURIComponent(PRODUCTO)}`, {
      headers: { Accept: "application/json" },
    });
    if (!respuesta.ok) return;
    const datos = await respuesta.json();
    actualizarDashboard(datos);
  } catch (error) {
    console.error("Error refrescando el dashboard:", error);
  }
});

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

function tarjetaLead(lead, tipo) {
  const nombre = escaparHtml(lead.respuestas?.nombre || lead.telefono);
  const motivo =
    tipo === "intervencion" && lead.motivo_gestion_humana
      ? `<p class="tarjeta-lead-motivo">Paola no pudo avanzar: ${escaparHtml(lead.motivo_gestion_humana)}</p>`
      : "";
  const visitaOk =
    tipo === "intervencion" && lead.visita_agendada
      ? `<p class="tarjeta-lead-visita-ok">✓ Ya tiene visita agendada${
          lead.fecha_visita_iso
            ? ` — ${escaparHtml(lead.fecha_visita_iso)}${lead.hora_visita_pendiente ? " " + escaparHtml(lead.hora_visita_pendiente) : ""}`
            : ""
        }</p>`
      : "";
  const meta = [
    lead.respuestas?.uso ? `<span>Uso: ${escaparHtml(lead.respuestas.uso)}</span>` : "",
    lead.respuestas?.presupuesto ? `<span>Presupuesto: ${escaparHtml(lead.respuestas.presupuesto)}</span>` : "",
    lead.temasInteres?.length > 0 ? `<span>Pidió ver: ${escaparHtml(lead.temasInteres.join(", "))}</span>` : "",
    `<span>${escaparHtml(lead.tiempoTexto)}</span>`,
  ].join("");
  const botonTomarCaso =
    tipo === "intervencion"
      ? `<button class="boton boton-tomar-caso" data-telefono="${lead.telefono}">Tomar caso</button>`
      : "";

  return `
    <div class="tarjeta-lead tarjeta-lead-${tipo}" data-telefono="${lead.telefono}">
      <div class="tarjeta-lead-info">
        <div class="tarjeta-lead-titulo">
          <span class="tarjeta-lead-nombre">${nombre}</span>
          <span class="etiqueta etiqueta-${lead.clasificacion}">${lead.clasificacion}</span>
        </div>
        ${motivo}
        ${visitaOk}
        <div class="tarjeta-lead-meta">${meta}</div>
      </div>
      <div class="tarjeta-lead-acciones">
        <a class="boton boton-secundario" href="/conversacion/${PRODUCTO}/${lead.telefono}">Ver conversación</a>
        ${botonTomarCaso}
      </div>
    </div>
  `;
}

function tarjetaVisitaProxima(v) {
  const tipoTexto = v.tipo_visita === "oficina" ? "Reunión en oficina" : "Visita al proyecto";
  return `
    <div class="tarjeta-visita" data-telefono="${v.telefono}">
      <div class="tarjeta-visita-info">
        <span class="tarjeta-lead-nombre">${escaparHtml(v.nombre || v.telefono)}</span>
        <span class="tarjeta-visita-fecha">${escaparHtml(v.fecha_visita_iso)}${v.hora_visita_pendiente ? " — " + escaparHtml(v.hora_visita_pendiente) : ""}</span>
        <span class="tarjeta-visita-tipo">${tipoTexto}</span>
      </div>
      <a class="boton boton-secundario" href="/conversacion/${PRODUCTO}/${v.telefono}">Ver conversación</a>
    </div>
  `;
}

function tarjetaVisitaConfirmar(v) {
  return `
    <div class="tarjeta-visita" data-telefono="${v.telefono}">
      <div class="tarjeta-visita-info">
        <span class="tarjeta-lead-nombre">${escaparHtml(v.nombre || v.telefono)}</span>
        <span class="tarjeta-visita-fecha">Estaba agendada para el ${escaparHtml(v.fecha_visita_iso)}${v.hora_visita_pendiente ? " — " + escaparHtml(v.hora_visita_pendiente) : ""}</span>
      </div>
      <div class="tarjeta-visita-acciones">
        <button class="boton boton-visita-resultado" data-telefono="${v.telefono}" data-resultado="asistio">Sí asistió</button>
        <button class="boton boton-secundario boton-visita-resultado" data-telefono="${v.telefono}" data-resultado="no_asistio">No asistió</button>
        <button class="boton boton-secundario boton-visita-resultado" data-telefono="${v.telefono}" data-resultado="reagendada">Se reagendó</button>
      </div>
    </div>
  `;
}

function listaVisitas(visitas, tarjetaFn, vacioTexto) {
  if (visitas.length === 0) return `<p class="texto-discreto">${vacioTexto}</p>`;
  return visitas.map(tarjetaFn).join("");
}

function listaLeads(leads, tipo) {
  if (leads.length === 0) {
    return `<p class="texto-discreto">No hay leads en esta categoría por ahora.</p>`;
  }
  return leads.map((lead) => tarjetaLead(lead, tipo)).join("");
}

function actualizarDashboard(datos) {
  document.getElementById("grid-resumen").innerHTML = `
    <div class="tarjeta-resumen">
      <p class="tarjeta-resumen-etiqueta">Requieren intervención</p>
      <p class="tarjeta-resumen-numero numero-urgente">${datos.resumen.requierenIntervencion}</p>
    </div>
    <div class="tarjeta-resumen">
      <p class="tarjeta-resumen-etiqueta">Calientes sin agendar</p>
      <p class="tarjeta-resumen-numero numero-caliente">${datos.resumen.calientesSinAgendar}</p>
    </div>
    <div class="tarjeta-resumen">
      <p class="tarjeta-resumen-etiqueta">Se están enfriando</p>
      <p class="tarjeta-resumen-numero numero-enfriandose">${datos.resumen.leadsEnfriandose}</p>
    </div>
    <div class="tarjeta-resumen">
      <p class="tarjeta-resumen-etiqueta">En seguimiento automático</p>
      <p class="tarjeta-resumen-numero">${datos.resumen.enSeguimiento}</p>
    </div>
    <div class="tarjeta-resumen">
      <p class="tarjeta-resumen-etiqueta">Visitas agendadas</p>
      <p class="tarjeta-resumen-numero numero-exito">${datos.resumen.visitasAgendadas}</p>
    </div>
  `;
  document.getElementById("lista-intervencion").innerHTML = listaLeads(datos.requierenIntervencion, "intervencion");
  document.getElementById("lista-calientes").innerHTML = listaLeads(datos.calientesSinAgendar, "caliente");
  document.getElementById("lista-enfriandose").innerHTML = listaLeads(datos.leadsEnfriandose, "enfriandose");
  document.getElementById("lista-visitas-proximas").innerHTML = listaVisitas(
    datos.visitasProximas,
    tarjetaVisitaProxima,
    "No hay visitas agendadas por ahora."
  );
  document.getElementById("lista-visitas-confirmar").innerHTML = listaVisitas(
    datos.visitasPorConfirmar,
    tarjetaVisitaConfirmar,
    "No hay visitas pendientes de confirmar."
  );
}

document.addEventListener("click", async (evento) => {
  const botonResultado = evento.target.closest(".boton-visita-resultado");
  if (botonResultado) {
    const telefono = botonResultado.dataset.telefono;
    const resultado = botonResultado.dataset.resultado;
    const tarjeta = botonResultado.closest(".tarjeta-visita");
    const botones = tarjeta.querySelectorAll("button");
    botones.forEach((b) => (b.disabled = true));

    try {
      const respuesta = await fetch("/acciones/visita-resultado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, resultado }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar el resultado");
      tarjeta.remove();
    } catch (error) {
      console.error("Error guardando resultado de visita:", error);
      botones.forEach((b) => (b.disabled = false));
      alert("No se pudo guardar. Intenta de nuevo.");
    }
    return;
  }

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
  }
});
