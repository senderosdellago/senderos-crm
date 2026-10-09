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
  obtenerSecuenciaEtapas,
  listarTelefonosEliminados,
  listarSeparacionesDelMes,
} from "../db/crm.js";
import { requiereLogin, requiereAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requiereLogin);

// A partir de cuántos días sin escribir un lead caliente/tibio (sin visita
// agendada todavía) se considera que se está enfriando. Ajustable si con el
// tiempo el número no se siente correcto.
const DIAS_PARA_ENFRIARSE = 3;

// ============ Definiciones comerciales de las tarjetas del dashboard ============
// Etapas que ya son una venta (o más allá). Un lead aquí NO es una
// oportunidad abierta: se cuenta en "Separaciones del mes", no en el pipeline.
const ETAPAS_CIERRE = ["Separación", "Promesa", "Escritura", "Entrega"];
// Etapas que suman a "Cierres esperados", ponderadas por su porcentaje.
// Antes de la visita realizada el valor digitado es especulación pura.
const ETAPAS_PONDERADAS = ["Visita realizada", "Negociación"];
// Etapas donde un silencio largo sí es una oportunidad en riesgo: el cliente
// ya conoció el lote o tiene una visita pendiente de reprogramar.
const ETAPAS_RIESGO = ["Pendiente reprogramar visita", "Visita realizada", "Negociación"];
// Días sin que el cliente escriba para considerar en riesgo una oportunidad
// de ETAPAS_RIESGO. En lotes campestres la decisión toma semanas; 3 días
// (el umbral de "enfriándose") marcaba casi todo como riesgo.
const DIAS_RIESGO_OPORTUNIDAD = 7;
// Cuántas actividades se muestran en "Mis Actividades de Hoy". La capacidad
// real es de ~12 contactos por persona al día; la lista completa sigue en
// /dashboard/tareas.
const MAX_ACTIVIDADES_PREVIEW = 15;

function esOportunidadAbierta(o) {
  return !o.lead_dormido && !ETAPAS_CIERRE.includes(o.etapa_nombre);
}

function esOportunidadEnRiesgo(o) {
  return ETAPAS_RIESGO.includes(o.etapa_nombre) && diasDesde(o.ultimo_contacto) >= DIAS_RIESGO_OPORTUNIDAD;
}

