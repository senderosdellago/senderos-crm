import { Router } from "express";
import { productos, obtenerProducto } from "../config/productos.js";
import { listarConversacionesProducto, obtenerConversacionProducto } from "../db/productoDb.js";
import { listarEtapas, listarLeadsCrm, asegurarLeadCrm } from "../db/crm.js";

const router = Router();

// Combina los datos "reales" del bot (historial, clasificación) con el
// overlay del CRM (etapa, asesor asignado) para una lista de conversaciones.
async function construirListaCombinada(slug) {
  const [conversaciones, leadsCrm] = await Promise.all([
    listarConversacionesProducto(slug),
    listarLeadsCrm(slug),
  ]);

  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  return conversaciones.map((c) => {
    const overlay = mapaCrm.get(c.telefono);
    return {
      ...c,
      etapa_nombre: overlay?.etapa_nombre || null,
      etapa_id: overlay?.etapa_id || null,
      asesor_nombre: overlay?.asesor_nombre || null,
    };
  });
}

router.get("/bandeja", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [conversaciones, etapas] = await Promise.all([
      construirListaCombinada(slug),
      listarEtapas(slug),
    ]);

    res.render("bandeja", {
      productos,
      productoActual: producto,
      conversaciones,
      etapas,
      usuario: req.session.usuario,
    });
  } catch (error) {
    console.error("Error cargando bandeja:", error);
    res.status(500).send("Error cargando la bandeja de entrada");
  }
});

// Versión JSON (la usa el navegador para refrescar la lista sin recargar la página)
router.get("/api/bandeja", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const conversaciones = await construirListaCombinada(slug);
    res.json({ conversaciones });
  } catch (error) {
    console.error("Error en /api/bandeja:", error);
    res.status(500).json({ error: "Error cargando la bandeja" });
  }
});

router.get("/conversacion/:producto/:telefono", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.params;
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [conversacion, leadCrm, etapas] = await Promise.all([
      obtenerConversacionProducto(slug, telefono),
      asegurarLeadCrm(slug, telefono),
      listarEtapas(slug),
    ]);

    if (!conversacion) return res.status(404).send("Conversación no encontrada");

    res.render("conversacion", {
      productoActual: producto,
      telefono,
      conversacion,
      leadCrm,
      etapas,
      usuario: req.session.usuario,
    });
  } catch (error) {
    console.error("Error cargando conversación:", error);
    res.status(500).send("Error cargando la conversación");
  }
});

// Versión JSON del detalle (para refrescar en vivo sin recargar la página)
router.get("/api/conversacion/:producto/:telefono", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.params;
    const conversacion = await obtenerConversacionProducto(slug, telefono);
    if (!conversacion) return res.status(404).json({ error: "No encontrada" });
    res.json({ conversacion });
  } catch (error) {
    console.error("Error en /api/conversacion:", error);
    res.status(500).json({ error: "Error cargando la conversación" });
  }
});

export default router;
