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

async function procesarProducto(producto) {
  const [candidatas, leadsCrm, eliminados] = await Promise.all([
    listarCandidatasReactivacion(producto.slug, { minDias: MIN_DIAS, maxDias: MAX_DIAS }),
    listarLeadsCrm(producto.slug),
    listarTelefonosEliminados(producto.slug),
  ]);
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  let enviados = 0;
  for (const c of candidatas) {
    if (enviados >= MAX_POR_DIA) break;
    if (eliminados.has(c.telefono)) continue;
    const overlay = mapaCrm.get(c.telefono);
    if (normalizar(overlay?.etapa_nombre) === "no contactar") continue;
    if (await yaSeEnvioTouchSecuencia(producto.slug, c.telefono, CLAVE_REGISTRO, PLANTILLA)) continue;

    // Meta no acepta variables vacías: sin nombre conocido queda "Hola de nuevo 👋".
    const nombreCompleto = overlay?.nombre_override || c.nombre || "";
    const nombre = nombreCompleto.trim().split(/\s+/)[0] || "de nuevo";

    try {
      await llamarBotEnviarPlantilla(
        producto,
        c.telefono,
        [{ nombre: "nombre", valor: nombre }],
        // Se guarda en el historial el texto REAL que recibe el cliente (igual
        // al aprobado en Meta), para que Paola tenga el contexto exacto si
        // responde. Si se cambia el texto en Meta, cambiarlo aquí también.
        `Hola ${nombre} 👋 Soy Paola, de Senderos del Lago. Hace unos días hablamos del proyecto y quería contarte que esta semana seguimos agendando visitas para conocerlo en persona. ¿Te aparto un horario?`
      );
      await registrarEnvioSecuencia(producto.slug, c.telefono, CLAVE_REGISTRO, PLANTILLA);
      enviados++;
      console.log(`[Reactivacion] Enviada a ${nombre} (${c.telefono}).`);
    } catch (error) {
      console.error(`[Reactivacion] Error enviando a ${c.telefono}:`, error.message);
    }
  }
  console.log(`[Reactivacion] ${producto.slug}: ${enviados} enviada(s) hoy de ${candidatas.length} candidata(s) en rango.`);
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