// Prioridad de una etapa para ordenar tareas: más avanzada = más urgente.
// Las etapas de cierre no tienen porcentaje (Promesa, Escritura, Entrega) o
// tienen 100 — se tratan como máxima prioridad (hay plata comprometida).
function prioridadEtapa(nombre, porcentaje) {
  if (ETAPAS_CIERRE.includes(nombre)) return 100;
  return porcentaje ?? 0;
}

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
  remarketing: {
    titulo: "En remarketing",
    descripcion: "Leads marcados para recontactar más adelante — fuera del embudo activo por ahora.",
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
  const enRemarketing = [];

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
    } else if (c.en_remarketing) {
      // Antes los leads en remarketing simplemente no aparecían en NINGUNA
      // de las otras categorías (están excluidos a propósito de todas, ver
      // los "!c.en_remarketing" de arriba y abajo) — no había dónde verlos
      // desde el dashboard. Ahora tienen su propia categoría.
      enRemarketing.push(enriquecida);
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

  return { requierenIntervencion, calientesSinAgendar, leadsEnfriandose, enSeguimiento, enRemarketing };
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

// Formato corto pedido para mostrar fechas de visita: "viernes 22 agosto" —
// sin año, sin guiones ISO. Reemplaza los pares sueltos de "Día" + "Fecha"
// que se mostraban antes como dos columnas separadas.
function formatearFechaCorta(fechaISO) {
  if (!fechaISO) return "";
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12));
  const diaSemana = fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "long" });
  const mesNombre = fecha.toLocaleDateString("es-CO", { timeZone: "America/Bogota", month: "long" });
  return `${diaSemana} ${dia} ${mesNombre}`;
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
      contactadoAdmin: overlay?.contactado_admin || false,
      dia_semana: diaDeLaSemana(v.fecha_visita_iso),
      fechaCorta: formatearFechaCorta(v.fecha_visita_iso),
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
  const [conversacionesCrudas, leadsCrm, visitasCrudas, metricasCrudas, telefonosEliminados] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
    listarVisitasAgendadas(slug),
    obtenerMetricasConversion(slug),
    listarTelefonosEliminados(slug),
  ]);
  // Igual que en Bandeja: listarLeadsCrm ya no trae el overlay de los
  // eliminados, pero la conversación en sí vive en la base del bot (otra
  // base de datos), así que hay que quitarla explícitamente aquí también.
  const conversaciones = conversacionesCrudas.filter((c) => !telefonosEliminados.has(c.telefono));
  const visitas = visitasCrudas.filter((v) => !telefonosEliminados.has(v.telefono));

  const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
  const conAsesor = conversaciones.map((c) => ({
    ...c,
    asesor_id: mapaCrm.get(c.telefono)?.asesor_id || null,
    asesor_nombre: mapaCrm.get(c.telefono)?.asesor_nombre || null,
  }));
  const conversacionesFiltradas = filtrarPorAsesor(conAsesor, usuario);

  const { requierenIntervencion, calientesSinAgendar, leadsEnfriandose, enSeguimiento, enRemarketing } =
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
    enRemarketing,
    visitasProximas: proximas,
    visitasPorConfirmar: porConfirmar,
    metricas,
    resumen: {
      requierenIntervencion: requierenIntervencion.length,
      calientesSinAgendar: calientesSinAgendar.length,
      leadsEnfriandose: leadsEnfriandose.length,
      enSeguimiento: enSeguimiento.length,
      enRemarketing: enRemarketing.length,
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

    const [datosTriage, oportunidades, tareasPendientes, conversaciones, separacionesCrudas, usuariosActivos] =
      await Promise.all([
        construirDatosDashboard(slug, usuario),
        obtenerOportunidades(slug, usuario),
        listarTareasPendientes(slug),
        listarConversacionesParaTriage(slug),
        listarSeparacionesDelMes(slug),
        usuario.rol === "admin" ? listarUsuariosActivos() : Promise.resolve([]),
      ]);
    const mapaNombres = new Map(conversaciones.map((c) => [c.telefono, c.respuestas?.nombre]));

    // (1) Oportunidades abiertas: sin dormidos y sin lo que ya se vendió.
    const oportunidadesAbiertas = oportunidades.filter(esOportunidadAbierta);

    // (2) Cierres esperados: solo Visita realizada y Negociación, cada valor
    // multiplicado por el % de probabilidad de su etapa.
    const ponderables = oportunidadesAbiertas.filter((o) => ETAPAS_PONDERADAS.includes(o.etapa_nombre));
    const cierresEsperados = Math.round(
      ponderables.reduce((suma, o) => suma + (o.valor_venta || 0) * ((o.etapa_porcentaje ?? 0) / 100), 0)
    );
    const ponderablesSinValor = ponderables.filter((o) => !o.valor_venta).length;

    // (3) Separaciones del mes, filtradas por asesor igual que todo lo demás.
    const separacionesMes = filtrarPorAsesor(separacionesCrudas, usuario);
    const valorSeparadoMes = separacionesMes.reduce((suma, s) => suma + (Number(s.valor_venta) || 0), 0);
    const separacionesSinValor = separacionesMes.filter((s) => !s.valor_venta).length;

    // (7) Meta: un asesor ve la suya; el admin ve la suma de las metas del
    // equipo (antes el admin siempre veía "Sin meta configurada").
    const metaMensual =
      usuario.rol === "admin"
        ? usuariosActivos.reduce((suma, u) => suma + (Number(u.meta_mensual) || 0), 0) || null
        : await obtenerMetaMensual(usuario.id);
    const progresoMeta = metaMensual ? Math.min(100, Math.round((valorSeparadoMes / metaMensual) * 100)) : null;

    // (4) En riesgo: oportunidades que ya visitaron, están en negociación o
    // tienen visita por reprogramar, con 7+ días sin que el cliente escriba.
    const oportunidadesEnRiesgo = oportunidadesAbiertas.filter(esOportunidadEnRiesgo).length;

    // (5) Actividades: separar las de hoy de las vencidas, y ordenar por la
    // etapa del lead (lo más cerca de la plata primero).
    const etapaPorTelefono = new Map(oportunidades.map((o) => [o.telefono, o]));
    const misTareas = filtrarPorAsesor(tareasPendientes, usuario)
      .map((t) => {
        const fechaTarea = new Date(t.fecha).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
        const op = etapaPorTelefono.get(t.telefono);
        return {
          ...t,
          nombre: mapaNombres.get(t.telefono) || t.telefono,
          fechaTarea,
          vencida: fechaTarea < hoy,
          etapa_nombre: op?.etapa_nombre || null,
          prioridad: prioridadEtapa(op?.etapa_nombre, op?.etapa_porcentaje),
        };
      })
      .filter((t) => t.fechaTarea <= hoy);
    const tareasHoy = misTareas.filter((t) => !t.vencida).length;
    const tareasVencidas = misTareas.filter((t) => t.vencida).length;
    misTareas.sort((a, b) => b.prioridad - a.prioridad || a.fechaTarea.localeCompare(b.fechaTarea));

    res.render("dashboard", {
      productos,
      productoActual: producto,
      usuario,
      resumen: datosTriage.resumen,
      metricas: datosTriage.metricas,
      misOportunidades: oportunidadesAbiertas.length,
      misOportunidadesLista: oportunidadesAbiertas,
      // (6) Visitas: próximas separadas de las que ya pasaron sin resultado.
      visitasProximas: datosTriage.visitasProximas.length,
      visitasSinResultado: datosTriage.visitasPorConfirmar.length,
      visitasPreview: datosTriage.visitasProximas.slice(0, 5),
      oportunidadesEnRiesgo,
      diasRiesgo: DIAS_RIESGO_OPORTUNIDAD,
      enRemarketing: datosTriage.resumen.enRemarketing,
      actividadesPreview: misTareas.slice(0, MAX_ACTIVIDADES_PREVIEW),
      totalActividades: misTareas.length,
      tareasHoy,
      tareasVencidas,
      oportunidadesPreview: oportunidadesAbiertas.slice(0, 5),
      cierresEsperados,
      ponderablesCount: ponderables.length,
      ponderablesSinValor,
      separacionesMes: separacionesMes.length,
      valorSeparadoMes,
      separacionesSinValor,
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

    const usuario = req.session.usuario;
    const [leadsCrm, visitasCrudas, telefonosEliminados, usuariosActivos] = await Promise.all([
      listarLeadsCrm(slug),
      listarVisitasAgendadas(slug),
      listarTelefonosEliminados(slug),
      usuario.rol === "admin" ? listarUsuariosActivos() : Promise.resolve([]),
    ]);
    const visitas = visitasCrudas.filter((v) => !telefonosEliminados.has(v.telefono));
    const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
    const { proximas, porConfirmar } = organizarVisitas(visitas, mapaCrm, usuario);

    res.render("dashboard-visitas", {
      productos,
      productoActual: producto,
      usuario,
      visitasProximas: proximas,
      visitasPorConfirmar: porConfirmar,
      usuariosActivos,
    });
  } catch (error) {
    console.error("Error cargando visitas:", error);
    res.status(500).send("Error cargando las visitas");
  }
});

