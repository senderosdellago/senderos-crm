import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { responderConClaude } from "./services/claude.js";
import {
  consultarHorariosParaFecha,
  verificarDisponibilidadExacta,
  agendarVisita,
  consultarHorariosOficinaParaFecha,
  verificarDisponibilidadOficinaExacta,
  agendarReunionOficina,
} from "./services/calendar.js";
import { notificarEquipo, enviarMensajeEquipo } from "./services/notificacion.js";
import {
  descargarNotaDeVoz,
  transcribirAudio,
  generarAudioDesdeTexto,
} from "./services/audio.js";
import {
  guardarMensaje,
  actualizarEstado,
  obtenerConversacion,
  guardarConversacion,
  listarConversaciones,
  listarConversacionesRecientes,
  intentarMarcarProcesado,
  verificarConexionDB,
} from "./data/conversaciones.js";
import cron from "node-cron";
import { ejecutarAuditoria } from "./services/auditor.js";
import { ejecutarChequeoOperativo } from "./services/vigilante.js";
import { ejecutarSeguimientos } from "./services/seguimiento.js";
import { proyecto } from "./config/proyecto.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
// Sirve archivos estáticos (brochure, fotos, video) desde src/public/media/
// como https://<tu-dominio>/media/nombre-del-archivo — permanente, sin
// depender de ningún servicio externo.
app.use("/media", express.static(path.join(__dirname, "public", "media")));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Senderos del Lago Bot — activo");
});

// Endpoint de salud, para monitoreo externo (ej. UptimeRobot).
app.get("/health", async (req, res) => {
  try {
    await verificarConexionDB();
    res.status(200).json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", detalle: error.message });
  }
});

function csv(valor) {
  const texto = String(valor ?? "").replace(/"/g, '""').replace(/\r?\n/g, " | ");
  return `"${texto}"`;
}

// Convierte el historial completo en texto legible para revisión diaria
// ("CLIENTE: ... " / "PAOLA: ..." por línea). La función csv() ya existente
// se encarga de convertir los saltos de línea en " | " para que quepa bien
// en una sola celda de Excel.
function formatearHistorialCompleto(historial) {
  return (historial || [])
    .map((m) => `${m.role === "user" ? "CLIENTE" : "PAOLA"}: ${m.content}`)
    .join("\n");
}

function extraerUltimoIntercambio(historial) {
  const ultimoCliente = [...historial].reverse().find((m) => m.role === "user");
  const ultimoBot = [...historial].reverse().find((m) => m.role === "assistant");
  return {
    ultimoCliente: ultimoCliente?.content || "",
    ultimoBot: ultimoBot?.content || "",
  };
}

app.get("/admin/reporte", async (req, res) => {
  try {
    if (req.query.clave !== process.env.ADMIN_SECRET) {
      return res.status(403).send("No autorizado");
    }
    // ?horas=24 -> solo conversaciones actualizadas en las últimas 24h (ideal
    // para la revisión diaria). Sin ese parámetro, se mantiene el
    // comportamiento de siempre: trae TODAS las conversaciones.
    const horas = req.query.horas ? parseInt(req.query.horas, 10) : null;
    const conversaciones =
      horas && !Number.isNaN(horas)
        ? await listarConversacionesRecientes(horas, 500)
        : await listarConversaciones();
    const encabezado = [
      "telefono",
      "nombre",
      "clasificacion",
      "quiere_visita",
      "uso",
      "presupuesto",
      "tiempo_decision",
      "tipo_visita",
      "fecha_visita",
      "hora_visita",
      "visita_agendada",
      "total_mensajes",
      "ultimo_mensaje_cliente",
      "ultima_respuesta_bot",
      "actualizado",
      "conversacion_completa",
    ].join(",");
    const filas = conversaciones.map((fila) => {
      const historial = fila.historial || [];
      const respuestas = fila.respuestas || {};
      const { ultimoCliente, ultimoBot } = extraerUltimoIntercambio(historial);
      return [
        csv(fila.telefono),
        csv(respuestas.nombre),
        csv(fila.clasificacion),
        csv(fila.quiere_visita),
        csv(respuestas.uso),
        csv(respuestas.presupuesto),
        csv(respuestas.tiempo),
        csv(fila.tipo_visita),
        csv(fila.fecha_visita_iso),
        csv(fila.hora_visita_pendiente),
        csv(fila.visita_agendada ? "Sí" : "No"),
        historial.length,
        csv(ultimoCliente),
        csv(ultimoBot),
        csv(new Date(fila.actualizado_en).toLocaleString("es-CO", { timeZone: "America/Bogota" })),
        csv(formatearHistorialCompleto(historial)),
      ].join(",");
    });
    const contenido = "\uFEFF" + encabezado + "\n" + filas.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="conversaciones.csv"');
    res.send(contenido);
  } catch (error) {
    console.error("Error generando reporte:", error);
    res.status(500).send("Error generando el reporte");
  }
});

function esperar(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function calcularPausa(texto) {
  const base = 2000;
  const extra = Math.min(texto.length * 25, 2000);
  return base + extra;
}
// Pausa ANTES del primer mensaje de la respuesta — simula el tiempo real que
// le tomaría a una persona leer, pensar, y empezar a escribir. Se suma al
// tiempo que ya toma la llamada a Claude, y coincide con la ventana en la que
// el indicador nativo de "escribiendo..." de WhatsApp está activo (hasta 25s).
function calcularPausaInicial(mensajes) {
  const totalCaracteres = mensajes.join(" ").length;
  const base = 2000;
  const extra = Math.min(totalCaracteres * 25, 8000);
  return base + extra;
}
const MENSAJES_TRANSICION_HORA = [
  "¡Listo! Dame un momento que verifico la disponibilidad exacta 🙏",
  "¡Perfecto! Déjame confirmar eso contra la agenda y ya te cuento 🙌",
  "¡Va! Un segundito que reviso el cupo exacto 😊",
];

function elegirMensajeTransicion() {
  const indice = Math.floor(Math.random() * MENSAJES_TRANSICION_HORA.length);
  return MENSAJES_TRANSICION_HORA[indice];
}

function formatearFechaBonita(fechaISO) {
  const fecha = new Date(`${fechaISO}T12:00:00-05:00`);
  return fecha.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Bogota",
  });
}

