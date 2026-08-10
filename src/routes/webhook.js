import { Router } from "express";
import { obtenerProducto } from "../config/productos.js";
import { asegurarLeadCrm, registrarEvento, avanzarEtapaSiCorresponde, establecerEtapaEspecial } from "../db/crm.js";
import { obtenerConversacionProducto } from "../db/productoDb.js";

const router = Router();

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

    await asegurarLeadCrm(slug, telefono);
    await registrarEvento(slug, telefono, "novedad_conversacion");

    // Avance automático de etapa: el bot ya interactuó con el cliente (existe
    // la conversación con al menos un mensaje) → mínimo "Contacto". Si además
    // ya tiene visita agendada → "Visita agendada". Nunca retrocede una etapa
    // que el comercial ya movió más adelante a mano (ver avanzarEtapaSiCorresponde).
    try {
      const conversacion = await obtenerConversacionProducto(slug, telefono);
      if (conversacion) {
        if (conversacion.no_contactar) {
          await establecerEtapaEspecial(slug, telefono, "No contactar");
        } else if (conversacion.en_remarketing) {
          await establecerEtapaEspecial(slug, telefono, "Remarketing");
        } else {
          if ((conversacion.historial || []).length > 0) {
            await avanzarEtapaSiCorresponde(slug, telefono, "Contacto");
          }
          if (conversacion.visita_agendada) {
            await avanzarEtapaSiCorresponde(slug, telefono, "Visita agendada");
          }
        }
      }
    } catch (errorEtapa) {
      // Un fallo acá NUNCA debe tumbar el webhook — en el peor caso, el
      // comercial mueve la etapa a mano, que es lo que ya hacía antes.
      console.error("Error avanzando etapa automática:", errorEtapa);
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

export default router;
