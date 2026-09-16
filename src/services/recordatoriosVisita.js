// Alertas relacionadas con visitas próximas que aún no tienen asesor
// asignado — sin esto, el cliente puede llegar al día de la visita sin
// saber quién lo va a atender, y el asesor real (si al final se asigna
// tarde) se entera casi sin margen de reacción.
//
// Se ejecuta una vez al día (cron en index.js, mismo horario que el
// recordatorio diario de asesores) y revisa las visitas agendadas para
// EXACTAMENTE dentro de 2 días y dentro de 1 día — dos avisos con urgencia
// creciente, no uno solo, para dar margen real de reaccionar.
//
// No guarda ningún estado de "ya avisé" — simplemente se vuelve a evaluar
// cada día contra el asesor_id actual, así que si alguien asigna el
// asesor entre un aviso y otro, el aviso siguiente ya no se manda.

import { productos } from "../config/productos.js";
import { listarLeadsCrm, listarUsuariosActivos } from "../db/crm.js";
import { listarVisitasAgendadas } from "../db/productoDb.js";

// Asesor de contacto por defecto para el mensaje al CLIENTE (secuencia de
// mantenimiento de visitas, aún pendiente de la plantilla de Meta): si al
// momento de enviarlo la visita sigue sin asesor asignado —a pesar de las
// alertas de este archivo—, el cliente nunca se queda sin un nombre y
// número a quién escribirle. Decisión de Santiago (sept. 2026): Diana.
const ASESOR_POR_DEFECTO = { nombre: "Diana", telefono: "573043448613" };

function fechaISOColombiaEnNDias(n) {
  const fecha = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return fecha.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

async function llamarBotNotificarEquipo(producto, evento, ruta, contextoAccionable) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(`Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`);
  }

  const respuesta = await fetch(`${botUrl}/interno/notificar-equipo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Secret": secreto },
    body: JSON.stringify({ evento, ruta, contextoAccionable }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`El bot respondió ${respuesta.status}: ${detalle}`);
  }
}

// Cruza las visitas agendadas para mañana y pasado mañana (base del bot)
// con quién tiene asignado cada lead (base del CRM) y avisa al equipo si
// falta asesor.
async function revisarAsesoresDeProducto(producto) {
  const [visitasCrudas, leadsCrm] = await Promise.all([
    listarVisitasAgendadas(producto.slug),
    listarLeadsCrm(producto.slug),
  ]);

  const mapaAsesorAsignado = new Map(leadsCrm.map((l) => [l.telefono, l.asesor_id]));

  const fechaManana = fechaISOColombiaEnNDias(1);
  const fechaPasadoManana = fechaISOColombiaEnNDias(2);

  for (const visita of visitasCrudas) {
    let horizonte = null;
    if (visita.fecha_visita_iso === fechaManana) horizonte = 1;
    else if (visita.fecha_visita_iso === fechaPasadoManana) horizonte = 2;
    if (horizonte === null) continue;

    if (mapaAsesorAsignado.get(visita.telefono)) continue; // ya tiene asesor

    const nombreCliente = visita.nombre || visita.telefono;
    const urgencia = horizonte === 1 ? "🔴 MAÑANA" : "⚠️ Pasado mañana";
    const evento = `${urgencia}: visita de ${nombreCliente} sin asesor asignado`;

    try {
      await llamarBotNotificarEquipo(producto, evento, "/dashboard/visitas", {
        tipo: "sin_asesor",
        producto: producto.slug,
        telefonoCliente: visita.telefono,
        nombreCliente,
      });
      console.log(
        `[Recordatorios] Alerta de asesor sin asignar enviada (${nombreCliente}, horizonte ${horizonte}d).`
      );
    } catch (error) {
      console.error(`[Recordatorios] Error avisando asesor sin asignar (${nombreCliente}):`, error.message);
    }
  }
}

export async function revisarAsesoresDeVisitasProximas() {
  for (const producto of productos) {
    try {
      await revisarAsesoresDeProducto(producto);
    } catch (error) {
      console.error(`[Recordatorios] Error con el producto "${producto.slug}":`, error);
    }
  }
}

// Para cuando esté lista la plantilla de cliente: el asesor a mostrarle al
// CLIENTE en los mensajes de la secuencia de visita — el asignado en el
// CRM si existe, o ASESOR_POR_DEFECTO si a esa altura la visita sigue sin
// nadie asignado.
export async function obtenerAsesorParaCliente(slug, telefono) {
  const [leadsCrm, usuariosActivos] = await Promise.all([listarLeadsCrm(slug), listarUsuariosActivos()]);
  const lead = leadsCrm.find((l) => l.telefono === telefono);
  const usuario = lead?.asesor_id ? usuariosActivos.find((u) => u.id === lead.asesor_id) : null;
  if (usuario?.telefono) return { nombre: usuario.nombre, telefono: usuario.telefono };
  return ASESOR_POR_DEFECTO;
}
