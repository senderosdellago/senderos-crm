import { Router } from "express";
import { obtenerProducto } from "../config/productos.js";
import {
  pool,
  registrarEvento,
  asegurarLeadCrm,
  guardarNotas,
  guardarResultadoVisita,
  asignarAsesor,
  actualizarCampoOportunidad,
  crearTarea,
  completarTarea,
  guardarMetaMensual,
  actualizarAccesoBrujula,
  marcarLeadEliminado,
  restaurarLead,
} from "../db/crm.js";
import { requiereLogin, requiereAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requiereLogin);

async function llamarBot(slug, ruta, cuerpo) {
  const producto = obtenerProducto(slug);
  if (!producto) throw new Error(`Producto desconocido: ${slug}`);

  const botUrl = process.env[producto.botUrlEnvVar];
  const secreto = process.env[producto.secretoEnvVar];
  if (!botUrl || !secreto) {
    throw new Error(
      `Falta configurar ${producto.botUrlEnvVar} o ${producto.secretoEnvVar} para ${producto.nombre}`
    );
  }

  const respuesta = await fetch(`${botUrl}${ruta}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Interno-Secret": secreto,
    },
    body: JSON.stringify(cuerpo),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`El bot respondió ${respuesta.status}: ${detalle}`);
  }
  return respuesta.json();
}

function emitirNovedad(req, slug, telefono) {
  const io = req.app.get("io");
  io.to(`producto:${slug}`).emit("novedad", { producto: slug, telefono });
}

router.post("/acciones/intervenir", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    await llamarBot(slug, "/interno/intervenir", { telefono, asesor: req.session.usuario.nombre });
    await registrarEvento(slug, telefono, "intervencion_tomada", { asesor: req.session.usuario.nombre });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error tomando control:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/devolver", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    await llamarBot(slug, "/interno/devolver", { telefono });
    await registrarEvento(slug, telefono, "intervencion_devuelta", { asesor: req.session.usuario.nombre });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error devolviendo control:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/mensaje", async (req, res) => {
  try {
    const { producto: slug, telefono, mensaje } = req.body;
    if (!slug || !telefono || !mensaje) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono' o 'mensaje'" });
    }

    await llamarBot(slug, "/interno/mensaje-manual", { telefono, mensaje });
    await registrarEvento(slug, telefono, "mensaje_manual", {
      asesor: req.session.usuario.nombre,
      mensaje,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error enviando mensaje manual:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/etapa", async (req, res) => {
  try {
    const { producto: slug, telefono, etapaId } = req.body;
    if (!slug || !telefono || !etapaId) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono' o 'etapaId'" });
    }

    const leadActual = await asegurarLeadCrm(slug, telefono);
    const esAdmin = req.session.usuario.rol === "admin";
    if (!esAdmin && leadActual.asesor_id !== req.session.usuario.id) {
      return res.status(403).json({ error: "No autorizado — este lead no está asignado a ti" });
    }

    await pool.query(
      "UPDATE leads_crm SET etapa_id = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3",
      [etapaId, slug, telefono]
    );
    await registrarEvento(slug, telefono, "cambio_etapa", {
      asesor: req.session.usuario.nombre,
      etapaId,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error cambiando de etapa:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/notas", async (req, res) => {
  try {
    const { producto: slug, telefono, notas } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    await guardarNotas(slug, telefono, notas || null);
    await registrarEvento(slug, telefono, "notas_actualizadas", { asesor: req.session.usuario.nombre });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando notas:", error);
    res.status(500).json({ error: error.message });
  }
});

// resultado esperado: 'asistio' | 'no_asistio' | 'reagendada'
router.post("/acciones/visita-resultado", async (req, res) => {
  try {
    const { producto: slug, telefono, resultado } = req.body;
    const validos = ["asistio", "no_asistio", "reagendada"];
    if (!slug || !telefono || !validos.includes(resultado)) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono', o 'resultado' inválido" });
    }

    await guardarResultadoVisita(slug, telefono, resultado);
    await registrarEvento(slug, telefono, "visita_resultado", {
      asesor: req.session.usuario.nombre,
      resultado,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando resultado de visita:", error);
    res.status(500).json({ error: error.message });
  }
});

// SOLO admin — así un vendedor nunca puede reasignarse leads de otro por su
// cuenta. asesorId puede venir null/vacío para desasignar.
router.post("/acciones/asignar-asesor", requiereAdmin, async (req, res) => {
  try {
    const { producto: slug, telefono, asesorId } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    await asignarAsesor(slug, telefono, asesorId || null);
    await registrarEvento(slug, telefono, "asesor_asignado", {
      por: req.session.usuario.nombre,
      asesorId: asesorId || null,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error asignando asesor:", error);
    res.status(500).json({ error: error.message });
  }
});

// Registra o reagenda una visita manualmente. Cualquier usuario logueado
// puede usarlo (un asesor debe poder reagendar SU propia visita si el
// cliente no pudo asistir) — la restricción de "solo ve sus leads" ya la
// aplica la ruta del dashboard/bandeja antes de que esto sea alcanzable.
router.post("/acciones/reagendar-visita", async (req, res) => {
  try {
    const { producto: slug, telefono, fechaISO, hora, tipoVisita } = req.body;
    if (!slug || !telefono || !fechaISO || !hora) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono', 'fechaISO', o 'hora'" });
    }

    await llamarBot(slug, "/interno/reagendar-visita", { telefono, fechaISO, hora, tipoVisita });
    await registrarEvento(slug, telefono, "visita_reagendada", {
      asesor: req.session.usuario.nombre,
      fechaISO,
      hora,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error reagendando visita:", error);
    res.status(500).json({ error: error.message });
  }
});

// Edita un campo puntual de la oportunidad (valor de venta, nombre). Un
// asesor solo puede editar SUS propios leads — mismo candado que el resto
// del sistema; un admin puede editar cualquiera.
router.post("/acciones/editar-campo", async (req, res) => {
  try {
    const { producto: slug, telefono, campo, valor } = req.body;
    if (!slug || !telefono || !campo) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono', o 'campo'" });
    }

    const leadActual = await asegurarLeadCrm(slug, telefono);
    const esAdmin = req.session.usuario.rol === "admin";
    if (!esAdmin && leadActual.asesor_id !== req.session.usuario.id) {
      return res.status(403).json({ error: "No autorizado — este lead no está asignado a ti" });
    }

    await actualizarCampoOportunidad(slug, telefono, campo, valor);
    await registrarEvento(slug, telefono, "campo_editado", {
      por: req.session.usuario.nombre,
      campo,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error editando campo:", error);
    res.status(500).json({ error: error.message });
  }
});

// SOLO admin puede fijar la meta mensual de un vendedor.
router.post("/acciones/meta-mensual", requiereAdmin, async (req, res) => {
  try {
    const { usuarioId, monto } = req.body;
    if (!usuarioId) return res.status(400).json({ error: "Falta 'usuarioId'" });

    await guardarMetaMensual(usuarioId, monto === "" || monto == null ? null : Number(monto));
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando meta mensual:", error);
    res.status(500).json({ error: error.message });
  }
});

// Crea un lead desde cero (alguien que llegó sin pasar por WhatsApp todavía).
// Si lo crea un asesor, queda asignado automáticamente a él mismo. Si lo
// crea un admin, queda sin asignar — lo reparte manualmente después.
router.post("/acciones/crear-lead-manual", async (req, res) => {
  const { producto: slug, telefono, nombre, uso, presupuesto, tiempo } = req.body;
  if (!slug || !telefono || !nombre) {
    return res.status(400).json({ error: "Falta 'producto', 'telefono', o 'nombre'" });
  }

  try {
    await llamarBot(slug, "/interno/crear-lead-manual", { telefono, nombre, uso, presupuesto, tiempo });
  } catch (errorBot) {
    if (errorBot.message.includes("409")) {
      return res.status(409).json({ error: "Ya existe un lead con ese número de teléfono" });
    }
    console.error("Error creando lead manual (bot):", errorBot);
    return res.status(502).json({ error: "No se pudo crear el lead en el bot. Intenta de nuevo." });
  }

  try {
    const esAdmin = req.session.usuario.rol === "admin";
    await asignarAsesor(slug, telefono, esAdmin ? null : req.session.usuario.id);
    await registrarEvento(slug, telefono, "lead_creado_manual", { por: req.session.usuario.nombre });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error asignando el lead recién creado:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/tareas", async (req, res) => {
  try {
    const { producto: slug, telefono, concepto, fecha } = req.body;
    if (!slug || !telefono || !concepto || !fecha) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono', 'concepto', o 'fecha'" });
    }

    const leadActual = await asegurarLeadCrm(slug, telefono);
    const esAdmin = req.session.usuario.rol === "admin";
    if (!esAdmin && leadActual.asesor_id !== req.session.usuario.id) {
      return res.status(403).json({ error: "No autorizado — este lead no está asignado a ti" });
    }

    const tarea = await crearTarea(slug, telefono, concepto, fecha, req.session.usuario.id);
    await registrarEvento(slug, telefono, "tarea_creada", {
      por: req.session.usuario.nombre,
      concepto,
      fecha,
    });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true, tarea });
  } catch (error) {
    console.error("Error creando tarea:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/tareas/:id/completar", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.body;
    const tareaId = Number(req.params.id);
    if (!slug || !telefono || !tareaId) {
      return res.status(400).json({ error: "Falta 'producto', 'telefono', o el id de la tarea" });
    }

    const leadActual = await asegurarLeadCrm(slug, telefono);
    const esAdmin = req.session.usuario.rol === "admin";
    if (!esAdmin && leadActual.asesor_id !== req.session.usuario.id) {
      return res.status(403).json({ error: "No autorizado — este lead no está asignado a ti" });
    }

    const tarea = await completarTarea(slug, tareaId);
    if (!tarea) return res.status(404).json({ error: "Tarea no encontrada" });

    await registrarEvento(slug, tarea.telefono, "tarea_completada", {
      por: req.session.usuario.nombre,
      concepto: tarea.concepto,
    });
    emitirNovedad(req, slug, tarea.telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error completando tarea:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============ ADMINISTRACIÓN DE ETAPAS (crear / renombrar) ============
// Cualquiera puede ver y usar las etapas; solo un admin puede crearlas o
// renombrarlas, para que el embudo no cambie por accidente.

router.post("/etapas/crear", requiereAdmin, async (req, res) => {
  try {
    const { producto: slug, nombre } = req.body;
    if (!slug || !nombre) return res.status(400).json({ error: "Falta 'producto' o 'nombre'" });

    const siguienteOrden = await pool.query(
      "SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM etapas WHERE producto = $1",
      [slug]
    );
    const orden = siguienteOrden.rows[0].siguiente;

    const creada = await pool.query(
      "INSERT INTO etapas (producto, nombre, orden) VALUES ($1, $2, $3) RETURNING *",
      [slug, nombre, orden]
    );
    res.json({ ok: true, etapa: creada.rows[0] });
  } catch (error) {
    console.error("Error creando etapa:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/etapas/renombrar", requiereAdmin, async (req, res) => {
  try {
    const { etapaId, nombre } = req.body;
    if (!etapaId || !nombre) return res.status(400).json({ error: "Falta 'etapaId' o 'nombre'" });

    const actualizada = await pool.query(
      "UPDATE etapas SET nombre = $1 WHERE id = $2 RETURNING *",
      [nombre, etapaId]
    );
    if (actualizada.rows.length === 0) return res.status(404).json({ error: "Etapa no encontrada" });
    res.json({ ok: true, etapa: actualizada.rows[0] });
  } catch (error) {
    console.error("Error renombrando etapa:", error);
    res.status(500).json({ error: error.message });
  }
});

// SOLO admin — mueve el lead a la sección de Eliminados. No borra nada de
// verdad (ver comentario en db/crm.js:marcarLeadEliminado) — es reversible
// desde la página de Eliminados.
router.post("/acciones/eliminar-lead", requiereAdmin, async (req, res) => {
  try {
    const { producto: slug, telefono, motivo } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });
    if (!motivo || !motivo.trim()) {
      return res.status(400).json({ error: "Debes indicar el motivo de la eliminación" });
    }

    await marcarLeadEliminado(slug, telefono, motivo.trim());
    await registrarEvento(slug, telefono, "lead_eliminado", { por: req.session.usuario.nombre, motivo: motivo.trim() });

    // Cancela también el evento real en Google Calendar, si el lead tenía
    // una visita agendada — antes esto no pasaba, así que la visita seguía
    // apareciendo en el calendario aunque el lead ya se hubiera eliminado.
    // Si falla (ej. el bot está caído, o el evento ya no existía), no se
    // bloquea la eliminación del lead — solo se registra el error.
    llamarBot(slug, "/interno/cancelar-visita", { telefono }).catch((err) =>
      console.error("Error cancelando visita en el calendario al eliminar el lead:", err)
    );

    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error eliminando lead:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/acciones/restaurar-lead", requiereAdmin, async (req, res) => {
  try {
    const { producto: slug, telefono } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    await restaurarLead(slug, telefono);
    await registrarEvento(slug, telefono, "lead_restaurado", { por: req.session.usuario.nombre });
    emitirNovedad(req, slug, telefono);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error restaurando lead:", error);
    res.status(500).json({ error: error.message });
  }
});

// SOLO admin — da o quita acceso a Brújula a un usuario puntual. Es un
// permiso individual, no depende del rol (a diferencia de casi todo lo
// demás en el CRM) — por eso vive aparte de asignar-asesor o meta-mensual.
router.post("/acciones/actualizar-acceso-brujula", requiereAdmin, async (req, res) => {
  try {
    const { usuarioId, tieneAcceso } = req.body;
    if (!usuarioId) return res.status(400).json({ error: "Falta 'usuarioId'" });

    await actualizarAccesoBrujula(usuarioId, !!tieneAcceso);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error actualizando acceso a Brújula:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
