// Conexión de SOLO LECTURA de datos de negocio a la base de datos de cada
// bot/producto. El CRM lee de aquí el historial real de conversaciones;
// nunca lo copia ni lo duplica en su propia base de datos.

import pg from "pg";
import { obtenerProducto } from "../config/productos.js";

const { Pool } = pg;

const pools = new Map();

function obtenerPool(slug) {
  if (pools.has(slug)) return pools.get(slug);

  const producto = obtenerProducto(slug);
  if (!producto) throw new Error(`Producto desconocido: ${slug}`);

  const connectionString = process.env[producto.dbEnvVar];
  if (!connectionString) {
    throw new Error(
      `Falta la variable de entorno ${producto.dbEnvVar} para conectar con la base de datos de ${producto.nombre}`
    );
  }

  const pool = new Pool({ connectionString });
  pools.set(slug, pool);
  return pool;
}

// El límite es solo una salvaguarda contra un problema futuro de tamaño, NO
// un filtro intencional — antes estaba en 200 y, con la base ya en 700+
// conversaciones, empezó a cortar en silencio leads asignados y con visita
// agendada que simplemente no habían escrito hace poco (desaparecían de
// Bandeja aunque tuvieran asesor). Se subió a 5000 el 24-sep-2026 (cubre años
// al ritmo actual); si el negocio llega a decenas de miles de leads, esto
// debería reemplazarse por una consulta paginada/filtrada en vez de traer
// todo y filtrar en el servidor.
export async function listarConversacionesProducto(slug, { limite = 5000 } = {}) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    `SELECT
       telefono,
       respuestas->>'nombre' AS nombre,
       clasificacion,
       quiere_visita,
       tipo_visita,
       visita_agendada,
       fecha_visita_iso,
       hora_visita_pendiente,
       intervencion_humana,
       intervenido_por,
       jsonb_array_length(historial) AS total_mensajes,
       actualizado_en
     FROM conversaciones
     ORDER BY actualizado_en DESC
     LIMIT $1`,
    [limite]
  );
  return resultado.rows;
}

// Para el dashboard de triage: trae todo lo necesario para decidir a quién
// atender primero, sin tener que abrir cada conversación una por una.
// Solo el ÚLTIMO mensaje de cada conversación, sin traer el historial
// completo (que puede ser pesado) — usa indexado directo de Postgres sobre
// el jsonb para quedarse solo con el último elemento del arreglo.
//
// NOTA sobre el límite de listarConversacionesParaTriage (abajo): mismo caso
// que en listarConversacionesProducto, ver el comentario ahí — se subió de
// 300 a 5000 el 24-sep-2026 porque estaba haciendo desaparecer leads
// asignados de Oportunidades/Embudo/Dashboard sin ningún aviso.
export async function listarUltimosMensajes(slug) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    `SELECT
       telefono,
       historial -> -1 ->> 'content' AS ultimo_mensaje,
       historial -> -1 ->> 'role' AS ultimo_rol
     FROM conversaciones
     WHERE jsonb_array_length(historial) > 0`
  );
  return resultado.rows;
}

export async function listarConversacionesParaTriage(slug, { limite = 5000 } = {}) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    `SELECT
       telefono,
       respuestas,
       clasificacion,
       quiere_visita,
       tipo_visita,
       visita_agendada,
       fecha_visita_iso,
       hora_visita_pendiente,
       intervencion_humana,
       intervenido_por,
       gestion_humana_notificada,
       motivo_gestion_humana,
       media_urls_enviadas,
       ultimo_mensaje_cliente_en,
       no_contactar,
       en_remarketing,
       lead_dormido,
       jsonb_array_length(historial) AS total_mensajes,
       actualizado_en
     FROM conversaciones
     WHERE no_contactar = false
     ORDER BY
       (gestion_humana_notificada AND NOT intervencion_humana) DESC,
       actualizado_en DESC
     LIMIT $1`,
    [limite]
  );
  return resultado.rows;
}

export async function obtenerConversacionProducto(slug, telefono) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    "SELECT * FROM conversaciones WHERE telefono = $1",
    [telefono]
  );
  return resultado.rows[0] || null;
}

// Todas las visitas agendadas (pasadas y futuras) con fecha válida. La ruta
// del dashboard las separa en "próximas" y "para confirmar resultado" según
// la fecha, y las cruza con el overlay del CRM (leads_crm) para saber si ya
// se registró qué pasó.
export async function listarVisitasAgendadas(slug) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    `SELECT
       telefono,
       respuestas->>'nombre' AS nombre,
       respuestas->>'telefono_real' AS telefono_real,
       clasificacion,
       tipo_visita,
       fecha_visita_iso,
       hora_visita_pendiente
     FROM conversaciones
     WHERE visita_agendada = true AND fecha_visita_iso IS NOT NULL
     ORDER BY fecha_visita_iso ASC`
  );
  return resultado.rows;
}

// Métricas simples de conversión — pensadas para una vista gerencial liviana,
// no para reemplazar el análisis detallado. Todo en una sola consulta
// agregada para no traer cada fila al servidor del CRM.
export async function obtenerMetricasConversion(slug) {
  const pool = obtenerPool(slug);
  const resultado = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE clasificacion = 'caliente')::int AS calientes,
       COUNT(*) FILTER (WHERE clasificacion = 'tibio')::int AS tibios,
       COUNT(*) FILTER (WHERE quiere_visita = 'si')::int AS quieren_visita,
       COUNT(*) FILTER (WHERE visita_agendada = true)::int AS visitas_agendadas,
       COUNT(*) FILTER (WHERE clasificacion = 'caliente' AND visita_agendada = true)::int AS calientes_agendados
     FROM conversaciones`
  );
  return resultado.rows[0];
}