// Marca el mensaje entrante como leído (2 checks azules) y activa el indicador
// nativo de "escribiendo..." de WhatsApp mientras Claude procesa la respuesta
// — dura hasta 25 segundos o hasta que llegue el mensaje real, lo que pase
// primero. No es un retraso simulado: es visible exactamente durante el
// tiempo real que toma pensar la respuesta, sin agregar espera adicional.
async function marcarLeidoYEscribiendo(phoneNumberId, messageId) {
  try {
    await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      }
    );
  } catch (error) {
    console.error("Error mostrando indicador de escritura:", error.message);
  }
}

async function enviarMensajeWhatsApp(phoneNumberId, telefono, texto) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "text",
        text: { body: texto },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error: ${response.status} ${error}`);
  }
  return response.json();
}

// ============ ENVÍO DE MATERIAL MULTIMEDIA (brochure, fotos, video, ubicación) ============
// Solo se llaman si proyecto.materialMultimedia tiene la URL configurada
// (ver comprobación en procesarMensaje) — así nunca se intenta enviar algo
// que no existe todavía.

async function enviarDocumentoWhatsApp(phoneNumberId, telefono, urlDocumento, nombreArchivo) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "document",
        document: { link: urlDocumento, filename: nombreArchivo },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error (documento): ${response.status} ${error}`);
  }
  return response.json();
}

async function enviarImagenWhatsApp(phoneNumberId, telefono, urlImagen, caption) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "image",
        image: caption ? { link: urlImagen, caption } : { link: urlImagen },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error (imagen): ${response.status} ${error}`);
  }
  return response.json();
}

async function enviarVideoWhatsApp(phoneNumberId, telefono, urlVideo, caption) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "video",
        video: caption ? { link: urlVideo, caption } : { link: urlVideo },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error (video): ${response.status} ${error}`);
  }
  return response.json();
}

