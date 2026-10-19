// Reactivación de leads que se callaron sin agendar visita — plantilla de
// WhatsApp `reactivacion_visita` (categoría Marketing, aprobada por Meta),
// porque pasadas 24h desde el último mensaje del cliente WhatsApp solo
// permite escribirle con plantillas.
//
// Alcance acordado con Santiago (10-oct-2026):
// - Último mensaje del cliente hace entre 3 y 30 días (antes de 3 días aún
//   corren los seguimientos normales; después de 30, más riesgo de reporte
//   que de respuesta).
// - Solo calientes o tibios, o quien dijo que quería visitar.
// - Nunca a: visita agendada, no contactar (bot o etapa del CRM),
//   eliminados del CRM, conversación tomada por un asesor.
// - UNA sola vez por lead, para siempre.
// - Máximo MAX_POR_DIA envíos al día (el primer día hay acumulado).
// - Botones: "Sí, quiero visitar" / "Más adelante" / "No me interesa" — el
//   último lo maneja el bot y deja al lead en no contactar.
//
// APAGADO por defecto: no envía nada salvo que la variable de entorno
// REACTIVACION_ACTIVA sea exactamente "true" (se enciende en Railway cuando
// Meta apruebe la plantilla). El registro de enviados reutiliza la tabla de
// la secuencia de visitas (secuencia_visita_enviada), con fecha_visita "-".
//
// MODO PRUEBA (13-oct-2026): si existe la variable REACTIVACION_PRUEBA_TELEFONO
// (ej. 573012876722), cada vez que el CRM arranca le manda la plantilla SOLO a
// ese número (sin registrarla, para poder repetir la prueba) y escribe en los
// registros la lista de clientes reales que HOY recibirían la plantilla, sin
// enviarles nada. Borrar la variable al terminar la prueba.

import { productos } from "../config/productos.js";
import {
  listarLeadsCrm,
  listarTelefonosEliminados,
  yaSeEnvioTouchSecuencia,
  registrarEnvioSecuencia,
} from "../db/crm.js";
import { listarCandidatasReactivacion } from "../db/productoDb.js";

const PLANTILLA = "reactivacion_visita";
const MAX_POR_DIA = 20;
const MIN_DIAS = 3;
const MAX_DIAS = 30;
const CLAVE_REGISTRO = "-"; // no hay fecha de visita: un solo envío por teléfono

const normalizar = (t) =>
  String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

async function llamarBotEnviarPlantilla(producto, telefono, parametros, textoRegistro) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(`Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`);
  }
  const respuesta = await fetch(`${botUrl}/interno/enviar-plantilla`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Secret": secreto },
    body: JSON.stringify({ telefono, plantilla: PLANTILLA, parametros, esCliente: true, textoRegistro }),
  });
  if (!respuesta.ok) {
    throw new Error(`El bot respondió ${respuesta.status}: ${await respuesta.text()}`);
  }
}

// Se guarda en el historial el texto REAL que recibe el cliente (igual al
// aprobado en Meta), para que Paola tenga el contexto exacto si responde. Si
// se cambia el texto en Meta, cambiarlo aquí también.
const textoPlantilla = (nombre) =>
  `Hola ${nombre} 👋 Soy Paola, de Senderos del Lago. Hace unos días hablamos del proyecto y quería contarte que esta semana seguimos agendando visitas para conocerlo en persona. ¿Te aparto un horario?`;

// Meta no acepta variables vacías: sin nombre conocido queda "Hola de nuevo 👋".
const primerNombre = (nombreCompleto) => String(nombreCompleto || "").trim().split(/\s+/)[0] || "de nuevo";

