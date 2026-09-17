// Secuencia de "mantenimiento del deseo": entre el día que un cliente
// agenda una visita y el día de la visita, se le manda una serie de
// mensajes por WhatsApp (plantillas aprobadas por Meta) para mantener el
// interés y subir la tasa de asistencia real. Diseñada a partir de un
// análisis de comportamiento del cliente (sept. 2026) — el problema que
// resuelve: la gente agenda con anticipación, pero para el día de la visita
// ya se enfrió o no contesta el recordatorio.
//
// Se evalúa UNA VEZ AL DÍA, a las 7am (cron en index.js — esa misma hora
// cubre también el envío puntual de `visita_dia_de_hoy`, que debe salir a
// primera hora del día de la visita sin importar a qué hora sea la cita).
// Cada visita puede recibir hasta 4 toques; cada uno se manda una sola vez
// por visita (ver db/crm.js: yaSeEnvioTouchSecuencia/registrarEnvioSecuencia).
//
// La "fecha de agendamiento" no existe como campo directo en ninguna base
// de datos — se usa el mismo proxy que ya usa el reporte de asistencia por
// horizonte (routes/dashboard.js): la primera vez que el lead entró a la
// etapa "Visita agendada". Si un lead no tiene ese dato (por ejemplo, un
// caso viejo de antes de que existiera este sistema), simplemente no se le
// manda la secuencia — no hay forma segura de saber en qué punto va.

import { productos } from "../config/productos.js";
import {
  listarEtapas,
  obtenerSecuenciaEtapas,
  yaSeEnvioTouchSecuencia,
  registrarEnvioSecuencia,
} from "../db/crm.js";
import { listarVisitasAgendadas } from "../db/productoDb.js";

// Punto de encuentro por defecto para `visita_dia_de_hoy` (ver
// config/proyecto.js del bot: es el km 0 del recorrido al proyecto). Si en
// el futuro un asesor cambia el punto de encuentro para un cliente puntual,
// este es el primer lugar a ajustar.
const LUGAR_ENCUENTRO = "Café La Palma";

// Video fijo del toque de "prueba social" — el mismo para todos los
// clientes (no varía por persona). Cambiarlo aquí no requiere volver a
// pasar por la aprobación de Meta, porque la plantilla solo tiene
// registrado el TIPO de encabezado (video); el archivo real se manda en
// cada envío (ver enviarPlantillaWhatsApp en el bot).
const VIDEO_PRUEBA_SOCIAL_URL = "https://senderos-bot-production.up.railway.app/media/Personas_Navegando.mp4";

const GOOGLE_EARTH_LINK = "https://earth.google.com/earth/d/1GFaPCBn7xbWotAA7yZPwOVVDjBV6gjwB";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Recibe una fecha en formato "YYYY-MM-DD" y la vuelve "20 de septiembre" —
// se parte el string a mano (no con `new Date(...)`) para no arriesgar un
// corrimiento de día por husos horarios: fecha_visita_iso es una fecha de
// calendario, no un instante en el tiempo.
function formatearFechaLegible(fechaIso) {
  const [, mes, dia] = fechaIso.split("-").map(Number);
  return `${dia} de ${MESES[mes - 1]}`;
}

// Diferencia en días de calendario entre dos fechas "YYYY-MM-DD" (b - a).
function diasEntre(fechaIsoA, fechaIsoB) {
  return Math.round((new Date(`${fechaIsoB}T00:00:00Z`) - new Date(`${fechaIsoA}T00:00:00Z`)) / 86400000);
}

async function llamarBotEnviarPlantilla(producto, telefono, plantilla, parametros, headerMedia) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(`Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`);
  }

  const respuesta = await fetch(`${botUrl}/interno/enviar-plantilla`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Secret": secreto },
    body: JSON.stringify({ telefono, plantilla, parametros, headerMedia: headerMedia || undefined }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`El bot respondió ${respuesta.status}: ${detalle}`);
  }
}

