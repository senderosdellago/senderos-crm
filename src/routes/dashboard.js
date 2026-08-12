import { Router } from "express";
import { productos, obtenerProducto } from "../config/productos.js";
import {
  listarConversacionesParaTriage,
  listarVisitasAgendadas,
  obtenerMetricasConversion,
} from "../db/productoDb.js";
import {
  listarLeadsCrm,
  listarUsuariosActivos,
  listarEtapas,
  listarTareasPendientes,
  obtenerMetaMensual,
} from "../db/crm.js";
import { requiereLogin } from "../middleware/auth.js";

const router = Router();
router.use(requiereLogin);

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

// Metadatos de cada página de lista — título, descripción, y color de acento
// — para que la ruta genérica /dashboard/lista/:tipo sepa cómo renderizarse
// sin repetir 4 rutas casi idénticas.
const TIPOS_LISTA = {
  intervencion: {
    titulo: "Requieren intervención",
    descripcion: "Paola detectó algo que necesita un asesor humano.",
    colorClase: "titulo-urgente",
  },
  calientes: {
    titulo: "Calientes sin visita agendada",
    descripcion: "Clasificados como caliente, sin visita todavía.",
    colorClase: "titulo-caliente",
  },
  enfriandose: {
    titulo: "Se están enfriando",
    descripcion:
      "Leads calientes o tibios que llevan varios días sin escribir y todavía no tienen visita agendada.",
    colorClase: "titulo-enfriandose",
  },
  seguimiento: {
    titulo: "En seguimiento automático",
    descripcion: "Paola sigue estas conversaciones sola por ahora.",
    colorClase: "",
  },
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

// Un asesor (rol != admin) solo ve lo que el admin le asignó. Un admin ve
// todo. Este filtro se aplica ANTES de categorizar, así que se respeta en
// cada página sin tener que repetirlo.
function filtrarPorAsesor(items, usuario) {
  if (usuario.rol === "admin") return items;
  return items.filter((item) => item.asesor_id === usuario.id);
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
// en el overlay del CRM). Cruza con leads_crm para saber el resultado y el
// asesor a cargo.
// Nombre del día de la semana en español a partir de una fecha YYYY-MM-DD,
// calculado en la zona horaria de Colombia para que nunca quede desfasado
// por un día (el riesgo clásico de convertir fechas-string a Date).
function diaDeLaSemana(fechaISO) {
  if (!fechaISO) return "";
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12)); // mediodía UTC evita el borde del día
  return fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "long" });
}