// Lista de quienes HOY recibirían la plantilla (máximo MAX_POR_DIA), ya con
// todos los filtros aplicados. La usan tanto el envío real como el modo prueba.
async function seleccionarDestinatarios(producto) {
  const [candidatas, leadsCrm, eliminados] = await Promise.all([
    listarCandidatasReactivacion(producto.slug, { minDias: MIN_DIAS, maxDias: MAX_DIAS }),
    listarLeadsCrm(producto.slug),
    listarTelefonosEliminados(producto.slug),
  ]);
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  const destinatarios = [];
  for (const c of candidatas) {
    if (destinatarios.length >= MAX_POR_DIA) break;
    if (eliminados.has(c.telefono)) continue;
    const overlay = mapaCrm.get(c.telefono);
    if (normalizar(overlay?.etapa_nombre) === "no contactar") continue;
    if (await yaSeEnvioTouchSecuencia(producto.slug, c.telefono, CLAVE_REGISTRO, PLANTILLA)) continue;
    destinatarios.push({ telefono: c.telefono, nombre: primerNombre(overlay?.nombre_override || c.nombre) });
  }
  return { destinatarios, totalEnRango: candidatas.length };
}

async function procesarProducto(producto) {
  const { destinatarios, totalEnRango } = await seleccionarDestinatarios(producto);

  let enviados = 0;
  for (const { telefono, nombre } of destinatarios) {
    try {
      await llamarBotEnviarPlantilla(producto, telefono, [{ nombre: "nombre", valor: nombre }], textoPlantilla(nombre));
      await registrarEnvioSecuencia(producto.slug, telefono, CLAVE_REGISTRO, PLANTILLA);
      enviados++;
      console.log(`[Reactivacion] Enviada a ${nombre} (${telefono}).`);
    } catch (error) {
      console.error(`[Reactivacion] Error enviando a ${telefono}:`, error.message);
    }
  }
  console.log(`[Reactivacion] ${producto.slug}: ${enviados} enviada(s) hoy de ${totalEnRango} candidata(s) en rango.`);
}

// MODO PRUEBA — ver encabezado. No toca a ningún cliente real.
export async function ejecutarPruebaReactivacion() {
  const telefonoPrueba = String(process.env.REACTIVACION_PRUEBA_TELEFONO || "").replace(/\D/g, "");
  if (!telefonoPrueba) return;

  for (const producto of productos) {
    try {
      // 1) Envío real, solo al número de prueba (no se registra: se puede repetir).
      const leadsCrm = await listarLeadsCrm(producto.slug);
      const propio = leadsCrm.find((l) => l.telefono === telefonoPrueba);
      const nombre = primerNombre(propio?.nombre_override || "Santiago");
      await llamarBotEnviarPlantilla(producto, telefonoPrueba, [{ nombre: "nombre", valor: nombre }], textoPlantilla(nombre));
      console.log(`[Reactivacion][PRUEBA] Plantilla enviada SOLO al número de prueba ${telefonoPrueba} (${nombre}).`);

      // 2) Simulación: a quién le llegaría hoy, sin enviar nada.
      const { destinatarios, totalEnRango } = await seleccionarDestinatarios(producto);
      console.log(
        `[Reactivacion][PRUEBA] Simulación ${producto.slug}: hoy se enviarían ${destinatarios.length} (de ${totalEnRango} en rango). NO se envió nada a estos clientes:`
      );
      for (const d of destinatarios) console.log(`[Reactivacion][PRUEBA]   - ${d.nombre} (${d.telefono})`);
    } catch (error) {
      console.error(`[Reactivacion][PRUEBA] Error con el producto "${producto.slug}":`, error.message);
    }
  }
}

export async function procesarReactivacionLeads() {
  if (process.env.REACTIVACION_ACTIVA !== "true") {
    console.log("[Reactivacion] Apagada (REACTIVACION_ACTIVA no es 'true') — no se envía nada.");
    return;
  }
  for (const producto of productos) {
    try {
      await procesarProducto(producto);
    } catch (error) {
      console.error(`[Reactivacion] Error con el producto "${producto.slug}":`, error);
    }
  }
}