// Para cada visita agendada de un producto, decide si HOY le toca alguno de
// los 4 toques de la secuencia, y si es así, lo manda (si no se había
// mandado antes para esa fecha de visita puntual).
async function procesarProducto(producto) {
  const [visitasCrudas, etapas, filas] = await Promise.all([
    listarVisitasAgendadas(producto.slug),
    listarEtapas(producto.slug),
    obtenerSecuenciaEtapas(producto.slug),
  ]);

  // Primera vez que cada teléfono entró a "Visita agendada" — mismo cálculo
  // que calcularAsistenciaPorHorizonte en routes/dashboard.js.
  const etapaVisita = etapas.find((e) => e.nombre === "Visita agendada");
  const mapaAgendadaEn = new Map();
  if (etapaVisita) {
    for (const fila of filas) {
      if (fila.etapa_id !== etapaVisita.id) continue;
      const actual = mapaAgendadaEn.get(fila.telefono);
      const entroEn = new Date(fila.entro_en);
      if (!actual || entroEn < actual) mapaAgendadaEn.set(fila.telefono, entroEn);
    }
  }

  const hoyISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });

  for (const visita of visitasCrudas) {
    if (!visita.fecha_visita_iso) continue;
    if (visita.fecha_visita_iso < hoyISO) continue; // la visita ya pasó

    const agendadaEn = mapaAgendadaEn.get(visita.telefono);
    if (!agendadaEn) continue; // sin dato de agendamiento, no se puede calcular la secuencia

    const agendadaEnISO = agendadaEn.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    const diasDesdeAgendamiento = diasEntre(agendadaEnISO, hoyISO);
    const diasHastaVisita = diasEntre(hoyISO, visita.fecha_visita_iso);
    const totalDias = diasDesdeAgendamiento + diasHastaVisita;

    const nombreCliente = visita.nombre || "Hola";
    const horaVisita = visita.hora_visita_pendiente || "la hora acordada";

    let candidato = null;

    if (diasHastaVisita === 0) {
      candidato = {
        plantilla: "visita_dia_de_hoy",
        parametros: [
          { nombre: "nombre", valor: nombreCliente },
          { nombre: "hora", valor: horaVisita },
          { nombre: "lugar", valor: LUGAR_ENCUENTRO },
        ],
      };
    } else if (diasHastaVisita === 1) {
      candidato = {
        plantilla: "visita_dia_antes",
        parametros: [
          { nombre: "nombre", valor: nombreCliente },
          { nombre: "link", valor: GOOGLE_EARTH_LINK },
        ],
      };
    } else {
      // Punto medio: solo tiene sentido si hay margen real entre el toque
      // emocional (día 1-2) y el día antes de la visita — si la visita es
      // muy próxima, se salta directo al toque emocional.
      const puntoMedio = Math.round(totalDias / 2);
      if (totalDias >= 5 && diasDesdeAgendamiento === puntoMedio) {
        candidato = {
          plantilla: "visita_prueba_social",
          parametros: [{ nombre: "nombre", valor: nombreCliente }],
          headerMedia: { tipo: "video", link: VIDEO_PRUEBA_SOCIAL_URL },
        };
      } else if (diasDesdeAgendamiento === 1 || diasDesdeAgendamiento === 2) {
        candidato = {
          plantilla: "visita_toque_emocional",
          parametros: [
            { nombre: "nombre", valor: nombreCliente },
            { nombre: "fecha", valor: formatearFechaLegible(visita.fecha_visita_iso) },
            { nombre: "hora", valor: horaVisita },
          ],
        };
      }
    }

    if (!candidato) continue;

    try {
      const yaEnviado = await yaSeEnvioTouchSecuencia(
        producto.slug,
        visita.telefono,
        visita.fecha_visita_iso,
        candidato.plantilla
      );
      if (yaEnviado) continue;

      await llamarBotEnviarPlantilla(
        producto,
        visita.telefono,
        candidato.plantilla,
        candidato.parametros,
        candidato.headerMedia
      );
      await registrarEnvioSecuencia(producto.slug, visita.telefono, visita.fecha_visita_iso, candidato.plantilla);
      console.log(
        `[SecuenciaVisitas] ${candidato.plantilla} enviada a ${nombreCliente} (${visita.telefono}, visita ${visita.fecha_visita_iso}).`
      );
    } catch (error) {
      console.error(
        `[SecuenciaVisitas] Error enviando ${candidato.plantilla} a ${visita.telefono}:`,
        error.message
      );
    }
  }
}

export async function procesarSecuenciaVisitas() {
  for (const producto of productos) {
    try {
      await procesarProducto(producto);
    } catch (error) {
      console.error(`[SecuenciaVisitas] Error con el producto "${producto.slug}":`, error);
    }
  }
}