function organizarVisitas(visitas, mapaCrm, usuario) {
  const hoy = hoyISOColombia();

  const conAsesor = visitas.map((v) => {
    const overlay = mapaCrm.get(v.telefono);
    return {
      ...v,
      nombre: overlay?.nombre_override || v.nombre,
      visita_resultado: overlay?.visita_resultado || null,
      asesor_id: overlay?.asesor_id || null,
      asesor_nombre: overlay?.asesor_nombre || null,
      dia_semana: diaDeLaSemana(v.fecha_visita_iso),
    };
  });
  const filtradas = filtrarPorAsesor(conAsesor, usuario);

  const proximas = [];
  const porConfirmar = [];

  for (const v of filtradas) {
    if (v.fecha_visita_iso >= hoy) {
      proximas.push(v);
    } else if (!v.visita_resultado) {
      porConfirmar.push(v);
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

// Trae y arma TODO lo que hace falta para cualquiera de las páginas del
// dashboard, ya filtrado según el rol de `usuario`. Las páginas individuales
// simplemente toman de acá lo que necesitan — así el filtro por asesor se
// aplica en un solo lugar, no en cada ruta por separado.
async function construirDatosDashboard(slug, usuario) {
  const [conversaciones, leadsCrm, visitas, metricasCrudas] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
    listarVisitasAgendadas(slug),
    obtenerMetricasConversion(slug),
  ]);

  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
  const conAsesor = conversaciones.map((c) => ({
    ...c,
    asesor_id: mapaCrm.get(c.telefono)?.asesor_id || null,
    asesor_nombre: mapaCrm.get(c.telefono)?.asesor_nombre || null,
  }));
  const conversacionesFiltradas = filtrarPorAsesor(conAsesor, usuario);

  const { requierenIntervencion, calientesSinAgendar, leadsEnfriandose, enSeguimiento } =
    categorizar(conversacionesFiltradas);
  const { proximas, porConfirmar } = organizarVisitas(visitas, mapaCrm, usuario);
  // Las métricas generales (para el panel de números) siempre son del
  // producto completo, sin filtrar por asesor — es información gerencial.
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
      visitasAgendadas: proximas.length + porConfirmar.length,
    },
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const usuario = req.session.usuario;
    const hoy = hoyISOColombia();

    const [datosTriage, oportunidades, tareasPendientes, conversaciones] = await Promise.all([
      construirDatosDashboard(slug, usuario),
      obtenerOportunidades(slug, usuario),
      listarTareasPendientes(slug),
      listarConversacionesParaTriage(slug),
    ]);
    const mapaNombres = new Map(conversaciones.map((c) => [c.telefono, c.respuestas?.nombre]));

    const misTareasHoy = filtrarPorAsesor(tareasPendientes, usuario)
      .filter((t) => new Date(t.fecha).toLocaleDateString("en-CA", { timeZone: "America/Bogota" }) <= hoy)
      .map((t) => ({ ...t, nombre: mapaNombres.get(t.telefono) || t.telefono }));

    const cierresEsperados = oportunidades.reduce((suma, o) => suma + (o.valor_venta || 0), 0);
    const metaMensual = usuario.rol === "admin" ? null : await obtenerMetaMensual(usuario.id);
    const progresoMeta = metaMensual ? Math.min(100, Math.round((cierresEsperados / metaMensual) * 100)) : null;

    res.render("dashboard", {
      productos,
      productoActual: producto,
      usuario,
      resumen: datosTriage.resumen,
      metricas: datosTriage.metricas,
      misOportunidades: oportunidades.length,
      misOportunidadesLista: oportunidades,
      visitasAgendadas: datosTriage.resumen.visitasAgendadas,
      visitasPreview: datosTriage.visitasProximas.slice(0, 5),
      oportunidadesEnRiesgo: datosTriage.resumen.leadsEnfriandose,
      actividadesHoy: misTareasHoy,
      oportunidadesPreview: oportunidades.slice(0, 5),
      cierresEsperados,
      metaMensual,
      progresoMeta,
    });
  } catch (error) {
    console.error("Error cargando dashboard:", error);
    res.status(500).send("Error cargando el dashboard");
  }
});

// Versión JSON del resumen (la usa el navegador para refrescar los números
// de las tarjetas sin recargar la página completa).
router.get("/api/dashboard", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const datos = await construirDatosDashboard(slug, req.session.usuario);
    res.json({ resumen: datos.resumen, metricas: datos.metricas });
  } catch (error) {
    console.error("Error en /api/dashboard:", error);
    res.status(500).json({ error: "Error cargando el dashboard" });
  }
});

// Página de calendario de visitas — próximas + por confirmar, con cliente,
// fecha, hora y asesor a cargo. Aplica el mismo filtro por rol.
router.get("/dashboard/visitas", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [leadsCrm, visitas] = await Promise.all([
      listarLeadsCrm(slug),
      listarVisitasAgendadas(slug),
    ]);
    const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
    const { proximas, porConfirmar } = organizarVisitas(visitas, mapaCrm, req.session.usuario);

    res.render("dashboard-visitas", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      visitasProximas: proximas,
      visitasPorConfirmar: porConfirmar,
    });
  } catch (error) {
    console.error("Error cargando visitas:", error);
    res.status(500).send("Error cargando las visitas");
  }
});

// Página de lista genérica para las otras 4 categorías — /dashboard/lista/intervencion,
// /dashboard/lista/calientes, /dashboard/lista/enfriandose, /dashboard/lista/seguimiento.
router.get("/dashboard/lista/:tipo", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const meta = TIPOS_LISTA[req.params.tipo];
    if (!meta) return res.status(404).send("Categoría no encontrada");

    const datos = await construirDatosDashboard(slug, req.session.usuario);
    const mapaListas = {
      intervencion: { leads: datos.requierenIntervencion, tipoTarjeta: "intervencion" },
      calientes: { leads: datos.calientesSinAgendar, tipoTarjeta: "caliente" },
      enfriandose: { leads: datos.leadsEnfriandose, tipoTarjeta: "enfriandose" },
      seguimiento: { leads: datos.enSeguimiento, tipoTarjeta: "seguimiento" },
    };
    const { leads, tipoTarjeta } = mapaListas[req.params.tipo];

    res.render("dashboard-lista", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      meta,
      leads,
      tipoTarjeta,
    });
  } catch (error) {
    console.error("Error cargando lista:", error);
    res.status(500).send("Error cargando la lista");
  }
});

