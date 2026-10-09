import { Router } from "express";
import { obtenerProducto } from "../config/productos.js";
import {
  asegurarLeadCrm,
  registrarEvento,
  avanzarEtapaSiCorresponde,
  establecerEtapaEspecial,
  asignarAsesor,
  listarUsuariosActivos,
  guardarResultadoVisita,
} from "../db/crm.js";
import { obtenerConversacionProducto } from "../db/productoDb.js";

const router = Router();

// ============ Aviso "el cliente te respondió" (conversación tomada) ============
// Cuando un asesor toma una conversación ("Tomar control"), el bot deja de
// responder — y antes nadie se enteraba de que el cliente había vuelto a
// escribir, salvo que tuviera el CRM abierto justo en ese momento. Ahora,
// cada vez que llega un mensaje del cliente en una conversación tomada, se
// le avisa por WhatsApp (plantilla notificacion_equipo, vía el bot) a quien
// la tomó; si no se identifica, al asesor asignado; si tampoco hay, a todo
// el equipo. Como máximo UN aviso cada 15 minutos por cliente (el control
// vive en memoria: si el servidor se reinicia, a lo sumo llega un aviso de
// más, nunca uno de menos).
const MINUTOS_ENTRE_AVISOS_RESPUESTA = 15;
const ultimoAvisoRespuesta = new Map(); // "slug:telefono" -> timestamp ms

const normalizarNombreUsuario = (texto) =>
  String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

// En "Equipo" los teléfonos se guardan sin indicativo (ej. 3138513993);
// WhatsApp necesita el número completo con el 57 de Colombia.
function telefonoWhatsAppDeUsuario(telefono) {
  const digitos = String(telefono || "").replace(/\D/g, "");
  if (!digitos) return null;
  if (digitos.length === 10 && digitos.startsWith("3")) return `57${digitos}`;
  return digitos;
}

