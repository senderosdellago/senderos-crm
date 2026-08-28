import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool, obtenerEstadoBrujula, guardarEstadoBrujula } from "../db/crm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// El acceso a Brújula es un permiso POR PERSONA, no por rol (a diferencia
// de casi todo lo demás en el CRM) — solo un subconjunto específico de
// asesores debe entrar, decidido por el administrador desde
// /dashboard/equipo. Se consulta la base de datos en cada request, sin
// confiar en la sesión — si el admin quita el acceso mientras la persona
// ya tiene sesión iniciada, se corta de inmediato en el siguiente clic, no
// hay que esperar a que la sesión expire.
async function requiereAccesoBrujula(req, res, next) {
  try {
    const usuario = req.session?.usuario;
    if (!usuario) return res.redirect("/login");
    if (usuario.rol === "admin") return next();

    const resultado = await pool.query("SELECT acceso_brujula FROM usuarios WHERE id = $1", [usuario.id]);
    if (resultado.rows[0]?.acceso_brujula) return next();

    res.status(403).send(
      "No tienes acceso a esta sección. Si crees que deberías tenerlo, pídele al administrador que te lo active desde Equipo."
    );
  } catch (error) {
    console.error("Error verificando acceso a Brújula:", error);
    res.status(500).send("Error verificando el acceso.");
  }
}

// La página en sí — un HTML autocontenido (igual que el Cotizador), no pasa
// por EJS. Vive en src/assets/ (no en src/public/) porque tiene información
// interna de costos y compromisos — public/ se sirve sin login.
router.get("/brujula", requiereAccesoBrujula, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "assets", "brujula.html"));
});

// API que usa la página para leer/guardar su estado — reemplaza la
// persistencia que antes dependía de window.claude.use("artifact"), que
// solo existe dentro de claude.ai. Todo el estado (áreas, tareas, hitos,
// presupuestos) se guarda como un solo JSON en Postgres, igual que
// funcionaba como Artifact — el disco de Railway se borra en cada deploy,
// así que no servía guardar esto en un archivo.
router.get("/api/brujula", requiereAccesoBrujula, async (req, res) => {
  try {
    const datos = await obtenerEstadoBrujula("senderos");
    res.json(datos || {});
  } catch (error) {
    console.error("Error cargando estado de Brújula:", error);
    res.status(500).json({ error: "Error cargando los datos" });
  }
});

router.post("/api/brujula", requiereAccesoBrujula, async (req, res) => {
  try {
    await guardarEstadoBrujula("senderos", req.body);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando estado de Brújula:", error);
    res.status(500).json({ error: "Error guardando los datos" });
  }
});

export default router;
