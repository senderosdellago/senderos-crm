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
    const respuesta = await fetch(`/api/bandeja?producto=${encodeURIComponent(PRODUCTO)}`, {
      headers: { Accept: "application/json" },
    });
    if (!respuesta.ok) return;
    const datos = await respuesta.json();
    actualizarTabla(datos.conversaciones);
  } catch (error) {
    console.error("Error refrescando la bandeja:", error);
  }
});

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}
function escaparAtributo(texto) {
  return escaparHtml(texto).replace(/"/g, "&quot;");
}

function actualizarTabla(conversaciones) {
  const cuerpo = document.getElementById("cuerpo-bandeja");
  cuerpo.innerHTML = conversaciones
    .map((c) => {
      const estado = c.intervencion_humana
        ? `<span class="etiqueta etiqueta-intervenida">Con asesor${c.intervenido_por ? ` (${escaparHtml(c.intervenido_por)})` : ""}</span>`
        : `<span class="etiqueta etiqueta-bot">Paola (bot)</span>`;
      const fecha = new Date(c.actualizado_en).toLocaleString("es-CO", { timeZone: "America/Bogota" });
      return `
        <tr data-telefono="${c.telefono}">
          <td><input type="text" class="campo-nombre-editable" data-telefono="${c.telefono}" value="${escaparAtributo(c.nombre)}" placeholder="Sin nombre" /></td>
          <td>${c.telefono}</td>
          <td><span class="etiqueta etiqueta-${c.clasificacion}">${c.clasificacion}</span></td>
          <td>${c.etapa_nombre || "-"}${c.etapa_porcentaje != null ? ` (${c.etapa_porcentaje}%)` : ""}</td>
          <td>${c.asesor_nombre || "-"}</td>
          <td>${c.visita_agendada ? "Agendada" : "-"}</td>
          <td>${estado}</td>
          <td>${fecha}</td>
          <td><a href="/conversacion/${PRODUCTO}/${c.telefono}">Ver</a></td>
        </tr>
      `;
    })
    .join("");
}

// ============ Nombre editable (funciona tanto en la carga inicial como en las filas que se refrescan solas) ============
document.addEventListener(
  "blur",
  async (evento) => {
    const campo = evento.target.closest?.(".campo-nombre-editable");
    if (!campo) return;

    const telefono = campo.dataset.telefono;
    const valorAnterior = campo.dataset.valorAnterior ?? campo.defaultValue;
    const valorNuevo = campo.value.trim();
    if (valorNuevo === (campo.dataset.valorAnterior ?? campo.defaultValue)) return;

    campo.disabled = true;
    try {
      const respuesta = await fetch("/acciones/editar-campo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ producto: PRODUCTO, telefono, campo: "nombre_override", valor: valorNuevo || null }),
      });
      if (!respuesta.ok) throw new Error("No se pudo guardar el nombre");
      campo.dataset.valorAnterior = valorNuevo;
    } catch (error) {
      console.error("Error guardando nombre:", error);
      campo.value = valorAnterior;
      alert("No se pudo guardar el nombre. Intenta de nuevo.");
    } finally {
      campo.disabled = false;
    }
  },
  true
);
