import { Router } from "express";
import { obtenerProducto } from "../config/productos.js";
import { pool, registrarEvento, asegurarLeadCrm } from "../db/crm.js";
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

    await asegurarLeadCrm(slug, telefono);
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

export default router;
