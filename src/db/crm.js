// Base de datos PROPIA del CRM: usuarios, etapas, overlay de leads, y eventos.
// Es una base de datos separada de la de cada producto/bot — el CRM nunca
// guarda aquí el historial de conversaciones, eso sigue viviendo en la BD
// de cada bot.

import pg from "pg";
import { productos } from "../config/productos.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

let listo = false;

export async function asegurarEsquema() {
  if (listo) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'asesor',
      activo BOOLEAN NOT NULL DEFAULT true,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS etapas (
      id SERIAL PRIMARY KEY,
      producto TEXT NOT NULL,
      nombre TEXT NOT NULL,
      orden INTEGER NOT NULL,
      UNIQUE(producto, orden)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads_crm (
      id SERIAL PRIMARY KEY,
      producto TEXT NOT NULL,
      telefono TEXT NOT NULL,
      etapa_id INTEGER REFERENCES etapas(id) ON DELETE SET NULL,
      asesor_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      notas TEXT,
      visita_resultado TEXT,
      visita_resultado_en TIMESTAMPTZ,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(producto, telefono)
    );
  `);
  await pool.query(`
    ALTER TABLE leads_crm
      ADD COLUMN IF NOT EXISTS notas TEXT,
      ADD COLUMN IF NOT EXISTS visita_resultado TEXT,
      ADD COLUMN IF NOT EXISTS visita_resultado_en TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos (
      id SERIAL PRIMARY KEY,
      producto TEXT NOT NULL,
      telefono TEXT NOT NULL,
      tipo TEXT NOT NULL,
      detalle JSONB,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_eventos_producto_fecha ON eventos(producto, creado_en DESC);
  `);

  // Tabla de sesiones que usa connect-pg-simple (se crea sola en el primer
  // arranque si no existe; la declaramos explícita para que el primer login
  // no falle por una carrera entre la librería y nuestra propia conexión).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      PRIMARY KEY (sid)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
  `);

  await sembrarEtapasIniciales();

  listo = true;
}

// Si un producto no tiene ninguna etapa registrada todavía, le crea las
// etapas iniciales definidas en config/productos.js. No pisa nada si el
// producto ya tiene etapas (por ejemplo, si el usuario ya las editó).
async function sembrarEtapasIniciales() {
  for (const producto of productos) {
    const existentes = await pool.query(
      "SELECT COUNT(*)::int AS total FROM etapas WHERE producto = $1",
      [producto.slug]
    );
    if (existentes.rows[0].total > 0) continue;

    const etapas = producto.etapasIniciales || [];
    for (let i = 0; i < etapas.length; i++) {
      await pool.query(
        "INSERT INTO etapas (producto, nombre, orden) VALUES ($1, $2, $3) ON CONFLICT (producto, orden) DO NOTHING",
        [producto.slug, etapas[i], i + 1]
      );
    }
  }
}

export async function registrarEvento(producto, telefono, tipo, detalle = null) {
  await asegurarEsquema();
  await pool.query(
    "INSERT INTO eventos (producto, telefono, tipo, detalle) VALUES ($1, $2, $3, $4)",
    [producto, telefono, tipo, detalle ? JSON.stringify(detalle) : null]
  );
}

// Asegura que exista una fila de overlay para este lead (producto+telefono).
// Si no existe, la crea en la primera etapa disponible de ese producto.
export async function asegurarLeadCrm(producto, telefono) {
  await asegurarEsquema();
  const existente = await pool.query(
    "SELECT * FROM leads_crm WHERE producto = $1 AND telefono = $2",
    [producto, telefono]
  );
  if (existente.rows.length > 0) return existente.rows[0];

  const primeraEtapa = await pool.query(
    "SELECT id FROM etapas WHERE producto = $1 ORDER BY orden ASC LIMIT 1",
    [producto]
  );
  const etapaId = primeraEtapa.rows[0]?.id || null;

  const creado = await pool.query(
    `INSERT INTO leads_crm (producto, telefono, etapa_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (producto, telefono) DO UPDATE SET actualizado_en = now()
     RETURNING *`,
    [producto, telefono, etapaId]
  );
  return creado.rows[0];
}

export async function listarEtapas(producto) {
  await asegurarEsquema();
  const resultado = await pool.query(
    "SELECT * FROM etapas WHERE producto = $1 ORDER BY orden ASC",
    [producto]
  );
  return resultado.rows;
}

export async function listarLeadsCrm(producto) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `SELECT lc.*, e.nombre AS etapa_nombre, u.nombre AS asesor_nombre
     FROM leads_crm lc
     LEFT JOIN etapas e ON e.id = lc.etapa_id
     LEFT JOIN usuarios u ON u.id = lc.asesor_id
     WHERE lc.producto = $1`,
    [producto]
  );
  return resultado.rows;
}

export async function guardarNotas(producto, telefono, notas) {
  await asegurarLeadCrm(producto, telefono);
  await pool.query(
    "UPDATE leads_crm SET notas = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3",
    [notas, producto, telefono]
  );
}

// Todos los usuarios activos, para el selector de "asignar a" — incluye
// admins también (Santiago pidió poder asignarse leads a sí mismo).
export async function listarUsuariosActivos() {
  await asegurarEsquema();
  const resultado = await pool.query(
    "SELECT id, nombre, email, rol FROM usuarios WHERE activo = true ORDER BY nombre ASC"
  );
  return resultado.rows;
}

// asesorId puede ser null para "sin asignar" (desasignar).
export async function asignarAsesor(producto, telefono, asesorId) {
  await asegurarLeadCrm(producto, telefono);
  await pool.query(
    "UPDATE leads_crm SET asesor_id = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3",
    [asesorId || null, producto, telefono]
  );
}

// resultado esperado: 'asistio' | 'no_asistio' | 'reagendada'
export async function guardarResultadoVisita(producto, telefono, resultado) {
  await asegurarLeadCrm(producto, telefono);
  await pool.query(
    `UPDATE leads_crm
     SET visita_resultado = $1, visita_resultado_en = now(), actualizado_en = now()
     WHERE producto = $2 AND telefono = $3`,
    [resultado, producto, telefono]
  );
}
