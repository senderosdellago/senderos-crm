// Recordatorio diario por WhatsApp a cada vendedor con el estado de sus
// leads. Cruza DOS bases de datos que nunca se combinan en una sola consulta
// — el nombre del cliente y la fecha de la visita viven en la base del BOT
// (productoDb.js, solo lectura), mientras que la etapa del pipeline y a qué
// asesor está asignado el lead viven en la base propia del CRM (crm.js) —
// exactamente el mismo cruce que ya hace organizarVisitas en
// routes/dashboard.js.
//
// Se llama una vez al día desde un cron en index.js (ver ahí el horario).
// Si falla el envío a un vendedor puntual, o falla un producto completo, NO
// debe tumbar el resto — cada error se registra y se sigue con lo demás.

import { productos } from "../config/productos.js";
import { listarLeadsCrm, listarUsuariosActivos, listarTelefonosEliminados } from "../db/crm.js";
import { listarConversacionesParaTriage, listarVisitasAgendadas } from "../db/productoDb.js";

// Dominio del propio CRM — es el link que va en el {{link}} de la
// plantilla, para que el asesor entre a ver el detalle completo (el
// mensaje de WhatsApp solo trae las cifras, no la lista).
const CRM_URL = process.env.CRM_URL || "https://senderos-crm-production.up.railway.app";

// Mismo truco que en routes/dashboard.js (hoyISOColombia): usar el locale
// en-CA da el formato YYYY-MM-DD, para comparar contra fecha_visita_iso (que
// se guarda como texto) sin errores de huso horario.
function fechaISOColombiaEnNDias(n) {
  const fecha = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return fecha.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

// Llama al bot para que mande la plantilla APROBADA POR META
// "recordatorio_diario_asesor" — ya no manda texto libre, porque un asesor
// casi nunca le ha escrito al bot en las últimas 24h, así que sin plantilla
// el envío fallaba en silencio. `parametros` va en el mismo orden que las
// variables {{nombre}}, {{negociacion}}, {{visitas}}, {{link}} de esa
// plantilla en Meta.
async function llamarBotEnviarPlantilla(producto, telefono, plantilla, parametros) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(
      `Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`
    );
  }

  const respuesta = await fetch(`${botUrl}/interno/enviar-plantilla`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Interno-Secret": secreto,
    },
    body: JSON.stringify({ telefono, plantilla, parametros }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`El bot respondió ${respuesta.status}: ${detalle}`);
  }
}

async function enviarResumenesDeProducto(producto) {
  const slug = producto.slug;
  const [conversaciones, leadsCrm, visitasCrudas, usuarios, telefonosEliminados] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
    listarVisitasAgendadas(slug),
    listarUsuariosActivos(),
    listarTelefonosEliminados(slug),
  ]);

  const mapaNombresConversacion = new Map(conversaciones.map((c) => [c.telefono, c.respuestas?.nombre]));
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  const hoy = fechaISOColombiaEnNDias(0);
  const limite = fechaISOColombiaEnNDias(2);

  const enNegociacion = leadsCrm
    .filter((l) => l.etapa_nombre === "Negociación")
    .map((l) => ({
      ...l,
      nombre: l.nombre_override || mapaNombresConversacion.get(l.telefono) || l.telefono,
    }));

  // listarLeadsCrm ya excluye los eliminados por su cuenta, pero
  // listarVisitasAgendadas viene de la base del BOT (otra base de datos, que
  // no sabe nada de "eliminado" en el CRM) — hay que quitarlos aquí también,
  // igual que hace construirDatosDashboard en routes/dashboard.js.
  const visitasProximas = visitasCrudas
    .filter((v) => !telefonosEliminados.has(v.telefono))
    .filter((v) => v.fecha_visita_iso >= hoy && v.fecha_visita_iso <= limite)
    .map((v) => ({
      ...v,
      nombre: mapaCrm.get(v.telefono)?.nombre_override || v.nombre || v.telefono,
      asesor_id: mapaCrm.get(v.telefono)?.asesor_id || null,
    }));

  const conteoVisitaAgendada = new Map();
  const conteoPendienteReprogramar = new Map();
  for (const l of leadsCrm) {
    if (!l.asesor_id) continue;
    if (l.etapa_nombre === "Visita agendada") {
      conteoVisitaAgendada.set(l.asesor_id, (conteoVisitaAgendada.get(l.asesor_id) || 0) + 1);
    } else if (l.etapa_nombre === "Pendiente reprogramar visita") {
      conteoPendienteReprogramar.set(l.asesor_id, (conteoPendienteReprogramar.get(l.asesor_id) || 0) + 1);
    }
  }

  for (const usuario of usuarios) {
    if (!usuario.telefono) continue; // sin teléfono configurado en Equipo, no se le puede escribir

    const misNegociaciones = enNegociacion.filter((l) => l.asesor_id === usuario.id);
    const misVisitas = visitasProximas.filter((v) => v.asesor_id === usuario.id);
    const misVisitaAgendada = conteoVisitaAgendada.get(usuario.id) || 0;
    const misPendienteReprogramar = conteoPendienteReprogramar.get(usuario.id) || 0;

    // Nada que reportar hoy: no molestar con un mensaje vacío. (Ojo: aunque
    // "Visita agendada"/"Pendiente reprogramar" no se muestren en el texto
    // de la plantilla — solo caben 2 cifras — SÍ cuentan para decidir si
    // vale la pena avisarle hoy; el asesor ve el resto al entrar al link.)
    if (misNegociaciones.length === 0 && misVisitas.length === 0 && misVisitaAgendada === 0 && misPendienteReprogramar === 0) {
      continue;
    }

    const parametros = [
      usuario.nombre,
      String(misNegociaciones.length),
      String(misVisitas.length),
      `${CRM_URL}/dashboard`,
    ];

    try {
      await llamarBotEnviarPlantilla(producto, usuario.telefono, "recordatorio_diario_asesor", parametros);
      console.log(`[Recordatorio diario] Enviado a ${usuario.nombre} (${usuario.telefono}).`);
    } catch (error) {
      // Un fallo con un vendedor puntual no debe frenar el resumen de los demás.
      console.error(`[Recordatorio diario] Error enviando a ${usuario.nombre} (${usuario.telefono}):`, error.message);
    }
  }
}

export async function enviarResumenesDiarios() {
  for (const producto of productos) {
    try {
      await enviarResumenesDeProducto(producto);
    } catch (error) {
      console.error(`[Recordatorio diario] Error con el producto "${producto.slug}":`, error);
    }
  }
}