// Buscador global del encabezado (nombre o teléfono) — sin importar en qué
// pantalla esté el lead. Si hay un solo resultado, va directo a su
// conversación; si hay varios, muestra una lista corta para elegir. Mismo
// filtro por rol que el resto del CRM: un asesor solo encuentra lo suyo.
router.get("/buscar", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const q = (req.query.q || "").trim();
    if (!q) return res.redirect(`/dashboard?producto=${slug}`);

    const usuario = req.session.usuario;
    const [conversaciones, leadsCrm, telefonosEliminados] = await Promise.all([
      listarConversacionesParaTriage(slug, { incluirNoContactar: true }),
      listarLeadsCrm(slug),
      listarTelefonosEliminados(slug),
    ]);

    const mapaCrm = new Map(leadsCrm.map((l) => [l.telefono, l]));
    // Quita tildes y mayúsculas para comparar: "fabian" encuentra "Fabián".
    const normalizar = (texto) =>
      String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    // Cada palabra buscada debe aparecer en el nombre, en cualquier orden:
    // "samboni fabian" encuentra "Fabián Samboní".
    const palabras = normalizar(q).split(/\s+/).filter(Boolean);
    const soloDigitos = q.replace(/\D/g, "");

    const candidatos = conversaciones
      .filter((c) => !telefonosEliminados.has(c.telefono))
      .map((c) => {
        const overlay = mapaCrm.get(c.telefono);
        // OJO: listarConversacionesParaTriage no trae una columna "nombre" —
        // el nombre que capturó el bot vive en respuestas.nombre (antes se
        // leía c.nombre, que siempre venía vacío, y por eso buscar por
        // nombre solo encontraba a los leads con nombre editado en el CRM).
        const nombreBot = c.respuestas?.nombre || "";
        return {
          telefono: c.telefono,
          telefonoReal: c.respuestas?.telefono_real || "",
          nombre: overlay?.nombre_override || nombreBot || c.telefono,
          nombreBot,
          etapa_nombre: overlay?.etapa_nombre || null,
          asesor_id: overlay?.asesor_id || null,
          asesor_nombre: overlay?.asesor_nombre || null,
        };
      });

    const visibles = filtrarPorAsesor(candidatos, usuario);
    // Coincide por nombre (el editado en el CRM o el que capturó el bot) o
    // por teléfono (el de WhatsApp o el que el cliente dio aparte) — el
    // teléfono solo si el texto tiene al menos 4 dígitos, para que "5" no
    // encuentre medio directorio telefónico.
    const resultados = visibles.filter((c) => {
      const textoNombres = normalizar(`${c.nombre} ${c.nombreBot}`);
      const coincideNombre = palabras.length > 0 && palabras.every((p) => textoNombres.includes(p));
      const telefonos = `${c.telefono} ${String(c.telefonoReal).replace(/\D/g, "")}`;
      const coincideTelefono = soloDigitos.length >= 4 && telefonos.includes(soloDigitos);
      return coincideNombre || coincideTelefono;
    });

    if (resultados.length === 1) {
      return res.redirect(`/conversacion/${slug}/${resultados[0].telefono}`);
    }

    res.render("buscar-resultados", {
      productos,
      productoActual: producto,
      usuario,
      query: q,
      resultados,
    });
  } catch (error) {
    console.error("Error en /buscar:", error);
    res.status(500).send("Error buscando");
  }
});

