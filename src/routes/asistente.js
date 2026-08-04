// Sugeridor de "siguiente paso" para un lead puntual. Es una llamada manual
// y bajo demanda a la API de Claude (no automática, no corre sobre todos los
// leads) — el asesor la dispara solo cuando quiere ayuda con un caso
// específico. Usa la misma cuenta/facturación de Anthropic que ya tienes
// configurada, con su propia API key en ANTHROPIC_API_KEY.

import { Router } from "express";
import { obtenerProducto } from "../config/productos.js";
import { obtenerConversacionProducto } from "../db/productoDb.js";
import { asegurarLeadCrm, registrarEvento } from "../db/crm.js";
import { requiereLogin } from "../middleware/auth.js";

const router = Router();
router.use(requiereLogin);

const MODELO = "claude-sonnet-5";

function construirTextoConversacion(historial) {
  return (historial || [])
    .map((m) => `${m.role === "user" ? "CLIENTE" : "ASESORA VIRTUAL (Paola)"}: ${m.content}`)
    .join("\n");
}

router.post("/acciones/sugerir-siguiente-paso", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.body;
    if (!slug || !telefono) return res.status(400).json({ error: "Falta 'producto' o 'telefono'" });

    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor del CRM" });
    }

    const [conversacion, leadCrm] = await Promise.all([
      obtenerConversacionProducto(slug, telefono),
      asegurarLeadCrm(slug, telefono),
    ]);
    if (!conversacion) return res.status(404).json({ error: "Conversación no encontrada" });

    const textoConversacion = construirTextoConversacion(conversacion.historial);
    const notasAsesor = leadCrm?.notas ? `\n\nNOTAS INTERNAS DEL ASESOR SOBRE ESTE LEAD:\n${leadCrm.notas}` : "";

    const systemPrompt =
      "Eres un coach de ventas experto en bienes raíces, ayudando a un asesor humano de un proyecto de lotes campestres (Senderos del Lago, cerca de Popayán, Colombia) a cerrar el agendamiento de una visita al proyecto con un lead específico. " +
      "Te voy a dar la conversación completa que tuvo con la asesora virtual (un bot de WhatsApp llamado Paola) y, si existen, notas internas del asesor humano. " +
      "Responde en español, con un tono directo y práctico, dando 2-3 acciones CONCRETAS que el asesor humano podría tomar ahora mismo para lograr o acelerar el agendamiento de la visita — no reflexiones genéricas de ventas, sino algo específico a lo que este lead en particular dijo o necesita. " +
      "Si el lead ya tiene visita agendada, enfócate en qué hacer para asegurar que sí asista. Sé breve: máximo 4-5 líneas en total.";

    const respuestaClaude = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Conversación completa con el lead (teléfono ${telefono}):\n\n${textoConversacion}${notasAsesor}`,
          },
        ],
      }),
    });

    if (!respuestaClaude.ok) {
      const detalle = await respuestaClaude.text();
      console.error("Error llamando a la API de Claude:", respuestaClaude.status, detalle);
      return res.status(502).json({ error: "No se pudo generar la sugerencia. Intenta de nuevo." });
    }

    const datos = await respuestaClaude.json();
    const sugerencia = datos.content?.find((bloque) => bloque.type === "text")?.text || "";

    await registrarEvento(slug, telefono, "sugerencia_ia_generada", { asesor: req.session.usuario.nombre });

    res.json({ ok: true, sugerencia });
  } catch (error) {
    console.error("Error generando sugerencia:", error);
    res.status(500).json({ error: "Error interno generando la sugerencia" });
  }
});

export default router;
