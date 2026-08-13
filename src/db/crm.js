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
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS meta_mensual NUMERIC;
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
    ALTER TABLE etapas ADD COLUMN IF NOT EXISTS porcentaje INTEGER;
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
      ADD COLUMN IF NOT EXISTS visita_resultado_en TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS valor_venta NUMERIC,
      ADD COLUMN IF NOT EXISTS nombre_override TEXT;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      producto TEXT NOT NULL,
      telefono TEXT NOT NULL,
      concepto TEXT NOT NULL,
      fecha DATE NOT NULL,
      completada BOOLEAN NOT NULL DEFAULT false,
      completada_en TIMESTAMPTZ,
      creado_por_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tareas_pendientes ON tareas (producto, completada, fecha);`);

  await sembrarEtapasIniciales();
  await migrarEtapasV2();

  listo = true;
}

// Migración puntual: la primera versión del pipeline no tenía "Negociación"
// ni porcentajes, y "Visita realizada" se llamaba "Visitado". Esta función
// ajusta eso EN LOS REGISTROS QUE YA EXISTEN, sin borrar ni recrear filas —
// así los leads que ya tenían una etapa asignada (leads_crm.etapa_id) no
// pierden esa asignación. Es idempotente: si ya se corrió una vez (ya existe
// "Negociación"), no hace nada la próxima vez que arranque el servidor.
async function migrarEtapasV2() {
  const nombresObjetivo = MAPA_ETAPAS_ESTANDAR;

  for (const producto of productos) {
    const filas = await pool.query("SELECT id, nombre, orden FROM etapas WHERE producto = $1", [
      producto.slug,
    ]);
    if (filas.rows.length === 0) continue; // producto sin etapas todavía, sembrarEtapasIniciales ya lo maneja

    const yaMigrado = filas.rows.some((f) => f.nombre === "Negociación");
    if (yaMigrado) continue;

    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");

      // Paso 1: mover las etapas de orden 5 en adelante a un rango temporal
      // alto, para no chocar con el UNIQUE(producto, orden) mientras se
      // reordena (Negociación necesita el puesto 5, que hoy ocupa Separación).
      await cliente.query(
        "UPDATE etapas SET orden = orden + 1000 WHERE producto = $1 AND orden >= 5",
        [producto.slug]
      );

      // Paso 2: renombrar "Visitado" → "Visita realizada" si existe con ese nombre viejo.
      await cliente.query(
        "UPDATE etapas SET nombre = 'Visita realizada' WHERE producto = $1 AND nombre = 'Visitado'",
        [producto.slug]
      );
      // Y "Promesa de compraventa" → "Promesa", si así estaba.
      await cliente.query(
        "UPDATE etapas SET nombre = 'Promesa' WHERE producto = $1 AND nombre = 'Promesa de compraventa'",
        [producto.slug]
      );

      // Paso 3: insertar "Negociación" en el puesto 5.
      await cliente.query(
        `INSERT INTO etapas (producto, nombre, orden, porcentaje)
         VALUES ($1, 'Negociación', 5, 80)
         ON CONFLICT (producto, orden) DO NOTHING`,
        [producto.slug]
      );

      // Paso 4: bajar del rango temporal a los valores finales, y de paso
      // ponerles el porcentaje/orden correcto a cada una según su nombre.
      const filasTemporales = await cliente.query(
        "SELECT id, nombre, orden FROM etapas WHERE producto = $1 AND orden >= 1000",
        [producto.slug]
      );
      for (const fila of filasTemporales.rows) {
        const objetivo = nombresObjetivo[fila.nombre];
        if (objetivo) {
          await cliente.query("UPDATE etapas SET orden = $1, porcentaje = $2 WHERE id = $3", [
            objetivo.orden,
            objetivo.porcentaje,
            fila.id,
          ]);
        } else {
          // Etapa con nombre que no reconocemos (el cliente ya la había
          // renombrado a su manera) — se queda con su nombre, solo se le
          // quita el desplazamiento temporal para que no quede huérfana.
          await cliente.query("UPDATE etapas SET orden = orden - 1000 WHERE id = $1", [fila.id]);
        }
      }

      // Paso 5: ponerle porcentaje también a las etapas que no pasaron por
      // el rango temporal (Lead, Contacto, Visita agendada quedaron con su
      // orden de siempre, 1-3, y todavía no tienen porcentaje asignado).
      for (const [nombre, { porcentaje }] of Object.entries(nombresObjetivo)) {
        await cliente.query(
          "UPDATE etapas SET porcentaje = $1 WHERE producto = $2 AND nombre = $3 AND porcentaje IS NULL",
          [porcentaje, producto.slug, nombre]
        );
      }

      // Paso 6: agregar Remarketing y No contactar si no existían.
      await cliente.query(
        `INSERT INTO etapas (producto, nombre, orden, porcentaje)
         VALUES ($1, 'Remarketing', 90, NULL), ($1, 'No contactar', 91, NULL)
         ON CONFLICT (producto, orden) DO NOTHING`,
        [producto.slug]
      );

      await cliente.query("COMMIT");
      console.log(`[Migración] Etapas de "${producto.slug}" actualizadas a la versión con porcentajes.`);
    } catch (error) {
      await cliente.query("ROLLBACK");
      console.error(`[Migración] Error migrando etapas de "${producto.slug}":`, error);
    } finally {
      cliente.release();
    }
  }
}

// Mapa compartido nombre → { orden, porcentaje } para el pipeline estándar.
// Lo usan tanto la siembra inicial (producto nuevo) como la migración de
// productos que ya tenían etapas de la versión anterior (ver migrarEtapasV2).
const MAPA_ETAPAS_ESTANDAR = {
  Lead: { orden: 1, porcentaje: 10 },
  Contacto: { orden: 2, porcentaje: 20 },
  "Visita agendada": { orden: 3, porcentaje: 40 },
  "Visita realizada": { orden: 4, porcentaje: 60 },
  Negociación: { orden: 5, porcentaje: 80 },
  Separación: { orden: 6, porcentaje: 100 },
  Promesa: { orden: 7, porcentaje: null },
  Escritura: { orden: 8, porcentaje: null },
  Entrega: { orden: 9, porcentaje: null },
  Remarketing: { orden: 90, porcentaje: null },
  "No contactar": { orden: 91, porcentaje: null },
};

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
      const nombre = etapas[i];
      const estandar = MAPA_ETAPAS_ESTANDAR[nombre];
      await pool.query(
        "INSERT INTO etapas (producto, nombre, orden, porcentaje) VALUES ($1, $2, $3, $4) ON CONFLICT (producto, orden) DO NOTHING",
        [producto.slug, nombre, estandar?.orden ?? i + 1, estandar?.porcentaje ?? null]
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

// Avanza la etapa de un lead SOLO si la etapa objetivo está más adelante en
// el pipeline que la actual — nunca retrocede algo que el comercial ya movió
// manualmente más allá (ej. si ya está en "Negociación" y llega una novedad
// de "visita agendada", NO lo regresa a "Visita agendada"). Si el lead no
// tiene ninguna etapa asignada todavía, simplemente le pone la objetivo.
// Devuelve true si sí avanzó, false si no hizo falta.
//
// IMPORTANTE: registra el cambio en `eventos` con tipo "cambio_etapa" y
// detalle { origen: "automatico", etapaId }, igual que el cambio manual
// (ver routes/acciones.js) — así el módulo de velocidad del embudo puede
// reconstruir el historial completo, sin huecos, sin importar si el cambio
// lo hizo el webhook o un asesor a mano.
export async function avanzarEtapaSiCorresponde(producto, telefono, nombreEtapaObjetivo) {
  await asegurarEsquema();

  const etapas = await listarEtapas(producto);
  const objetivo = etapas.find((e) => e.nombre === nombreEtapaObjetivo);
  if (!objetivo) return false; // el producto no tiene esa etapa configurada, no hacer nada

  const lead = await pool.query(
    "SELECT etapa_id FROM leads_crm WHERE producto = $1 AND telefono = $2",
    [producto, telefono]
  );
  const etapaActualId = lead.rows[0]?.etapa_id || null;
  const etapaActual = etapas.find((e) => e.id === etapaActualId);

  // Si ya está en Remarketing o No contactar, nunca lo mueve automáticamente
  // — esos son estados que el sistema o el cliente decidieron a propósito,
  // no algo que una "novedad" normal deba pisar.
  if (etapaActual && (etapaActual.nombre === "Remarketing" || etapaActual.nombre === "No contactar")) {
    return false;
  }

  if (etapaActual && etapaActual.orden >= objetivo.orden) return false;

  await pool.query(
    "UPDATE leads_crm SET etapa_id = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3",
    [objetivo.id, producto, telefono]
  );
  await registrarEvento(producto, telefono, "cambio_etapa", {
    origen: "automatico",
    etapaId: objetivo.id,
  });
  return true;
}

// Para "Remarketing" y "No contactar": a diferencia de avanzarEtapaSiCorresponde,
// esta SÍ se puede aplicar sin importar en qué etapa estaba antes — son
// estados especiales que el bot detectó (lead enfriado, o cliente pidió no
// ser contactado más), no un paso normal del pipeline de ventas.
//
// También registra el cambio en `eventos` (mismo motivo que en
// avanzarEtapaSiCorresponde, ver comentario arriba).
export async function establecerEtapaEspecial(producto, telefono, nombreEtapa) {
  await asegurarEsquema();
  const etapas = await listarEtapas(producto);
  const objetivo = etapas.find((e) => e.nombre === nombreEtapa);
  if (!objetivo) return false;

  await pool.query(
    "UPDATE leads_crm SET etapa_id = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3",
    [objetivo.id, producto, telefono]
  );
  await registrarEvento(producto, telefono, "cambio_etapa", {
    origen: "automatico",
    etapaId: objetivo.id,
  });
  return true;
}

// Campos que se pueden editar desde la tabla de Oportunidades Activas. Lista
// blanca a propósito — nunca se arma el nombre de columna con lo que venga
// del formulario, así no hay riesgo de inyección ni de tocar una columna que
// no debería ser editable desde ahí.
const CAMPOS_EDITABLES_OPORTUNIDAD = {
  valor_venta: "valor_venta",
  nombre_override: "nombre_override",
};

export async function actualizarCampoOportunidad(producto, telefono, campo, valor) {
  const columna = CAMPOS_EDITABLES_OPORTUNIDAD[campo];
  if (!columna) throw new Error(`Campo no editable: ${campo}`);

  await asegurarLeadCrm(producto, telefono);
  await pool.query(
    `UPDATE leads_crm SET ${columna} = $1, actualizado_en = now() WHERE producto = $2 AND telefono = $3`,
    [valor, producto, telefono]
  );
}

export async function crearTarea(producto, telefono, concepto, fecha, creadoPorId) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `INSERT INTO tareas (producto, telefono, concepto, fecha, creado_por_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [producto, telefono, concepto, fecha, creadoPorId || null]
  );
  return resultado.rows[0];
}