// Página de lista genérica para las otras 5 categorías — /dashboard/lista/intervencion,
// /dashboard/lista/calientes, /dashboard/lista/enfriandose, /dashboard/lista/seguimiento,
// /dashboard/lista/remarketing.
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
      remarketing: { leads: datos.enRemarketing, tipoTarjeta: "remarketing" },
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
  const [conversacionesCrudas, leadsCrm, telefonosEliminados] = await Promise.all([
    listarConversacionesParaTriage(slug),
    listarLeadsCrm(slug),
    listarTelefonosEliminados(slug),
  ]);
  const conversaciones = conversacionesCrudas.filter((c) => !telefonosEliminados.has(c.telefono));
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
        lead_dormido: Boolean(c.lead_dormido),
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

    const usuario = req.session.usuario;
    let [oportunidades, etapas, usuariosActivos] = await Promise.all([
      obtenerOportunidades(slug, usuario),
      listarEtapas(slug),
      usuario.rol === "admin" ? listarUsuariosActivos() : Promise.resolve([]),
    ]);

    // Filtro por persona: SOLO un admin puede elegir ver a alguien más — un
    // asesor ya está limitado a lo suyo desde obtenerOportunidades. Mismo
    // patrón y mismo query param "asesor" que /dashboard/embudo, para que la
    // vista de tabla y la de Kanban se comporten igual.
    const asesorFiltro = req.query.asesor || "todos";
    if (usuario.rol === "admin" && asesorFiltro !== "todos") {
      oportunidades = oportunidades.filter((o) => String(o.asesor_id) === asesorFiltro);
    }

    // ?riesgo=1 — la lista que abre la tarjeta "Oportunidades en Riesgo" del
    // dashboard. Misma definición que la tarjeta (esOportunidadEnRiesgo).
    const soloRiesgo = req.query.riesgo === "1";
    if (soloRiesgo) {
      oportunidades = oportunidades.filter((o) => esOportunidadAbierta(o) && esOportunidadEnRiesgo(o));
    }

    const etapasSeleccionables = etapas.filter(
      (e) => e.nombre !== "Remarketing" && e.nombre !== "No contactar"
    );

    // Conteo de cuántas oportunidades hay en cada etapa — para el filtro y
    // el resumen de arriba de la tabla. Se calcula DESPUÉS del filtro por
    // asesor, así que refleja solo lo que se está mostrando.
    const conteoPorEtapa = {};
    for (const e of etapasSeleccionables) conteoPorEtapa[e.nombre] = 0;
    for (const o of oportunidades) {
      if (conteoPorEtapa[o.etapa_nombre] != null) conteoPorEtapa[o.etapa_nombre]++;
    }

    res.render("dashboard-oportunidades", {
      productos,
      productoActual: producto,
      usuario,
      oportunidades,
      etapas: etapasSeleccionables,
      conteoPorEtapa,
      usuariosActivos,
      asesorFiltro,
      soloRiesgo,
      diasRiesgo: DIAS_RIESGO_OPORTUNIDAD,
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

// Embudo de ventas — tablero estilo Kanban, una columna por etapa, con
// arrastrar y soltar para mover un lead de etapa (reutiliza el mismo
// endpoint /acciones/etapa que ya usa el selector de Oportunidades).
router.get("/dashboard/embudo", async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const usuario = req.session.usuario;
    let [oportunidades, etapas, usuariosActivos] = await Promise.all([
      obtenerOportunidades(slug, usuario),
      listarEtapas(slug),
      usuario.rol === "admin" ? listarUsuariosActivos() : Promise.resolve([]),
    ]);

    // Filtro por persona: SOLO un admin puede elegir ver a alguien más — un
    // asesor ya está limitado a lo suyo desde obtenerOportunidades, así que
    // este filtro adicional no aplica para él.
    const asesorFiltro = req.query.asesor || "todos";
    if (usuario.rol === "admin" && asesorFiltro !== "todos") {
      oportunidades = oportunidades.filter((o) => String(o.asesor_id) === asesorFiltro);
    }

    const etapasSeleccionables = etapas.filter(
      (e) => e.nombre !== "Remarketing" && e.nombre !== "No contactar"
    );
    const totalLeads = oportunidades.length;

    // Agrupa las oportunidades por etapa. El porcentaje aquí es DINÁMICO
    // (leads en esta etapa ÷ total de leads del filtro actual) — distinto
    // del porcentaje fijo de "probabilidad de cierre" que se usa en
    // Oportunidades Activas y en Cierres Esperados.
    const columnas = etapasSeleccionables.map((etapa) => {
      const leads = oportunidades
        .filter((o) => o.etapa_nombre === etapa.nombre)
        .map((o) => ({ ...o, tiempoTexto: tiempoRelativo(o.ultimo_contacto) }));
      const totalValor = leads.reduce((suma, l) => suma + (l.valor_venta || 0), 0);
      const porcentajeDelTotal = totalLeads > 0 ? Math.round((leads.length / totalLeads) * 100) : 0;
      return { ...etapa, leads, totalValor, porcentajeDelTotal };
    });

    res.render("dashboard-embudo", {
      productos,
      productoActual: producto,
      usuario,
      columnas,
      etapas: etapasSeleccionables,
      usuariosActivos,
      asesorFiltro,
    });
  } catch (error) {
    console.error("Error cargando embudo:", error);
    res.status(500).send("Error cargando el embudo de ventas");
  }
});

