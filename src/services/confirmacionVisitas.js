// Confirmación de resultado de visita por WhatsApp: todas las noches a las
// 7pm (hora Colombia) se revisan las visitas agendadas para hoy o antes que
// TODAVÍA no tengan un resultado registrado (leads_crm.visita_resultado), y
// se le pregunta al asesor asignado "¿cómo te fue?" por WhatsApp — igual que
// el mecanismo ya existente de "asignar asesor por WhatsApp" (ver
// webhook.js y manejarRespuestaResultadoVisita en el bot).
//
// Si la visita no tiene asesor asignado todavía, se le pregunta a todo el
// equipo como respaldo (mismo fallback que ya usan las alertas de "sin
// asesor").
//
// A propósito NO se filtra por fecha "de hoy únicamente": cualquier visita
// vencida que siga sin resultado se vuelve a preguntar cada noche, hasta que
// alguien conteste (así lo pidió Santiago) — el filtro real es
// "visita_resultado IS NULL", que se limpia solo apenas alguien responde.

import { productos } from "../config/productos.js";
import { listarLeadsCrm, listarUsuariosActivos } from "../db/crm.js";
import { listarVisitasAgendadas } from "../db/productoDb.js";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Mismo truco que en secuenciaVisitas.js: partir el string a mano para no
// arriesgar un corrimiento de día por husos horarios.
function formatearFechaLegible(fechaIso) {
  const [, mes, dia] = fechaIso.split("-").map(Number);
  return `${dia} de ${MESES[mes - 1]}`;
}

function hoyISOColombia() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

// `telefono` null → le pregunta a todo el equipo (usa /interno/notificar-equipo);
// `telefono` puesto → le pregunta solo a esa persona (/interno/notificar-persona).
async function llamarBotNotificar(producto, { telefono, evento, ruta, contextoAccionable }) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(`Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`);
  }

  const endpoint = telefono ? "/interno/notificar-persona" : "/interno/notificar-equipo";
  const body = telefono ? { telefono, evento, ruta, contextoAccionable } : { evento, ruta, contextoAccionable };

  const respuesta = await fetch(`${botUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Secret": secreto },
    body: JSON.stringify(body),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`El bot respondió ${respuesta.status}: ${detalle}`);
  }
}

async function procesarProducto(producto) {
  const slug = producto.slug;
  const [visitasCrudas, leadsCrm, usuarios] = await Promise.all([
    listarVisitasAgendadas(slug),
    listarLeadsCrm(slug),
    listarUsuariosActivos(),
  ]);

  const mapaUsuarios = new Map(usuarios.map((u) => [u.id, u]));
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
  const hoyISO = hoyISOColombia();

  for (const visita of visitasCrudas) {
    if (!visita.fecha_visita_iso) continue;
    if (visita.fecha_visita_iso > hoyISO) continue; // la visita todavía no ha pasado

    const overlay = mapaCrm.get(visita.telefono);
    if (overlay?.visita_resultado) continue; // ya tiene resultado, no hay nada que preguntar

    const nombreCliente = visita.nombre || "el cliente";
    const horaVisita = visita.hora_visita_pendiente || "la hora acordada";
    const fechaLegible = formatearFechaLegible(visita.fecha_visita_iso);
    const evento = `¿Cómo te fue con la visita de ${nombreCliente} el ${fechaLegible} a las ${horaVisita}? Respóndeme citando este mensaje: asistió, no asistió, o reagendó.`;

    const asesor = overlay?.asesor_id ? mapaUsuarios.get(overlay.asesor_id) : null;
    const telefonoAsesor = asesor?.telefono || null;

    const contextoAccionable = {
      tipo: "resultado_visita",
      producto: slug,
      telefonoCliente: visita.telefono,
      nombreCliente,
    };

    try {
      await llamarBotNotificar(producto, {
        telefono: telefonoAsesor,
        evento,
        ruta: "/dashboard/visitas",
        contextoAccionable,
      });
      console.log(
        `[ConfirmacionVisitas] Preguntado por ${nombreCliente} (${visita.telefono}) a ${
          telefonoAsesor ? `${asesor.nombre} (${telefonoAsesor})` : "todo el equipo (sin asesor asignado)"
        }.`
      );
    } catch (error) {
      // Un fallo con una visita puntual no debe frenar el resto.
      console.error(`[ConfirmacionVisitas] Error preguntando por ${visita.telefono}:`, error.message);
    }
  }
}

export async function procesarConfirmacionVisitas() {
  for (const producto of productos) {
    try {
      await procesarProducto(producto);
    } catch (error) {
      console.error(`[ConfirmacionVisitas] Error con el producto "${producto.slug}":`, error);
    }
  }
}