export async function listarTareasLead(producto, telefono) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `SELECT t.*, u.nombre AS creado_por_nombre
     FROM tareas t
     LEFT JOIN usuarios u ON u.id = t.creado_por_id
     WHERE t.producto = $1 AND t.telefono = $2
     ORDER BY t.completada ASC, t.fecha ASC`,
    [producto, telefono]
  );
  return resultado.rows;
}

// Todas las tareas pendientes (sin completar) de un producto, con el nombre
// del cliente resuelto — la usa el dashboard de tareas del asesor. El
// filtro por asesor (solo ver las suyas si no es admin) se aplica afuera,
// en la ruta, igual que con leads y visitas.
export async function listarTareasPendientes(producto) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `SELECT t.*, lc.asesor_id, u.nombre AS asesor_nombre
     FROM tareas t
     LEFT JOIN leads_crm lc ON lc.producto = t.producto AND lc.telefono = t.telefono
     LEFT JOIN usuarios u ON u.id = lc.asesor_id
     WHERE t.producto = $1 AND t.completada = false
     ORDER BY t.fecha ASC`,
    [producto]
  );
  return resultado.rows;
}

export async function completarTarea(producto, tareaId) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `UPDATE tareas SET completada = true, completada_en = now()
     WHERE producto = $1 AND id = $2 RETURNING *`,
    [producto, tareaId]
  );
  return resultado.rows[0] || null;
}

export async function listarLeadsCrm(producto) {
  await asegurarEsquema();
  const resultado = await pool.query(
    `SELECT lc.*, e.nombre AS etapa_nombre, e.porcentaje AS etapa_porcentaje, u.nombre AS asesor_nombre
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
    "SELECT id, nombre, email, rol, meta_mensual FROM usuarios WHERE activo = true ORDER BY nombre ASC"
  );
  return resultado.rows;
}

export async function obtenerMetaMensual(usuarioId) {
  await asegurarEsquema();
  const resultado = await pool.query("SELECT meta_mensual FROM usuarios WHERE id = $1", [usuarioId]);
  const valor = resultado.rows[0]?.meta_mensual;
  return valor != null ? Number(valor) : null;
}

// SOLO admin puede fijar la meta de un vendedor (se valida en la ruta, no
// aquí — esta función solo ejecuta el guardado).
export async function guardarMetaMensual(usuarioId, monto) {
  await pool.query("UPDATE usuarios SET meta_mensual = $1 WHERE id = $2", [monto, usuarioId]);
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