// ============ MÓDULO DE VELOCIDAD DEL EMBUDO ============
// Analiza, para cada lead, cuánto tiempo pasó en cada etapa y si ya avanzó
// o sigue ahí. Con eso arma tres cosas: tiempo promedio por etapa (solo
// contando leads que sí avanzaron), conversión etapa-a-etapa, y la lista de
// leads estancados (más tiempo del promedio en su etapa actual).
// No incluye Remarketing ni No contactar — no son parte del embudo lineal.
function calcularMetricasVelocidad(filas, etapasOrdenadas, mapaNombresAsesor = new Map()) {
  const etapasFunnel = etapasOrdenadas.filter(
    (e) => e.nombre !== "Remarketing" && e.nombre !== "No contactar"
  );
  const ordenPorId = new Map(etapasFunnel.map((e) => [e.id, e.orden]));
  const nombrePorId = new Map(etapasFunnel.map((e) => [e.id, e.nombre]));

  // --- Tiempo promedio por etapa (solo transiciones completas) ---
  const sumaPorEtapa = new Map(); // etapa_id -> { suma, cuenta }
  for (const f of filas) {
    if (!f.completo || !ordenPorId.has(f.etapa_id)) continue;
    const actual = sumaPorEtapa.get(f.etapa_id) || { suma: 0, cuenta: 0 };
    actual.suma += Number(f.dias);
    actual.cuenta += 1;
    sumaPorEtapa.set(f.etapa_id, actual);
  }
  const tiempoPromedioPorEtapa = etapasFunnel.map((e) => {
    const datos = sumaPorEtapa.get(e.id);
    return {
      etapaId: e.id,
      nombre: e.nombre,
      orden: e.orden,
      promedioDias: datos ? Math.round((datos.suma / datos.cuenta) * 10) / 10 : null,
      muestras: datos?.cuenta || 0,
    };
  });
  const promedioPorEtapaId = new Map(tiempoPromedioPorEtapa.map((t) => [t.etapaId, t.promedioDias]));

  // --- Conversión etapa-a-etapa: máximo orden alcanzado por cada lead ---
  const maxOrdenPorTelefono = new Map();
  for (const f of filas) {
    const orden = ordenPorId.get(f.etapa_id);
    if (orden == null) continue;
    const actual = maxOrdenPorTelefono.get(f.telefono) || 0;
    if (orden > actual) maxOrdenPorTelefono.set(f.telefono, orden);
  }
  const alcanzaronOrden = etapasFunnel.map((e) => {
    let cuenta = 0;
    for (const maxOrden of maxOrdenPorTelefono.values()) {
      if (maxOrden >= e.orden) cuenta++;
    }
    return cuenta;
  });
  const conversionEtapaAEtapa = etapasFunnel.slice(0, -1).map((e, i) => {
    const desde = alcanzaronOrden[i];
    const hasta = alcanzaronOrden[i + 1];
    return {
      desde: e.nombre,
      hasta: etapasFunnel[i + 1].nombre,
      totalDesde: desde,
      totalHasta: hasta,
      porcentaje: desde > 0 ? Math.round((hasta / desde) * 100) : null,
    };
  });

  // --- Leads estancados: su fila actual (sin siguiente) comparada con el promedio ---
  const leadsEstancados = filas
    .filter((f) => !f.completo && ordenPorId.has(f.etapa_id))
    .map((f) => {
      const promedio = promedioPorEtapaId.get(f.etapa_id);
      return {
        telefono: f.telefono,
        asesorId: f.asesor_id,
        asesorNombre: mapaNombresAsesor.get(f.asesor_id) || null,
        etapaNombre: nombrePorId.get(f.etapa_id),
        dias: Math.round(Number(f.dias) * 10) / 10,
        promedio,
        diasDeMas: promedio != null ? Math.round((Number(f.dias) - promedio) * 10) / 10 : null,
      };
    })
    .filter((l) => l.promedio != null && l.diasDeMas > 0)
    .sort((a, b) => b.diasDeMas - a.diasDeMas);

  return { tiempoPromedioPorEtapa, conversionEtapaAEtapa, leadsEstancados };
}

