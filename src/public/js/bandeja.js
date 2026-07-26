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

function actualizarTabla(conversaciones) {
  const cuerpo = document.getElementById("cuerpo-bandeja");
  cuerpo.innerHTML = conversaciones
    .map((c) => {
      const estado = c.intervencion_humana
        ? `<span class="etiqueta etiqueta-intervenida">Con asesor${c.intervenido_por ? ` (${c.intervenido_por})` : ""}</span>`
        : `<span class="etiqueta etiqueta-bot">Paola (bot)</span>`;
      const fecha = new Date(c.actualizado_en).toLocaleString("es-CO", { timeZone: "America/Bogota" });
      return `
        <tr data-telefono="${c.telefono}">
          <td>${c.nombre || "(sin nombre)"}</td>
          <td>${c.telefono}</td>
          <td><span class="etiqueta etiqueta-${c.clasificacion}">${c.clasificacion}</span></td>
          <td>${c.etapa_nombre || "-"}</td>
          <td>${c.visita_agendada ? "Agendada" : "-"}</td>
          <td>${estado}</td>
          <td>${fecha}</td>
          <td><a href="/conversacion/${PRODUCTO}/${c.telefono}">Ver</a></td>
        </tr>
      `;
    })
    .join("");
}