// Oportunidades Activas: la vista de pipeline clásica — cliente, etapa con
// su % de probabilidad, última fecha de contacto, y valor de venta (editable
// a mano, porque no hay ninguna fuente automática de ese dato). Excluye
// Remarketing y No contactar — esas ya no son oportunidades "activas".
// Reutilizable: la usan tanto /dashboard (para el resumen y la vista previa)
// como /dashboard/oportunidades (la tabla completa).
async function obtenerOportunidades(slug, usuario) {
  const [conversaciones, leadsCrm] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
  ]);
  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));

  const oportunidades = conversaciones
    .map((c) => {
      const overlay = mapaCrm.get(c.telefono);
      return {
        telefono: c.telefono,
        nombre: overlay?.nombre_override || c.respuestas?.nombre || c.telefono,
        etapa_nombre: overlay?.etapa_nombre || "Lead",
        etapa_id: overlay?.etapa_id || null,
        etapa_porcentaje: overlay?.etapa_porcentaje ?? null,
        ultimo_contacto: c.ultimo_mensaje_cliente_en,
        valor_venta: overlay?.valor_venta ? Number(overlay.valor_venta) : null,
        asesor_id: overlay?.asesor_id || null,
        asesor_nombre: overlay?.asesor_nombre || null,
      };
    })
    .filter((o) => o.etapa_nombre !== "Remarketing" && o.etapa_nombre !== "No contactar");

  const filtradas = filtrarPorAsesor(oportunidades, usuario);
  filtradas.sort((a, b) => new Date(b.ultimo_contacto || 0) - new Date(a.ultimo_contacto || 0));
  return filtradas;
}

router.get("/dashboard/oportunidades", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const oportunidades = await obtenerOportunidades(slug, req.session.usuario);
    const etapas = await listarEtapas(slug);
    const etapasSeleccionables = etapas.filter(
      (e) => e.nombre !== "Remarketing" && e.nombre !== "No contactar"
    );

    // Conteo de cuántas oportunidades hay en cada etapa — para el filtro y
    // el resumen de arriba de la tabla.
    const conteoPorEtapa = {};
    for (const e of etapasSeleccionables) conteoPorEtapa[e.nombre] = 0;
    for (const o of oportunidades) {
      if (conteoPorEtapa[o.etapa_nombre] != null) conteoPorEtapa[o.etapa_nombre]++;
    }

    res.render("dashboard-oportunidades", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      oportunidades,
      etapas: etapasSeleccionables,
      conteoPorEtapa,
    });
  } catch (error) {
    console.error("Error cargando oportunidades:", error);
    res.status(500).send("Error cargando las oportunidades");
  }
});

// Tareas pendientes de todos los leads (filtradas por asesor si no es
// admin), la más vencida primero — literal, porque ya vienen ordenadas por
// fecha ascendente y estas son todas fecha <= hoy o futuras cercanas.
router.get("/dashboard/tareas", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const [tareas, conversaciones] = await Promise.all([
      listarTareasPendientes(slug),
      listarConversacionesParaTriage(slug),
    ]);
    const mapaNombres = new Map(conversaciones.map((c) => [c.telefono, c.respuestas?.nombre]));

    const hoy = hoyISOColombia();
    const conNombre = tareas.map((t) => {
      const fechaTarea = new Date(t.fecha).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
      return {
        ...t,
        nombre: mapaNombres.get(t.telefono) || t.telefono,
        vencida: fechaTarea < hoy,
      };
    });

    const filtradas = filtrarPorAsesor(conNombre, req.session.usuario);
    // Más vencida primero: fecha más antigua arriba (ya vienen ordenadas por
    // fecha ASC desde la consulta, así que no hace falta reordenar).

    res.render("dashboard-tareas", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      tareas: filtradas,
    });
  } catch (error) {
    console.error("Error cargando tareas:", error);
    res.status(500).send("Error cargando las tareas");
  }
});

// SOLO admin — página simple para fijar la meta mensual de cada vendedor.
router.get("/dashboard/equipo", async (req, res) => {
  try {
    if (req.session.usuario.rol !== "admin") return res.status(403).send("Solo un administrador puede ver esto");

    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const usuarios = await listarUsuariosActivos();

    res.render("dashboard-equipo", {
      productos,
      productoActual: producto,
      usuario: req.session.usuario,
      usuarios,
    });
  } catch (error) {
    console.error("Error cargando equipo:", error);
    res.status(500).send("Error cargando el equipo");
  }
});

export default router;