// Análisis de asistencia según cuántos días de anticipación hubo entre el
// momento en que se agendó la visita (primera vez que el lead entró a la
// etapa "Visita agendada" — no hay un campo dedicado a "fecha de
// agendamiento", así que se usa esto como proxy) y la fecha real de la
// visita. Objetivo: validar con datos reales la hipótesis de que agendar
// con mucha anticipación baja la tasa de asistencia (la "brecha
// caliente-fría" — la emoción del momento en que escribió se enfría con
// los días). Cruza el historial de etapas y el resultado de la visita
// (ambos en la base del CRM) con la fecha de la visita en sí, que vive en
// la base del bot (solo lectura).
const BUCKETS_HORIZONTE = [
  { clave: "0-1", etiqueta: "0-1 días (mismo día / al otro día)" },
  { clave: "2-3", etiqueta: "2-3 días" },
  { clave: "4-7", etiqueta: "4-7 días (hasta una semana)" },
  { clave: "8+", etiqueta: "8+ días (más de una semana)" },
];

function bucketParaHorizonte(dias) {
  if (dias <= 1) return "0-1";
  if (dias <= 3) return "2-3";
  if (dias <= 7) return "4-7";
  return "8+";
}

function calcularAsistenciaPorHorizonte(filas, etapas, visitasAgendadas, leadsCrm) {
  const etapaVisita = etapas.find((e) => e.nombre === "Visita agendada");

  // Primera vez que cada teléfono entró a "Visita agendada" — proxy del
  // momento real en que se agendó (ver comentario de arriba).
  const mapaAgendadaEn = new Map();
  if (etapaVisita) {
    for (const fila of filas) {
      if (fila.etapa_id !== etapaVisita.id) continue;
      const actual = mapaAgendadaEn.get(fila.telefono);
      const entroEn = new Date(fila.entro_en);
      if (!actual || entroEn < actual) mapaAgendadaEn.set(fila.telefono, entroEn);
    }
  }

  const mapaResultado = new Map(leadsCrm.map((l) => [l.telefono, l.visita_resultado]));

  const acumulado = new Map(
    BUCKETS_HORIZONTE.map((b) => [
      b.clave,
      { etiqueta: b.etiqueta, total: 0, asistio: 0, noAsistio: 0, reagendada: 0, sinRegistrar: 0 },
    ])
  );
  let sinDatoDeAgendamiento = 0;

  for (const visita of visitasAgendadas) {
    if (!visita.fecha_visita_iso) continue;
    const agendadaEn = mapaAgendadaEn.get(visita.telefono);
    if (!agendadaEn) {
      sinDatoDeAgendamiento++;
      continue;
    }

    // Mismo truco de en-CA que en resumenVendedores.js: convierte el
    // timestamp real a la fecha calendario en Bogotá, para comparar días
    // contra fecha_visita_iso sin errores de huso horario.
    const fechaAgendadaISO = agendadaEn.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    const dias = Math.round(
      (new Date(`${visita.fecha_visita_iso}T00:00:00Z`) - new Date(`${fechaAgendadaISO}T00:00:00Z`)) / 86400000
    );
    const grupo = acumulado.get(bucketParaHorizonte(Math.max(dias, 0)));
    grupo.total++;

    const resultado = mapaResultado.get(visita.telefono);
    if (resultado === "asistio") grupo.asistio++;
    else if (resultado === "no_asistio") grupo.noAsistio++;
    else if (resultado === "reagendada") grupo.reagendada++;
    else grupo.sinRegistrar++;
  }

  const filasResumen = BUCKETS_HORIZONTE.map((b) => {
    const g = acumulado.get(b.clave);
    const conResultado = g.asistio + g.noAsistio;
    return {
      ...g,
      tasaAsistencia: conResultado > 0 ? Math.round((g.asistio / conResultado) * 100) : null,
    };
  });

  return { filasResumen, sinDatoDeAgendamiento };
}

