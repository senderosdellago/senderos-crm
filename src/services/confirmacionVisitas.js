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
//
// CAMBIO (3-oct-2026, a pedido de Santiago): con varias semanas de backlog
// acumulado, esto empezó a mandarle a un asesor un mensaje POR CADA visita
// vencida sin resultado — si tenía 8 pendientes, le llegaban 8 mensajes
// seguidos. Ahora se separa en dos ventanas, por destinatario:
//   - RECIENTES (últimas 48h desde la fecha de la visita): se mantiene el
//     detalle de siempre, un mensaje por visita, preguntando puntualmente
//     por esa persona — porque todavía vale la pena que el asesor recuerde
//     el caso y pueda responder citando ese mensaje puntual.
//   - ANTIGUAS (de más de 48h): en vez de un mensaje por visita, se manda UN
//     solo resumen con el conteo ("tienes 8 visitas que no me has
//     confirmado..."), pidiendo que entre al CRM a llenarlas — ese mensaje
//     no se puede responder citando (no apunta a una visita puntual), así
//     que es solo un recordatorio para ir al panel.

import { productos } from "../config/productos.js";
import { listarLeadsCrm, listarUsuariosActivos } from "../db/crm.js";
import { listarVisitasAgendadas } from "../db/productoDb.js";

// Dominio del propio CRM — mismo valor que usa resumenVendedores.js, para el
// link del resumen de visitas antiguas.
const CRM_URL = process.env.CRM_URL || "https://senderos-crm-production.up.railway.app";

// A partir de cuántas horas desde la fecha de la visita se considera
// "antigua" (deja de preguntarse en detalle, una por una, y pasa a contarse
// en el resumen agrupado). 48 horas = 2 días de calendario.
const VENTANA_RECIENTE_HORAS = 48;

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

// Horas transcurridas desde el mediodía de la fecha de la visita hasta
// ahora — mediodía como referencia porque fecha_visita_iso no guarda una
// hora exacta de corte, y no hace falta más precisión que "días" para esta
// ventana de 48h.
function horasDesdeVisita(fechaVisitaIso) {
  return (Date.now() - new Date(`${fechaVisitaIso}T12:00:00-05:00`).getTime()) / (1000 * 60 * 60);
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

  // Agrupa las visitas vencidas sin resultado por destinatario (el asesor
  // asignado, o "equipo" si no hay ninguno) — necesario para poder mandar UN
  // solo resumen de las antiguas por persona, en vez de uno por visita.
  const porDestinatario = new Map(); // clave: id del asesor, o "equipo"

  for (const visita of visitasCrudas) {
    if (!visita.fecha_visita_iso) continue;
    if (visita.fecha_visita_iso > hoyISO) continue; // la visita todavía no ha pasado

    const overlay = mapaCrm.get(visita.telefono);
    if (overlay?.visita_resultado) continue; // ya tiene resultado, no hay nada que preguntar

    const asesor = overlay?.asesor_id ? mapaUsuarios.get(overlay.asesor_id) : null;
    const clave = asesor?.id ?? "equipo";

    if (!porDestinatario.has(clave)) {
      porDestinatario.set(clave, { asesor, recientes: [], antiguas: [] });
    }
    const grupo = porDestinatario.get(clave);
    if (horasDesdeVisita(visita.fecha_visita_iso) <= VENTANA_RECIENTE_HORAS) {
      grupo.recientes.push(visita);
    } else {
      grupo.antiguas.push(visita);
    }
  }

  for (const { asesor, recientes, antiguas } of porDestinatario.values()) {
    const telefonoDestino = asesor?.telefono || null;
    const nombreDestino = asesor ? `${asesor.nombre} (${telefonoDestino})` : "todo el equipo (sin asesor asignado)";

    // RECIENTES: el detalle de siempre, una pregunta puntual por visita.
    for (const visita of recientes) {
      const nombreCliente = visita.nombre || "el cliente";
      const horaVisita = visita.hora_visita_pendiente || "la hora acordada";
      const fechaLegible = formatearFechaLegible(visita.fecha_visita_iso);
      const evento = `¿Cómo te fue con la visita de ${nombreCliente} el ${fechaLegible} a las ${horaVisita}? Respóndeme citando este mensaje: asistió, no asistió, o reagendó.`;
      const contextoAccionable = {
        tipo: "resultado_visita",
        producto: slug,
        telefonoCliente: visita.telefono,
        nombreCliente,
      };

      try {
        await llamarBotNotificar(producto, { telefono: telefonoDestino, evento, ruta: "/dashboard/visitas", contextoAccionable });
        console.log(`[ConfirmacionVisitas] Preguntado (detalle) por ${nombreCliente} (${visita.telefono}) a ${nombreDestino}.`);
      } catch (error) {
        // Un fallo con una visita puntual no debe frenar el resto.
        console.error(`[ConfirmacionVisitas] Error preguntando por ${visita.telefono}:`, error.message);
      }
    }

    // ANTIGUAS: un solo resumen con el conteo, sin contexto accionable (no
    // apunta a una visita puntual) — pide entrar al CRM a llenarlas.
    if (antiguas.length > 0) {
      const evento =
        `Tienes ${antiguas.length} visita${antiguas.length === 1 ? "" : "s"} de hace más de 2 días que no me has ` +
        `confirmado si asistió o no. Entra al CRM para llenar esa información — es vital para nuestro seguimiento: ` +
        `${CRM_URL}/dashboard/visitas`;

      try {
        await llamarBotNotificar(producto, { telefono: telefonoDestino, evento, ruta: "/dashboard/visitas", contextoAccionable: null });
        console.log(`[ConfirmacionVisitas] Resumen de ${antiguas.length} visita(s) antigua(s) enviado a ${nombreDestino}.`);
      } catch (error) {
        console.error(`[ConfirmacionVisitas] Error enviando resumen a ${nombreDestino}:`, error.message);
      }
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
