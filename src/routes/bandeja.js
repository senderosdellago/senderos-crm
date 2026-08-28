import { Router } from "express";
import { productos, obtenerProducto } from "../config/productos.js";
import { listarConversacionesProducto, obtenerConversacionProducto } from "../db/productoDb.js";
import {
  listarEtapas,
  listarLeadsCrm,
  listarUsuariosActivos,
  asegurarLeadCrm,
  listarTareasLead,
  listarTelefonosEliminados,
  listarLeadsEliminados,
} from "../db/crm.js";

// Mismo formato usado en todo el CRM para fechas de visita: "viernes 22
// agosto" — sin año, sin guiones ISO. Copiado de routes/dashboard.js (no
// hay un módulo de utilidades compartido todavía entre rutas).
function formatearFechaCorta(fechaISO) {
  if (!fechaISO) return "";
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12));
  const diaSemana = fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "long" });
  const mesNombre = fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", month: "long" });
  return `${diaSemana} ${dia} ${mesNombre}`;
}

const router = Router();

// Un asesor (rol != admin) solo ve lo que el admin le asignó. Mismo
// principio que en routes/dashboard.js — un admin ve todo.
function filtrarPorAsesor(items, usuario) {
  if (usuario.rol === "admin") return items;
  return items.filter((item) => item.asesor_id === usuario.id);
}

// Combina los datos "reales" del bot (historial, clasificación) con el
// overlay del CRM (etapa, asesor asignado) para una lista de conversaciones.
// Excluye los leads eliminados: listarLeadsCrm ya no los trae en el overlay,
// pero la conversación en sí vive en la base del BOT (otra base de datos
// distinta) y seguiría apareciendo si no se filtra explícitamente aquí.
async function construirListaCombinada(slug, usuario) {
  const [conversaciones, leadsCrm, telefonosEliminados] = await Promise.all([
    listarConversacionesProducto(slug),
    listarLeadsCrm(slug),
    listarTelefonosEliminados(slug),
  ]);

  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  const combinadas = conversaciones
    .filter((c) => !telefonosEliminados.has(c.telefono))
    .map((c) => {
      const overlay = mapaCrm.get(c.telefono);
      return {
        ...c,
        nombre: overlay?.nombre_override || c.nombre,
        etapa_nombre: overlay?.etapa_nombre || null,
        etapa_id: overlay?.etapa_id || null,
        etapa_porcentaje: overlay?.etapa_porcentaje ?? null,
        asesor_id: overlay?.asesor_id || null,
        asesor_nombre: overlay?.asesor_nombre || null,
      };
    });

  return filtrarPorAsesor(combinadas, usuario);
}

router.get("/bandeja", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [conversaciones, etapas] = await Promise.all([
      construirListaCombinada(slug, req.session.usuario),
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
    const conversaciones = await construirListaCombinada(slug, req.session.usuario);
    res.json({ conversaciones });
  } catch (error) {
    console.error("Error en /api/bandeja:", error);
    res.status(500).json({ error: "Error cargando la bandeja" });
  }
});

// Confirma que este usuario tiene permiso de ver esta conversación puntual —
// un asesor NUNCA puede ver la de otro, ni siquiera escribiendo la URL
// directamente. Un admin siempre puede.
function puedeVerLead(usuario, leadCrm) {
  if (usuario.rol === "admin") return true;
  return leadCrm?.asesor_id === usuario.id;
}

router.get("/conversacion/:producto/:telefono", async (req, res) => {
  try {
    const { producto: slug, telefono } = req.params;
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [conversacion, leadCrm, etapas, asesores, tareas] = await Promise.all([
      obtenerConversacionProducto(slug, telefono),
      asegurarLeadCrm(slug, telefono),
      listarEtapas(slug),
      listarUsuariosActivos(),
      listarTareasLead(slug, telefono),
    ]);

    if (!conversacion) return res.status(404).send("Conversación no encontrada");
    if (!puedeVerLead(req.session.usuario, leadCrm)) {
      return res.status(403).send("No tienes acceso a esta conversación — está asignada a otro asesor.");
    }

    res.render("conversacion", {
      productoActual: producto,
      telefono,
      // Nombre correcto: si hay una edición hecha desde el CRM
      // (nombre_override), esa manda — igual que en Bandeja, Embudo y
      // Oportunidades. Antes esta página mostraba el nombre crudo del bot
      // sin importar si alguien ya lo había corregido en el CRM.
      nombreLead: leadCrm?.nombre_override || conversacion.respuestas?.nombre || null,
      visitaFechaCorta: formatearFechaCorta(conversacion.fecha_visita_iso),
      conversacion,
      leadCrm,
      etapas,
      asesores,
      tareas,
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
    const [conversacion, leadCrm] = await Promise.all([
      obtenerConversacionProducto(slug, telefono),
      asegurarLeadCrm(slug, telefono),
    ]);
    if (!conversacion) return res.status(404).json({ error: "No encontrada" });
    if (!puedeVerLead(req.session.usuario, leadCrm)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    res.json({ conversacion });
  } catch (error) {
    console.error("Error en /api/conversacion:", error);
    res.status(500).json({ error: "Error cargando la conversación" });
  }
});

// Ver eliminados ya no es exclusivo de admin — un asesor puede ver los
// leads eliminados que tenía asignados (filtrado, igual que en Bandeja y
// Embudo — nunca ve los de otro asesor). Restaurar/eliminar sí sigue
// siendo solo de admin (ver /acciones/eliminar-lead y /acciones/restaurar-lead
// en acciones.js, y el botón de Restaurar oculto para no-admin en la vista).
router.get("/eliminados", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const leadsEliminadosCrudos = await listarLeadsEliminados(slug);
    const leadsEliminados = filtrarPorAsesor(leadsEliminadosCrudos, req.session.usuario);

    res.render("eliminados", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      leadsEliminados,
    });
  } catch (error) {
    console.error("Error cargando eliminados:", error);
    res.status(500).send("Error cargando la lista de eliminados");
  }
});

export default router;