// Vista gerencial (admin) / individual (asesor) de la velocidad del embudo:
// conversión etapa-a-etapa, tiempo promedio por etapa, y lista de leads
// estancados. Un asesor solo ve SUS leads (mismo candado que el resto del
// sistema); un admin ve el panorama completo.
// SOLO admin — antes cualquier asesor podía entrar y ver su propio embudo
// filtrado, pero se decidió que este panel quede exclusivo del
// administrador (igual que Equipo).
router.get("/dashboard/velocidad", requiereAdmin, async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const usuario = req.session.usuario;
    const [filas, etapas, usuariosActivos] = await Promise.all([
      obtenerSecuenciaEtapas(slug),
      listarEtapas(slug),
      listarUsuariosActivos(),
    ]);

    const mapaNombresAsesor = new Map(usuariosActivos.map((u) => [u.id, u.nombre]));

    const { tiempoPromedioPorEtapa, conversionEtapaAEtapa, leadsEstancados } = calcularMetricasVelocidad(
      filas,
      etapas,
      mapaNombresAsesor
    );

    res.render("dashboard-velocidad", {
      productos,
      productoActual: producto,
      usuario,
      tiempoPromedioPorEtapa,
      conversionEtapaAEtapa,
      leadsEstancados,
    });
  } catch (error) {
    console.error("Error cargando velocidad del embudo:", error);
    res.status(500).send("Error cargando el módulo de velocidad");
  }
});

