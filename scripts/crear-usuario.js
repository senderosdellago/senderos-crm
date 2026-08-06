// Script de línea de comandos para crear (o actualizar) un usuario del CRM.
//
// Uso:
//   node scripts/crear-usuario.js "Nombre Apellido" correo@ejemplo.com contraseña123 admin
//   node scripts/crear-usuario.js "Nombre Apellido" correo@ejemplo.com contraseña123 asesor
//
// El rol es opcional, por defecto "asesor".

// IMPORTANTE: "dotenv/config" tiene que ser el PRIMER import, antes que
// crm.js — así el .env ya está cargado cuando crm.js crea la conexión a la
// base de datos (Pool se crea apenas se importa el archivo, no cuando se usa).
// Si esto queda después, DATABASE_URL todavía está vacía en ese momento y la
// conexión cae al valor por defecto (localhost), fallando siempre en local.
import "dotenv/config";
import bcrypt from "bcrypt";
import { pool, asegurarEsquema } from "../src/db/crm.js";

async function main() {
  const [, , nombre, email, password, rolArg] = process.argv;
  const rol = rolArg === "admin" ? "admin" : "asesor";

  if (!nombre || !email || !password) {
    console.error(
      'Uso: node scripts/crear-usuario.js "Nombre Apellido" correo@ejemplo.com contraseña123 [admin|asesor]'
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  await asegurarEsquema();

  const passwordHash = await bcrypt.hash(password, 12);

  const resultado = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       nombre = EXCLUDED.nombre,
       password_hash = EXCLUDED.password_hash,
       rol = EXCLUDED.rol,
       activo = true
     RETURNING id, nombre, email, rol`,
    [nombre, email.trim().toLowerCase(), passwordHash, rol]
  );

  console.log("Usuario creado/actualizado:", resultado.rows[0]);
  await pool.end();
}

main().catch((error) => {
  console.error("Error creando usuario:", error);
  process.exit(1);
});