async function enviarUbicacionWhatsApp(phoneNumberId, telefono, ubicacion) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "location",
        location: {
          latitude: ubicacion.latitud,
          longitude: ubicacion.longitud,
          name: ubicacion.nombre,
          address: ubicacion.direccion,
        },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error (ubicación): ${response.status} ${error}`);
  }
  return response.json();
}

// Construye la lista de piezas de material multimedia a enviar, verificando
// SIEMPRE contra proyecto.materialMultimedia (doble seguro: aunque Claude
// marque el campo true, si la URL no está configurada, no se envía nada).
// IMPORTANTE: el control de "ya se envió" es por URL EXACTA (conv.mediaUrlsEnviadas),
// no por flags booleanos de tema — así, si el paquete de bienvenida ya mandó
// UNA foto del lago, y luego el cliente pide "más del lago", se le completan
// las demás fotos base que le faltan por ver (no salta directo al grupo
// "adicional" ni repite la misma). Esto es una salvaguarda de CÓDIGO, no solo
// de instrucciones de prompt, porque confirmamos con un caso real que el
// modelo puede volver a marcar el envío por relacionar el tema, sin que el
// cliente lo pida de nuevo. `conv` se muta aquí mismo y se guarda después
// junto con el resto del estado de la conversación. Agregar un tema nuevo en
// proyecto.js (ej. "tipologias") no requiere tocar esta función.
function construirMediaAEnviar(resultado, conv) {
  const mm = proyecto.materialMultimedia;
  const media = [];
  if (!Array.isArray(conv.mediaUrlsEnviadas)) conv.mediaUrlsEnviadas = [];

  // MIGRACIÓN DE COMPATIBILIDAD (una sola vez): conversaciones que ya
  // recibieron material bajo el sistema anterior (flags booleanos sueltos,
  // todo era del lago) no deben recibirlo otra vez ahora que el control es
  // por URL exacta. Si el arreglo nuevo está vacío pero los flags viejos
  // están en true, se rellena con las URLs correspondientes (todas viven hoy
  // bajo el tema "lago", que es exactamente lo único que existía antes).
  if (conv.mediaUrlsEnviadas.length === 0) {
    if (conv.brochureEnviado && mm.brochureUrl) conv.mediaUrlsEnviadas.push(mm.brochureUrl);
    if (conv.videoEnviado) {
      for (const v of mm.temas?.lago?.videos || []) conv.mediaUrlsEnviadas.push(v.url);
    }
    if (conv.fotosEnviadas) {
      for (const f of mm.temas?.lago?.fotos || []) {
        if (!f.adicional) conv.mediaUrlsEnviadas.push(f.url);
      }
    }
    if (conv.fotosAdicionalesEnviadas) {
      for (const f of mm.temas?.lago?.fotos || []) {
        if (f.adicional) conv.mediaUrlsEnviadas.push(f.url);
      }
    }
  }

  const yaEnviada = (url) => conv.mediaUrlsEnviadas.includes(url);
  const marcarEnviada = (url) => {
    if (!yaEnviada(url)) conv.mediaUrlsEnviadas.push(url);
  };

  if (resultado.enviarBrochure && mm.brochureUrl && !yaEnviada(mm.brochureUrl)) {
    media.push({ tipo: "documento", url: mm.brochureUrl, nombreArchivo: mm.brochureNombreArchivo });
    marcarEnviada(mm.brochureUrl);
  }

  if (
    resultado.enviarPaqueteBienvenida &&
    Array.isArray(mm.paqueteBienvenida) &&
    mm.paqueteBienvenida.length > 0 &&
    !conv.paqueteBienvenidaEnviado
  ) {
    for (const pieza of mm.paqueteBienvenida) {
      if (yaEnviada(pieza.url)) continue;
      if (pieza.tipo === "foto") {
        media.push({ tipo: "imagen", url: pieza.url, caption: pieza.descripcion || null });
      } else if (pieza.tipo === "video") {
        media.push({ tipo: "video", url: pieza.url, caption: pieza.descripcion || null });
      }
      marcarEnviada(pieza.url);
    }
    conv.paqueteBienvenidaEnviado = true;
  }

  if (resultado.contenidoVisualSolicitado) {
    const [tipo, tema] = resultado.contenidoVisualSolicitado.split("_");
    const temaData = mm.temas?.[tema];
    if (temaData) {
      if (tipo === "fotos" && Array.isArray(temaData.fotos)) {
        // Primero completa lo que falte del grupo base; solo si el base ya
        // está completo pasa al grupo "adicional" (más/otras fotos).
        const base = temaData.fotos.filter((f) => !f.adicional && !yaEnviada(f.url));
        const pendientes =
          base.length > 0 ? base : temaData.fotos.filter((f) => f.adicional && !yaEnviada(f.url));
        for (const foto of pendientes) {
          media.push({ tipo: "imagen", url: foto.url, caption: foto.descripcion || null });
          marcarEnviada(foto.url);
        }
      }
      if (tipo === "video" && Array.isArray(temaData.videos)) {
        for (const video of temaData.videos) {
          if (yaEnviada(video.url)) continue;
          media.push({ tipo: "video", url: video.url, caption: video.descripcion || null });
          marcarEnviada(video.url);
        }
      }
    }
  }

  if (
    resultado.enviarUbicacion &&
    mm.ubicacion?.latitud &&
    mm.ubicacion?.longitud &&
    !conv.ubicacionEnviada
  ) {
    media.push({ tipo: "ubicacion", ubicacion: mm.ubicacion });
    conv.ubicacionEnviada = true;
  }
  return media;
}

// Envía cada pieza de multimedia de forma aislada: si una falla (ej. el PDF
// del brochure), las demás piezas de la lista SÍ se siguen enviando — antes
// un solo fallo cortaba todo el lote a mitad de camino sin que nadie se
// enterara más que en los logs de Railway. Devuelve los errores encontrados
// para que quien llama pueda avisarle al equipo con el detalle real.
async function enviarMediaConPausa(phoneNumberId, telefono, mediaAEnviar) {
  const errores = [];
  for (const item of mediaAEnviar) {
    try {
      if (item.tipo === "documento") {
        await enviarDocumentoWhatsApp(phoneNumberId, telefono, item.url, item.nombreArchivo);
      } else if (item.tipo === "imagen") {
        await enviarImagenWhatsApp(phoneNumberId, telefono, item.url, item.caption);
      } else if (item.tipo === "video") {
        await enviarVideoWhatsApp(phoneNumberId, telefono, item.url, item.caption);
      } else if (item.tipo === "ubicacion") {
        await enviarUbicacionWhatsApp(phoneNumberId, telefono, item.ubicacion);
      }
    } catch (errorPieza) {
      console.error(`Error enviando pieza de multimedia (${item.tipo}, ${item.url || "sin url"}):`, errorPieza);
      errores.push({ tipo: item.tipo, url: item.url || null, error: errorPieza.message });
    }
    await esperar(1000);
  }
  return errores;
}

async function enviarMensajesConPausa(phoneNumberId, telefono, mensajes) {
  await esperar(calcularPausaInicial(mensajes));
  for (let i = 0; i < mensajes.length; i++) {
    await enviarMensajeWhatsApp(phoneNumberId, telefono, mensajes[i]);
    if (i < mensajes.length - 1) {
      await esperar(calcularPausa(mensajes[i]));
    }
  }
}

async function subirMediaWhatsApp(phoneNumberId, buffer, mimeType) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append("file", blob, "audio.ogg");
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: formData,
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp media upload error: ${response.status} ${error}`);
  }
  const datos = await response.json();
  return datos.id;
}

