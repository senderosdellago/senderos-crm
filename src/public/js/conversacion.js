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
  lista.innerHTML = historial
    .map((m) => `<div class="burbuja burbuja-${m.role}">${escaparHtml(m.content)}</div>`)
    .join("");
  lista.scrollTop = lista.scrollHeight;
}

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
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