async function llamarBotAviso(producto, ruta, cuerpo) {
  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) throw new Error(`Falta ${producto.botUrlEnvVar} o ${producto.secretoEnvVar}`);
  const respuesta = await fetch(`${botUrl}${ruta}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Secret": secreto },
    body: JSON.stringify(cuerpo),
  });
  if (!respuesta.ok) throw new Error(`El bot respondió ${respuesta.status}: ${await respuesta.text()}`);
}

async function avisarSiClienteRespondioConversacionTomada(producto, telefono, conversacion, leadCrm) {
  if (!conversacion?.intervencion_humana) return;
  const historial = conversacion.historial || [];
  const ultimo = historial[historial.length - 1];
  if (ultimo?.role !== "user") return;

  // Solo mensajes recién llegados: esta ruta también se llama por otras
  // novedades (ej. al hacer clic en "Tomar control" justo después de que el
  // cliente escribió) — sin este filtro se mandaría un aviso por algo viejo.
  const momentoMensaje = ultimo.timestamp ? new Date(ultimo.timestamp).getTime() : 0;
  if (!momentoMensaje || Date.now() - momentoMensaje > 2 * 60 * 1000) return;

  const clave = `${producto.slug}:${telefono}`;
  const anterior = ultimoAvisoRespuesta.get(clave) || 0;
  if (Date.now() - anterior < MINUTOS_ENTRE_AVISOS_RESPUESTA * 60 * 1000) return;
  ultimoAvisoRespuesta.set(clave, Date.now());

  const usuarios = await listarUsuariosActivos();
  // 1) quien tomó la conversación (el CRM guarda su nombre completo al
  //    hacer clic en "Tomar control"); 2) el asesor asignado al lead.
  const buscado = normalizarNombreUsuario(conversacion.intervenido_por);
  let destinatario = buscado ? usuarios.find((u) => normalizarNombreUsuario(u.nombre) === buscado) : null;
  if (!destinatario?.telefono && leadCrm?.asesor_id) {
    destinatario = usuarios.find((u) => u.id === leadCrm.asesor_id) || null;
  }

  const nombreCliente = leadCrm?.nombre_override || conversacion.respuestas?.nombre || telefono;
  const ruta = `/conversacion/${producto.slug}/${telefono}`;
  const telefonoDestino = telefonoWhatsAppDeUsuario(destinatario?.telefono);

  if (telefonoDestino) {
    await llamarBotAviso(producto, "/interno/notificar-persona", {
      telefono: telefonoDestino,
      evento: `${nombreCliente} te respondió (conversación tomada por ti, el bot no le contesta)`,
      ruta,
    });
    console.log(`[TeRespondio] ${telefono}: aviso enviado a ${destinatario.nombre} (${telefonoDestino}).`);
  } else {
    await llamarBotAviso(producto, "/interno/notificar-equipo", {
      evento: `${nombreCliente} respondió en una conversación tomada${conversacion.intervenido_por ? ` por ${conversacion.intervenido_por}` : ""} — nadie le ha contestado`,
      ruta,
    });
    console.log(`[TeRespondio] ${telefono}: sin destinatario con teléfono, aviso enviado a todo el equipo.`);
  }
}

// El bot de cada producto llama a esta ruta (definida en su variable de
// entorno CRM_WEBHOOK_URL) cada vez que hay novedad en una conversación.
// Aquí NO recibimos el contenido del mensaje — solo el aviso de "hay
// novedad para este teléfono"; el detalle se consulta en vivo contra la
// base de datos del producto cuando el panel lo necesita.
router.post("/webhook/:producto", async (req, res) => {
  try {
    const slug = req.params.producto;
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    const secretoEsperado = process.env[producto.secretoEnvVar];
    const secretoRecibido = req.headers["x-interno-secret"];
    if (!secretoEsperado || secretoRecibido !== secretoEsperado) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { telefono } = req.body;
    if (!telefono) return res.status(400).json({ error: "Falta 'telefono'" });

    const leadCrm = await asegurarLeadCrm(slug, telefono);
    await registrarEvento(slug, telefono, "novedad_conversacion");

    // Avance automático de etapa: el bot ya interactuó con el cliente (existe
    // la conversación con al menos un mensaje) → mínimo "Contacto". Si además
    // ya tiene visita agendada → "Visita agendada". Nunca retrocede una etapa
    // que el comercial ya movió más adelante a mano (ver avanzarEtapaSiCorresponde).
    try {
      const conversacion = await obtenerConversacionProducto(slug, telefono);

      // Aviso "te respondió" — en segundo plano y aislado: si falla, nunca
      // debe frenar el webhook ni el avance de etapa.
      avisarSiClienteRespondioConversacionTomada(producto, telefono, conversacion, leadCrm).catch((errorAviso) =>
        console.error(`[TeRespondio] Error avisando respuesta de ${telefono}:`, errorAviso.message)
      );

      if (!conversacion) {
        console.log(`[Webhook] ${telefono}: no se encontró la conversación en la base del bot todavía.`);
      } else if (conversacion.no_contactar) {
        await establecerEtapaEspecial(slug, telefono, "No contactar");
        console.log(`[Webhook] ${telefono}: marcado como No contactar.`);
      } else if (conversacion.en_remarketing) {
        await establecerEtapaEspecial(slug, telefono, "Remarketing");
        console.log(`[Webhook] ${telefono}: marcado como Remarketing.`);
      } else {
        if ((conversacion.historial || []).length > 0) {
          const avanzoContacto = await avanzarEtapaSiCorresponde(slug, telefono, "Contacto");
          if (avanzoContacto) console.log(`[Webhook] ${telefono}: etapa avanzada a Contacto.`);
        }
        if (conversacion.visita_agendada) {
          const avanzoVisita = await avanzarEtapaSiCorresponde(slug, telefono, "Visita agendada");
          if (avanzoVisita) console.log(`[Webhook] ${telefono}: etapa avanzada a Visita agendada.`);
        }
      }
    } catch (errorEtapa) {
      // Un fallo acá NUNCA debe tumbar el webhook — en el peor caso, el
      // comercial mueve la etapa a mano, que es lo que ya hacía antes.
      console.error(`[Webhook] Error avanzando etapa automática de ${telefono}:`, errorEtapa);
    }

    // Avisa a todos los navegadores conectados a este producto, en vivo.
    const io = req.app.get("io");
    io.to(`producto:${slug}`).emit("novedad", { producto: slug, telefono });

    res.json({ ok: true });
  } catch (error) {
    console.error("Error en webhook de producto:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// El bot llama a esta ruta cuando alguien del equipo (Santiago, Diana o
// Ana) responde por WhatsApp a una alerta de "visita sin asesor asignado"
// citando el mensaje de la alerta (ver manejarRespuestaAAlertaEquipo en el
// bot). Aquí se aplica el cambio real en el CRM: se asigna el asesor
// indicado al lead del cliente en cuestión.
router.post("/webhook/:producto/asignar-asesor", async (req, res) => {
  try {
    const slug = req.params.producto;
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    const secretoEsperado = process.env[producto.secretoEnvVar];
    const secretoRecibido = req.headers["x-interno-secret"];
    if (!secretoEsperado || secretoRecibido !== secretoEsperado) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { telefonoCliente, nombreAsesor } = req.body;
    if (!telefonoCliente || !nombreAsesor) {
      return res.status(400).json({ error: "Faltan 'telefonoCliente' o 'nombreAsesor'" });
    }

    const usuariosActivos = await listarUsuariosActivos();
    // El bot manda el nombre CORTO de su lista de equipo ("Diana", "Ana",
    // "Paola"), pero en el CRM los usuarios pueden tener nombre completo
    // ("Diana Bravo", "Ana Arango") — antes se exigía coincidencia exacta y
    // la asignación por WhatsApp fallaba con 404 para esos casos. Ahora:
    // 1) coincidencia exacta (sin tildes ni mayúsculas); 2) si no hay, por
    // primer nombre, SOLO si un único usuario activo empieza así (si hay dos
    // con el mismo primer nombre, no se adivina — sigue devolviendo 404).
    const normalizarNombre = (texto) =>
      String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
    const nombreBuscado = normalizarNombre(nombreAsesor);
    let usuario = usuariosActivos.find((u) => normalizarNombre(u.nombre) === nombreBuscado);
    if (!usuario) {
      const porPrimerNombre = usuariosActivos.filter(
        (u) => normalizarNombre(u.nombre).split(" ")[0] === nombreBuscado.split(" ")[0]
      );
      if (porPrimerNombre.length === 1) usuario = porPrimerNombre[0];
    }
    if (!usuario) {
      return res.status(404).json({ error: `No se encontró un asesor activo llamado "${nombreAsesor}"` });
    }

    await asignarAsesor(slug, telefonoCliente, usuario.id);
    await registrarEvento(slug, telefonoCliente, "asesor_asignado", {
      por: `WhatsApp (${usuario.nombre})`,
      asesorId: usuario.id,
    });

    const io = req.app.get("io");
    io.to(`producto:${slug}`).emit("novedad", { producto: slug, telefono: telefonoCliente });

    res.json({ ok: true, asesor: { id: usuario.id, nombre: usuario.nombre } });
  } catch (error) {
    console.error("Error asignando asesor vía WhatsApp:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// El bot llama a esta ruta cuando el asesor asignado (o alguien del equipo)
// responde por WhatsApp a la pregunta de "¿cómo te fue con la visita?"
// citando ese mensaje (ver manejarRespuestaResultadoVisita en el bot).
router.post("/webhook/:producto/resultado-visita", async (req, res) => {
  try {
    const slug = req.params.producto;
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    const secretoEsperado = process.env[producto.secretoEnvVar];
    const secretoRecibido = req.headers["x-interno-secret"];
    if (!secretoEsperado || secretoRecibido !== secretoEsperado) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { telefonoCliente, resultado } = req.body;
    const resultadosValidos = ["asistio", "no_asistio", "reagendada"];
    if (!telefonoCliente || !resultadosValidos.includes(resultado)) {
      return res.status(400).json({
        error: "Falta 'telefonoCliente' o 'resultado' inválido (asistio | no_asistio | reagendada)",
      });
    }

    await guardarResultadoVisita(slug, telefonoCliente, resultado);
    await registrarEvento(slug, telefonoCliente, "visita_resultado", {
      por: "WhatsApp (asesor)",
      resultado,
    });

    const io = req.app.get("io");
    io.to(`producto:${slug}`).emit("novedad", { producto: slug, telefono: telefonoCliente });

    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando resultado de visita vía WhatsApp:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
