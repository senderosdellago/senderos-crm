import { Router } from "express";
import { productos, obtenerProducto } from "../config/productos.js";
import {
  listarConversacionesParaTriage,
  listarVisitasAgendadas,
  obtenerMetricasConversion,
} from "../db/productoDb.js";
import { listarLeadsCrm } from "../db/crm.js";

const router = Router();

// A partir de cuántos días sin escribir un lead caliente/tibio (sin visita
// agendada todavía) se considera que se está enfriando. Ajustable si con el
// tiempo el número no se siente correcto.
const DIAS_PARA_ENFRIARSE = 3;

// Nombres legibles de cada tema de multimedia, para mostrar qué le
// interesó al cliente sin exponerle al vendedor el nombre técnico del
// archivo. Si se agrega un tema nuevo en el bot (ej. "tipologias"), solo
// hay que agregarlo aquí para que el dashboard lo muestre bien.
const ETIQUETAS_TEMA = {
  lago: "el lago",
  cascadas: "las cascadas",
  bosque: "el bosque",
  montana: "la cordillera",
  tipologias: "tipologías",
};

function temasDeInteres(mediaUrlsEnviadas) {
  if (!Array.isArray(mediaUrlsEnviadas)) return [];
  const temas = new Set();
  for (const url of mediaUrlsEnviadas) {
    for (const clave of Object.keys(ETIQUETAS_TEMA)) {
      if (url.toLowerCase().includes(clave)) temas.add(clave);
    }
  }
  return [...temas].map((clave) => ETIQUETAS_TEMA[clave]);
}

function tiempoRelativo(fecha) {
  if (!fecha) return "sin actividad registrada";
  const minutos = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
  if (minutos < 1) return "hace un momento";
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  return `hace ${dias} día${dias === 1 ? "" : "s"}`;
}

function diasDesde(fecha) {
  if (!fecha) return Infinity; // sin actividad registrada = tratarlo como muy viejo
  return (Date.now() - new Date(fecha).getTime()) / (1000 * 60 * 60 * 24);
}

// Fecha de hoy en formato YYYY-MM-DD, en la zona horaria de Colombia — para
// comparar contra fecha_visita_iso (que se guarda como texto, no como TIMESTAMPTZ)
// sin errores de husos horarios.
function hoyISOColombia() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" }); // en-CA da YYYY-MM-DD
}

// Clasifica cada conversación en una de cuatro categorías de prioridad para
// el vendedor. No cambia nada en la base de datos — es solo una forma de
// ordenar lo que ya existe.
function categorizar(conversaciones) {
  const requierenIntervencion = [];
  const calientesSinAgendar = [];
  const leadsEnfriandose = [];
  const enSeguimiento = [];

  for (const c of conversaciones) {
    const enriquecida = {
      ...c,
      temasInteres: temasDeInteres(c.media_urls_enviadas),
      tiempoTexto: tiempoRelativo(c.ultimo_mensaje_cliente_en),
    };

    const esCalidoActivo =
      (c.clasificacion === "caliente" || c.clasificacion === "tibio") &&
      !c.visita_agendada &&
      !c.lead_dormido &&
      !c.en_remarketing;

    if (c.gestion_humana_notificada && !c.intervencion_humana) {
      requierenIntervencion.push(enriquecida);
    } else if (
      c.clasificacion === "caliente" &&
      !c.visita_agendada &&
      !c.intervencion_humana &&
      !c.lead_dormido
    ) {
      calientesSinAgendar.push(enriquecida);
    } else if (esCalidoActivo && diasDesde(c.ultimo_mensaje_cliente_en) >= DIAS_PARA_ENFRIARSE) {
      leadsEnfriandose.push(enriquecida);
    } else if (!c.lead_dormido && !c.en_remarketing) {
      enSeguimiento.push(enriquecida);
    }
  }

  return { requierenIntervencion, calientesSinAgendar, leadsEnfriandose, enSeguimiento };
}

// Separa las visitas agendadas en "próximas" (hoy en adelante) y "para
// confirmar resultado" (la fecha ya pasó y todavía no se registró qué pasó
// en el overlay del CRM). Cruza con leads_crm para saber el resultado.
function organizarVisitas(visitas, leadsCrm) {
  const hoy = hoyISOColombia();
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  const proximas = [];
  const porConfirmar = [];

  for (const v of visitas) {
    const overlay = mapaCrm.get(v.telefono);
    const enriquecida = { ...v, visita_resultado: overlay?.visita_resultado || null };

    if (v.fecha_visita_iso >= hoy) {
      proximas.push(enriquecida);
    } else if (!overlay?.visita_resultado) {
      porConfirmar.push(enriquecida);
    }
  }

  proximas.sort((a, b) => a.fecha_visita_iso.localeCompare(b.fecha_visita_iso));
  porConfirmar.sort((a, b) => b.fecha_visita_iso.localeCompare(a.fecha_visita_iso));

  return { proximas, porConfirmar };
}

function calcularMetricas(m) {
  const pct = (parte, total) => (total > 0 ? Math.round((parte / total) * 100) : 0);
  return {
    total: m.total,
    calientes: m.calientes,
    pctCalientes: pct(m.calientes, m.total),
    pctQuierenVisita: pct(m.quieren_visita, m.total),
    visitasAgendadas: m.visitas_agendadas,
    pctCalientesQueAgendan: pct(m.calientes_agendados, m.calientes),
  };
}

async function construirDatosDashboard(slug) {
  const [conversaciones, leadsCrm, visitas, metricasCrudas] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
    listarVisitasAgendadas(slug),
    obtenerMetricasConversion(slug),
  ]);

  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
  const conAsesor = conversaciones.map((c) => ({
    ...c,
    asesor_nombre: mapaCrm.get(c.telefono)?.asesor_nombre || null,
  }));

  const { requierenIntervencion, calientesSinAgendar, leadsEnfriandose, enSeguimiento } =
    categorizar(conAsesor);
  const { proximas, porConfirmar } = organizarVisitas(visitas, leadsCrm);
  const metricas = calcularMetricas(metricasCrudas);

  return {
    requierenIntervencion,
    calientesSinAgendar,
    leadsEnfriandose,
    enSeguimiento,
    visitasProximas: proximas,
    visitasPorConfirmar: porConfirmar,
    metricas,
    resumen: {
      requierenIntervencion: requierenIntervencion.length,
      calientesSinAgendar: calientesSinAgendar.length,
      leadsEnfriandose: leadsEnfriandose.length,
      enSeguimiento: enSeguimiento.length,
      visitasAgendadas: metricas.visitasAgendadas,
    },
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const datos = await construirDatosDashboard(slug);

    res.render("dashboard", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      ...datos,
    });
  } catch (error) {
    console.error("Error cargando dashboard:", error);
    res.status(500).send("Error cargando el dashboard");
  }
});

// Versión JSON (la usa el navegador para refrescar sin recargar la página)
router.get("/api/dashboard", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const datos = await construirDatosDashboard(slug);
    res.json(datos);
  } catch (error) {
    console.error("Error en /api/dashboard:", error);
    res.status(500).json({ error: "Error cargando el dashboard" });
  }
});

export default router;
