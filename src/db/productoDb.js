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

export async function listarConversacionesProducto(slug, { limite = 200 } = {}) {
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
export async function listarConversacionesParaTriage(slug, { limite = 300 } = {}) {
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