async function enviarAudioWhatsApp(phoneNumberId, telefono, mediaId) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: telefono,
        type: "audio",
        audio: { id: mediaId },
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API error (audio): ${response.status} ${error}`);
  }
  return response.json();
}

async function enviarNotasDeVozConPausa(phoneNumberId, telefono, mensajes) {
  for (let i = 0; i < mensajes.length; i++) {
    const audioBuffer = await generarAudioDesdeTexto(mensajes[i]);
    const mediaId = await subirMediaWhatsApp(phoneNumberId, audioBuffer, "audio/ogg");
    await enviarAudioWhatsApp(phoneNumberId, telefono, mediaId);
    if (i < mensajes.length - 1) {
      await esperar(calcularPausa(mensajes[i]));
    }
  }
}

async function notificarFalloCalendar(telefono, conv, errorDetalle) {
  const mensajeUrgente =
    `🚨 *ALERTA — Fallo técnico agendando visita* 🚨\n\n` +
    `Un lead ${conv.clasificacion === "caliente" ? "CALIENTE 🔥" : "tibio"} quiere agendar visita AHORA, pero el sistema tuvo un problema técnico con el calendario.\n\n` +
    `👤 Nombre: ${conv.respuestas?.nombre || "No capturado"}\n` +
    `📞 Teléfono: ${telefono}\n` +
    `📋 Uso previsto: ${conv.respuestas?.uso || "No especificado"}\n` +
    `💰 Presupuesto: ${conv.respuestas?.presupuesto || "No especificado"}\n` +
    `⏰ Tiempo de decisión: ${conv.respuestas?.tiempo || "No especificado"}\n\n` +
    `⚠️ CONTACTAR DE INMEDIATO para confirmar la visita manualmente — el cliente está esperando respuesta.\n\n` +
    `Detalle técnico: ${errorDetalle}`;
  await notificarEquipo(telefono, { ...conv, mensajePersonalizado: mensajeUrgente }, "Por confirmar manualmente");
}

async function notificarGestionHumana(telefono, conv, motivo) {
  const mensaje =
    `📌 *Lead requiere gestión de asesor — ${conv.clasificacion === "caliente" ? "CALIENTE 🔥" : conv.clasificacion}* \n\n` +
    `Un cliente quiere agendar una visita pero con una condición especial que el sistema automático no puede resolver. Ya se le avisó que un asesor lo contactará.\n\n` +
    `👤 Nombre: ${conv.respuestas?.nombre || "No capturado"}\n` +
    `📞 Teléfono: ${telefono}\n` +
    `📋 Uso previsto: ${conv.respuestas?.uso || "No especificado"}\n` +
    `💰 Presupuesto: ${conv.respuestas?.presupuesto || "No especificado"}\n` +
    `⏰ Tiempo de decisión: ${conv.respuestas?.tiempo || "No especificado"}\n` +
    `🗓️ Condición especial que pide: ${motivo}\n\n` +
    `⚠️ CONTACTAR para coordinar la visita y cerrar el cliente.`;
  await notificarEquipo(telefono, { ...conv, mensajePersonalizado: mensaje }, "Gestión especial");
}

// Notificación de agendamiento de reunión en OFICINA (distinta a visita al proyecto).
async function notificarReunionOficina(telefono, conv, fechaTexto) {
  const mensaje =
    `🏢 *Nueva reunión en OFICINA agendada - ${proyecto.nombre}*\n\n` +
    `👤 Nombre: ${conv.respuestas?.nombre || "No capturado"}\n` +
    `📞 Teléfono: ${telefono}\n` +
    `📋 Uso previsto: ${conv.respuestas?.uso || "No especificado"}\n` +
    `🌡️ Clasificación: ${conv.clasificacion}\n` +
    `📅 Fecha/hora: ${fechaTexto}\n` +
    `📌 Tema a tratar: ${conv.motivoReunionOficina || "No especificado"}\n\n` +
    `⚠️ Revisar si se requiere la presencia del abogado o la ingeniera según el tema.`;
  await enviarMensajeEquipo(mensaje);
}

// ============ INTEGRACIÓN CON EL CRM (Módulo 1 — panel de intervención humana) ============
//
// El bot le avisa al CRM cada vez que hay novedad en una conversación (mensaje
// nuevo, cambio de estado, etc.), pasándole solo el teléfono. El CRM se encarga
// de ir a buscar los datos completos directamente en esta misma base de datos.
// Mientras CRM_WEBHOOK_URL no esté configurada (ej. antes de que el CRM exista),
// esta función simplemente no hace nada — el bot sigue funcionando normal.
async function notificarCRM(telefono) {
  const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
  if (!CRM_WEBHOOK_URL) return;
  try {
    const response = await fetch(CRM_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Interno-Secret": process.env.CRM_INTERNO_SECRET || "",
      },
      body: JSON.stringify({ telefono, producto: "senderos" }),
    });
    if (!response.ok) {
      console.error(`[CRM] Webhook respondió ${response.status} para ${telefono}`);
    }
  } catch (error) {
    console.error(`[CRM] Error notificando novedad de ${telefono}:`, error.message);
  }
}

// Middleware para proteger los endpoints internos que el CRM usa para
// comandar al bot (tomar control, devolver control, enviar mensaje manual).
function verificarSecretoInterno(req, res, next) {
  const secretoConfigurado = process.env.CRM_INTERNO_SECRET;
  const secretoRecibido = req.headers["x-interno-secret"];
  if (!secretoConfigurado || secretoRecibido !== secretoConfigurado) {
    return res.status(403).json({ error: "No autorizado" });
  }
  next();
}

// El CRM llama esto cuando un asesor hace clic en "Tomar control": el bot
// deja de responder automáticamente a este teléfono.
app.post("/interno/intervenir", verificarSecretoInterno, async (req, res) => {
  try {
    const { telefono, asesor } = req.body;
    if (!telefono) return res.status(400).json({ error: "Falta 'telefono'" });
    const conv = await obtenerConversacion(telefono);
    conv.intervencionHumana = true;
    conv.intervenidoPor = asesor || null;
    await guardarConversacion(telefono, conv);
    notificarCRM(telefono).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    console.error("Error activando intervención humana:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// El CRM llama esto cuando un asesor hace clic en "Devolver al bot".
app.post("/interno/devolver", verificarSecretoInterno, async (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ error: "Falta 'telefono'" });
    const conv = await obtenerConversacion(telefono);
    conv.intervencionHumana = false;
    conv.intervenidoPor = null;
    await guardarConversacion(telefono, conv);
    notificarCRM(telefono).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    console.error("Error devolviendo control al bot:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// El CRM llama esto cuando un asesor escribe un mensaje manual desde el
// panel. El bot es el único que le habla directamente a la API de WhatsApp,
// para que nunca haya dos fuentes distintas enviando mensajes al cliente.
app.post("/interno/mensaje-manual", verificarSecretoInterno, async (req, res) => {
  try {
    const { telefono, mensaje, phoneNumberId } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ error: "Falta 'telefono' o 'mensaje'" });
    }
    const idNumero = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    await enviarMensajeWhatsApp(idNumero, telefono, mensaje);
    const conv = await obtenerConversacion(telefono);
    guardarMensaje(conv, "assistant", mensaje);
    await guardarConversacion(telefono, conv);
    notificarCRM(telefono).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    console.error("Error enviando mensaje manual:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ============ AGENDAMIENTO — VISITA AL PROYECTO ============

async function intentarAgendarHoraExacta(telefono, conv, mensajesRespuesta) {
  try {
    const { libre, franja } = await verificarDisponibilidadExacta(
      conv.fechaVisitaISO,
      conv.horaVisitaPendiente
    );
    if (libre) {
      await agendarVisita(franja, {
        nombre: conv.respuestas?.nombre || "Cliente",
        telefono,
        clasificacion: conv.clasificacion,
        respuestas: conv.respuestas,
      });
      conv.visitaAgendada = true;
      const fechaTexto = `${formatearFechaBonita(conv.fechaVisitaISO)}, ${conv.horaVisitaPendiente}`;
      notificarEquipo(telefono, conv, fechaTexto).catch((err) =>
        console.error("Error notificando al equipo:", err)
      );
      const respuestaFinal = `¡Perfecto! 🎉 Tu visita quedó agendada para el ${fechaTexto}. ¡Nos vemos pronto en Senderos del Lago! 🌿`;
      const mensajeSeguimiento = `Uno de nuestros asesores del proyecto te estará contactando en breve para definir el punto de encuentro. 📍`;
      mensajesRespuesta.push(respuestaFinal, mensajeSeguimiento);
      guardarMensaje(conv, "assistant", `${respuestaFinal}\n${mensajeSeguimiento}`);
    } else {
      const disponibles = await consultarHorariosParaFecha(conv.fechaVisitaISO);
      if (disponibles.length > 0) {
        const listaTexto = disponibles.map((d) => d.etiqueta).join(", ");
        const mensaje = `¡Uy, ese horario ya lo reservaron! Para ese día tengo disponible: ${listaTexto}. ¿Cuál te sirve?`;
        mensajesRespuesta.push(mensaje);
        guardarMensaje(conv, "assistant", mensaje);
      } else {
        const mensaje = `Para ese día se nos llenó la agenda — hay bastante movimiento de visitas. ¿Tienes otro día en mente?`;
        mensajesRespuesta.push(mensaje);
        guardarMensaje(conv, "assistant", mensaje);
        conv.fechaVisitaISO = null;
      }
    }
  } catch (errorCalendar) {
    console.error(`Error verificando disponibilidad exacta para ${telefono}:`, errorCalendar);
    notificarFalloCalendar(telefono, conv, errorCalendar.message).catch((err) =>
      console.error("Error enviando alerta de fallo al equipo:", err)
    );
    const mensaje =
      "En este momento estoy teniendo un inconveniente técnico para confirmar tu horario — un asesor de nuestro equipo te va a contactar en breve. 🙏";
    mensajesRespuesta.push(mensaje);
    guardarMensaje(conv, "assistant", mensaje);
  }
}

async function ofrecerHorariosDelDia(telefono, conv, mensajesRespuesta) {
  try {
    const disponibles = await consultarHorariosParaFecha(conv.fechaVisitaISO);
    conv.horariosOfrecidosParaFecha = true;
    if (disponibles.length > 0) {
      const listaTexto = disponibles.map((d) => d.etiqueta).join(", ");
      const mensaje = `Para ese día tengo disponible: ${listaTexto}. ¿Cuál te queda mejor? Si prefieres otra hora, dime y la reviso. 😊`;
      mensajesRespuesta.push(mensaje);
      guardarMensaje(conv, "assistant", mensaje);
    } else {
      const mensaje = `Uy, para ese día no tengo cupos libres en los horarios habituales. ¿Tienes otro día en mente?`;
      mensajesRespuesta.push(mensaje);
      guardarMensaje(conv, "assistant", mensaje);
      conv.fechaVisitaISO = null;
    }
  } catch (errorCalendar) {
    console.error(`Error consultando horarios para fecha (${telefono}):`, errorCalendar);
    notificarFalloCalendar(telefono, conv, errorCalendar.message).catch((err) =>
      console.error("Error enviando alerta de fallo al equipo:", err)
    );
    const mensaje =
      "En este momento estoy teniendo un inconveniente técnico para mostrarte los horarios disponibles — un asesor de nuestro equipo te va a contactar en breve. 🙏";
    mensajesRespuesta.push(mensaje);
    guardarMensaje(conv, "assistant", mensaje);
  }
}

// ============ AGENDAMIENTO — REUNIÓN EN OFICINA ============

async function intentarAgendarHoraExactaOficina(telefono, conv, mensajesRespuesta) {
  try {
    const { libre, franja } = await verificarDisponibilidadOficinaExacta(
      conv.fechaVisitaISO,
      conv.horaVisitaPendiente
    );
    if (libre) {
      await agendarReunionOficina(
        franja,
        {
          nombre: conv.respuestas?.nombre || "Cliente",
          telefono,
          clasificacion: conv.clasificacion,
          respuestas: conv.respuestas,
        },
        conv.motivoReunionOficina
      );
      conv.visitaAgendada = true;
      const fechaTexto = `${formatearFechaBonita(conv.fechaVisitaISO)}, ${conv.horaVisitaPendiente}`;
      notificarReunionOficina(telefono, conv, fechaTexto).catch((err) =>
        console.error("Error notificando al equipo (oficina):", err)
      );
      const respuestaFinal = `¡Perfecto! 🎉 Tu reunión en nuestra oficina quedó agendada para el ${fechaTexto}, en ${proyecto.oficina.direccion}. ¡Nos vemos pronto! 🙌`;
      mensajesRespuesta.push(respuestaFinal);
      guardarMensaje(conv, "assistant", respuestaFinal);
    } else {
      const disponibles = await consultarHorariosOficinaParaFecha(conv.fechaVisitaISO);
      if (disponibles.length > 0) {
        const listaTexto = disponibles.map((d) => d.etiqueta).join(", ");
        const mensaje = `¡Uy, ese horario en la oficina ya lo reservaron! Para ese día tengo disponible: ${listaTexto}. ¿Cuál te sirve?`;
        mensajesRespuesta.push(mensaje);
        guardarMensaje(conv, "assistant", mensaje);
      } else {
        const mensaje = `Para ese día se nos llenó la agenda de la oficina — hay bastante movimiento estos días. ¿Tienes otro día en mente?`;
        mensajesRespuesta.push(mensaje);
        guardarMensaje(conv, "assistant", mensaje);
        conv.fechaVisitaISO = null;
      }
    }
  } catch (errorCalendar) {
    console.error(`Error verificando disponibilidad de oficina para ${telefono}:`, errorCalendar);
    notificarFalloCalendar(telefono, conv, errorCalendar.message).catch((err) =>
      console.error("Error enviando alerta de fallo al equipo:", err)
    );
    const mensaje =
      "En este momento estoy teniendo un inconveniente técnico para confirmar tu horario en la oficina — un asesor de nuestro equipo te va a contactar en breve. 🙏";
    mensajesRespuesta.push(mensaje);
    guardarMensaje(conv, "assistant", mensaje);
  }
}

async function ofrecerHorariosOficinaDelDia(telefono, conv, mensajesRespuesta) {
  try {
    const disponibles = await consultarHorariosOficinaParaFecha(conv.fechaVisitaISO);
    conv.horariosOfrecidosParaFecha = true;
    if (disponibles.length > 0) {
      const listaTexto = disponibles.map((d) => d.etiqueta).join(", ");
      const mensaje = `Para ese día en la oficina tengo disponible: ${listaTexto}. ¿Cuál te queda mejor? 😊`;
      mensajesRespuesta.push(mensaje);
      guardarMensaje(conv, "assistant", mensaje);
    } else {
      const mensaje = `Uy, para ese día no tengo cupos libres en la oficina. ¿Tienes otro día en mente?`;
      mensajesRespuesta.push(mensaje);
      guardarMensaje(conv, "assistant", mensaje);
      conv.fechaVisitaISO = null;
    }
  } catch (errorCalendar) {
    console.error(`Error consultando horarios de oficina (${telefono}):`, errorCalendar);
    notificarFalloCalendar(telefono, conv, errorCalendar.message).catch((err) =>
      console.error("Error enviando alerta de fallo al equipo:", err)
    );
    const mensaje =
      "En este momento estoy teniendo un inconveniente técnico para mostrarte los horarios de la oficina — un asesor de nuestro equipo te va a contactar en breve. 🙏";
    mensajesRespuesta.push(mensaje);
    guardarMensaje(conv, "assistant", mensaje);
  }
}

// ============ PROCESAMIENTO CENTRAL ============

async function procesarMensaje(telefono, texto) {
  const conv = await obtenerConversacion(telefono);
  guardarMensaje(conv, "user", texto);

  // Registro para el módulo de seguimiento: cuándo escribió el cliente por
  // última vez (define la ventana de 24h de WhatsApp), y reseteo del contador
  // de toques (si respondió, el ciclo de seguimiento arranca de cero).
  conv.ultimoMensajeClienteEn = new Date().toISOString();
  conv.toquesSeguimiento = 0;

  // Guardamos y avisamos al CRM de inmediato, ANTES de llamar a Claude, para
  // que el mensaje del cliente aparezca en el panel en tiempo real aunque
  // el bot todavía esté "pensando" la respuesta.
  await guardarConversacion(telefono, conv);
  notificarCRM(telefono).catch(() => {});

  // Si un asesor humano tiene tomada esta conversación, el bot no responde:
  // el mensaje ya quedó guardado y el CRM ya fue avisado, así que el asesor
  // lo ve en su panel y responde él mismo.
  if (conv.intervencionHumana) {
    console.log(`[Intervención] ${telefono} está en manos de un asesor humano — el bot no responde.`);
    return { mensajes: [], conv, mediaAEnviar: [] };
  }

  console.log(`[Claude] Procesando mensaje de ${telefono}...`);
  const resultado = await responderConClaude(conv.historial, conv.respuestas, {
    fechaVisitaISO: conv.fechaVisitaISO || null,
  });
  console.log(`[Claude] Respondió OK (${resultado.mensajes.length} mensajes)`);
  guardarMensaje(conv, "assistant", resultado.mensajes.join("\n"));
  actualizarEstado(conv, {
    clasificacion: resultado.clasificacion,
    quiereVisita: resultado.quiereVisita,
    respuestasNuevas: resultado.respuestasNuevas,
  });

  if (resultado.preferenciaCanal === "audio") {
    conv.prefiereAudio = true;
  } else if (resultado.preferenciaCanal === "texto") {
    conv.prefiereAudio = false;
  }

  // El cliente pidió explícitamente que no lo contacten más — esto detiene
  // el seguimiento automático (Fase 1 y Fase 2) para siempre, sin afectar
  // que Paola le siga respondiendo si él escribe de nuevo por su cuenta.
  if (resultado.noContactar) {
    conv.noContactar = true;
  }

  // Tipo de cita: proyecto (por defecto) u oficina.
  if (resultado.tipoVisitaSolicitado) {
    const tipoAnterior = conv.tipoVisita;
    conv.tipoVisita = resultado.tipoVisitaSolicitado;
    if (tipoAnterior !== conv.tipoVisita) {
      conv.horariosOfrecidosParaFecha = false;
    }
  }
  if (resultado.motivoReunionOficina) {
    conv.motivoReunionOficina = resultado.motivoReunionOficina;
  }

  let mensajesRespuesta = [...resultado.mensajes];
  const mediaAEnviar = construirMediaAEnviar(resultado, conv);

  if (resultado.requiereGestionHumana && !conv.gestionHumanaNotificada) {
    console.log(`[GestiónHumana] Lead con condición especial: ${resultado.motivoGestionHumana}`);
    conv.gestionHumanaNotificada = true;
    conv.motivoGestionHumana =
      resultado.motivoGestionHumana ||
      "El sistema detectó que este caso necesita un asesor, pero no quedó registrado el detalle exacto — revisa la conversación completa para ver el contexto.";
    notificarGestionHumana(telefono, conv, resultado.motivoGestionHumana).catch((err) =>
      console.error("Error notificando gestión humana:", err)
    );
    await guardarConversacion(telefono, conv);
    notificarCRM(telefono).catch(() => {});
    return { mensajes: mensajesRespuesta, conv, mediaAEnviar };
  }

  if (conv.visitaAgendada) {
    await guardarConversacion(telefono, conv);
    notificarCRM(telefono).catch(() => {});
    return { mensajes: mensajesRespuesta, conv, mediaAEnviar };
  }

  if (resultado.fechaVisitaSolicitada) {
    const cambioDeFecha = resultado.fechaVisitaSolicitada !== conv.fechaVisitaISO;
    conv.fechaVisitaISO = resultado.fechaVisitaSolicitada;
    if (cambioDeFecha) conv.horariosOfrecidosParaFecha = false;
  }

  if (conv.fechaVisitaISO) {
    const esOficina = conv.tipoVisita === "oficina";
    if (resultado.horaVisitaSolicitada) {
      conv.horaVisitaPendiente = resultado.horaVisitaSolicitada;
      // Reemplazamos lo que haya generado Claude para este turno por un mensaje
      // de transición fijo. Probamos varias veces reforzar esto solo por prompt
      // (no repetir fecha/hora, no preguntar nada más) y el modelo lo violó de
      // 3 formas distintas en pruebas reales — así que en este punto puntual y
      // sensible, el comportamiento queda garantizado por código, no por prompt.
      // IMPORTANTE: el mensaje original de Claude para este turno ya quedó
      // guardado en el historial más arriba (guardarMensaje justo después de
      // responderConClaude) — lo quitamos de ahí para que el historial refleje
      // EXACTAMENTE lo que el cliente recibió, y no un mensaje fantasma que
      // nunca se envió.
      conv.historial.pop();
      mensajesRespuesta = [elegirMensajeTransicion()];
      guardarMensaje(conv, "assistant", mensajesRespuesta[0]);
      if (esOficina) {
        await intentarAgendarHoraExactaOficina(telefono, conv, mensajesRespuesta);
      } else {
        await intentarAgendarHoraExacta(telefono, conv, mensajesRespuesta);
      }
    } else if (!conv.horariosOfrecidosParaFecha) {
      if (esOficina) {
        await ofrecerHorariosOficinaDelDia(telefono, conv, mensajesRespuesta);
      } else {
        await ofrecerHorariosDelDia(telefono, conv, mensajesRespuesta);
      }
    }
  }

  await guardarConversacion(telefono, conv);
  notificarCRM(telefono).catch(() => {});
  return { mensajes: mensajesRespuesta, conv, mediaAEnviar };
}

app.post("/test/mensaje", async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ error: "Falta 'telefono' o 'mensaje'" });
    }
    console.log(`[Test] Mensaje recibido de ${telefono}: ${mensaje}`);
    const { mensajes, conv, mediaAEnviar } = await procesarMensaje(telefono, mensaje);
    res.json({
      mensajes,
      mediaAEnviar,
      clasificacion: conv.clasificacion,
      quiereVisita: conv.quiereVisita,
      respuestas: conv.respuestas,
      tipoVisita: conv.tipoVisita,
      fechaVisitaISO: conv.fechaVisitaISO || null,
      visitaAgendada: !!conv.visitaAgendada,
      intervencionHumana: !!conv.intervencionHumana,
    });
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log(`[Webhook] Verificación recibida. mode=${mode}, token=${token}`);
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("[Webhook] Verificado correctamente");
    res.status(200).send(challenge);
  } else {
    console.log("[Webhook] Verificación FALLIDA — token no coincide");
    res.status(403).send("Token de verificación incorrecto");
  }
});

app.post("/webhook", async (req, res) => {
  console.log("[Webhook] POST recibido:", JSON.stringify(req.body).substring(0, 500));
  const body = req.body;
  if (body.object !== "whatsapp_business_account") {
    return res.sendStatus(404);
  }
  res.sendStatus(200);
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) {
      console.log("[Webhook] Evento sin mensaje (probablemente status/delivery), ignorado");
      return;
    }

    const esMensajeNuevo = await intentarMarcarProcesado(message.id);
    if (!esMensajeNuevo) {
      console.log(`[Webhook] Mensaje duplicado ignorado (id: ${message.id})`);
      return;
    }

    const telefono = message.from;
    const phoneNumberId = change.value.metadata.phone_number_id;

    // Activa "escribiendo..." de inmediato — se ve mientras se transcribe el
    // audio (si aplica) y mientras Claude genera la respuesta.
    marcarLeidoYEscribiendo(phoneNumberId, message.id).catch(() => {});

    let texto;

    if (message.type === "text") {
      texto = message.text.body;

      const esNumeroDelEquipo = (
        Array.isArray(proyecto.whatsappEquipo) ? proyecto.whatsappEquipo : [proyecto.whatsappEquipo]
      ).includes(telefono);

      if (esNumeroDelEquipo && texto.trim().toLowerCase() === "/auditoria") {
        console.log(`[Auditor] Comando manual recibido desde ${telefono}`);
        await enviarMensajeWhatsApp(
          phoneNumberId,
          telefono,
          "🔍 Auditoría iniciada — te llega el resumen en 1-2 minutos."
        );
        ejecutarAuditoria(24, 20).catch((err) =>
          console.error("[Auditor] Error ejecutando auditoría manual desde WhatsApp:", err)
        );
        return;
      }

      if (esNumeroDelEquipo && texto.trim().toLowerCase() === "/probarfallo") {
        console.log(`[Prueba] Fallo simulado solicitado desde ${telefono}`);
        throw new Error("Fallo de prueba disparado manualmente para verificar las alertas del equipo.");
      }

      if (esNumeroDelEquipo && texto.trim().toLowerCase() === "/estado") {
        console.log(`[Vigilante] Chequeo manual solicitado desde ${telefono}`);
        await enviarMensajeWhatsApp(
          phoneNumberId,
          telefono,
          "🔍 Revisando el estado del sistema..."
        );
        ejecutarChequeoOperativo()
          .then(() => enviarMensajeWhatsApp(phoneNumberId, telefono, "✅ Chequeo completado — si no ves otra alerta, todo está bien."))
          .catch((err) => console.error("[Vigilante] Error en chequeo manual:", err));
        return;
      }
    } else if (message.type === "audio") {
      console.log(`[WhatsApp] Nota de voz recibida de ${telefono}, descargando...`);
      try {
        const { buffer, mimeType } = await descargarNotaDeVoz(message.audio.id);
        console.log(`[Whisper] Transcribiendo audio...`);
        texto = await transcribirAudio(buffer, mimeType);
        console.log(`[Whisper] Transcripción: "${texto}"`);
        if (!texto) {
          await enviarMensajeWhatsApp(
            phoneNumberId,
            telefono,
            "No logré entender bien tu nota de voz 🙏 ¿Me la puedes repetir o escribirla?"
          );
          return;
        }
      } catch (errorAudio) {
        console.error("Error procesando nota de voz:", errorAudio);
        await enviarMensajeWhatsApp(
          phoneNumberId,
          telefono,
          "Tuve un problema procesando tu nota de voz 🙏 ¿Me la puedes escribir en texto?"
        );
        return;
      }
    } else {
      console.log(`[Webhook] Mensaje de tipo ${message.type}, no soportado aún`);
      return;
    }

    console.log(`[WhatsApp] Mensaje de ${telefono}: ${texto}`);

    const { mensajes, conv, mediaAEnviar } = await procesarMensaje(telefono, texto);

    if (mensajes.length === 0) {
      // Conversación en manos de un asesor humano: el bot no envía nada.
      return;
    }

    if (conv.prefiereAudio) {
      console.log(`[WhatsApp] Enviando ${mensajes.length} nota(s) de voz a ${telefono}...`);
      try {
        await enviarNotasDeVozConPausa(phoneNumberId, telefono, mensajes);
        console.log(`[WhatsApp] Notas de voz enviadas OK`);
      } catch (errorTTS) {
        console.error("Error generando/enviando notas de voz, fallback a texto:", errorTTS);
        await enviarMensajesConPausa(phoneNumberId, telefono, mensajes);
      }
    } else {
      console.log(`[WhatsApp] Enviando ${mensajes.length} mensaje(s) a ${telefono}...`);
      await enviarMensajesConPausa(phoneNumberId, telefono, mensajes);
      console.log(`[WhatsApp] Mensajes enviados OK`);
    }

    if (mediaAEnviar && mediaAEnviar.length > 0) {
      console.log(`[WhatsApp] Enviando ${mediaAEnviar.length} pieza(s) de material multimedia a ${telefono}...`);
      try {
        const erroresMedia = await enviarMediaConPausa(phoneNumberId, telefono, mediaAEnviar);
        if (erroresMedia.length > 0) {
          const detalle = erroresMedia
            .map((e) => `• ${e.tipo}${e.url ? ` (${e.url.split("/").pop()})` : ""}: ${e.error}`)
            .join("\n");
          enviarMensajeEquipo(
            `⚠️ *Material multimedia no se pudo enviar* ⚠️\n\n` +
            `📞 Cliente: ${telefono}\n` +
            `El cliente SÍ recibió el texto de la respuesta, pero ${erroresMedia.length} pieza(s) de multimedia falló(aron):\n\n${detalle}`
          ).catch((err) => console.error("Error enviando alerta de multimedia al equipo:", err));
        } else {
          console.log(`[WhatsApp] Material multimedia enviado OK`);
        }
      } catch (errorMedia) {
        console.error("Error enviando material multimedia:", errorMedia);
      }
    }
  } catch (error) {
    console.error("Error procesando mensaje de WhatsApp:", error);
    const telefonoParaAlerta = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    enviarMensajeEquipo(
      `🚨 *ERROR CRÍTICO — El bot no pudo responder* 🚨\n\n` +
      `📞 Cliente afectado: ${telefonoParaAlerta || "desconocido"}\n` +
      `⚠️ El cliente recibió un mensaje genérico de disculpa. Revisa los logs de Railway y contacta al cliente manualmente si es necesario.\n\n` +
      `Detalle técnico: ${error.message}`
    ).catch((err) => console.error("Error enviando alerta crítica al equipo:", err));
    try {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      const telefono = message?.from;
      const phoneNumberId = change?.value?.metadata?.phone_number_id;
      if (telefono && phoneNumberId) {
        await enviarMensajeWhatsApp(
          phoneNumberId,
          telefono,
          "Disculpa, tuve un inconveniente técnico. Un asesor te va a contactar en breve. 🙏"
        );
      }
    } catch (errorFallback) {
      console.error("Falló incluso el mensaje de emergencia:", errorFallback);
    }
  }
});

cron.schedule(
  "0 6 * * *",
  async () => {
    console.log("[Auditor] Ejecutando auditoría automática diaria...");
    try {
      await ejecutarAuditoria(24, 20);
    } catch (error) {
      console.error("[Auditor] Error ejecutando auditoría:", error);
    }
  },
  { timezone: "America/Bogota" }
);

cron.schedule("*/15 * * * *", async () => {
  try {
    await ejecutarChequeoOperativo();
  } catch (error) {
    console.error("[Vigilante] Error ejecutando chequeo operativo:", error);
  }
});

cron.schedule("*/15 * * * *", async () => {
  try {
    await ejecutarSeguimientos();
  } catch (error) {
    console.error("[Seguimiento] Error ejecutando seguimientos:", error);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