// SOLO admin. Reporte puntual para validar con datos reales si agendar con
// más anticipación baja la tasa de asistencia. Sin link en el menú a
// propósito — es un análisis de una sola vez, no una pantalla de uso
// diario; se entra directo por la URL.
router.get("/dashboard/asistencia-horizonte", requiereAdmin, async (req, res) => {
  try {
    const slug = req.query.producto || "senderos";
    const producto = obtenerProducto(slug);
    if (!producto) return res.status(404).send("Producto no encontrado");

    const usuario = req.session.usuario;
    const [filas, etapas, visitasAgendadas, leadsCrm] = await Promise.all([
      obtenerSecuenciaEtapas(slug),
      listarEtapas(slug),
      listarVisitasAgendadas(slug),
      listarLeadsCrm(slug),
    ]);

    const { filasResumen, sinDatoDeAgendamiento } = calcularAsistenciaPorHorizonte(
      filas,
      etapas,
      visitasAgendadas,
      leadsCrm
    );

    res.render("dashboard-asistencia-horizonte", {
      productos,
      productoActual: producto,
      usuario,
      filasResumen,
      sinDatoDeAgendamiento,
    });
  } catch (error) {
    console.error("Error calculando asistencia por horizonte:", error);
    res.status(500).send("Error calculando el análisis de asistencia");
  }
});

export default router;
