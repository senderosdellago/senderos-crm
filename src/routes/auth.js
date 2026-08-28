import { Router } from "express";
import bcrypt from "bcrypt";
import { pool, asegurarEsquema } from "../db/crm.js";

const router = Router();

router.get("/login", (req, res) => {
  if (req.session?.usuario) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

router.post("/login", async (req, res) => {
  try {
    await asegurarEsquema();
    const { email, password } = req.body;

    const resultado = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1 AND activo = true",
      [(email || "").trim().toLowerCase()]
    );
    const usuario = resultado.rows[0];

    const coincide = usuario
      ? await bcrypt.compare(password || "", usuario.password_hash)
      : false;

    if (!usuario || !coincide) {
      return res.status(401).render("login", { error: "Correo o contraseña incorrectos." });
    }

    req.session.usuario = {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
      // Se guarda en la sesión (igual que "rol") solo para decidir si se
      // muestra el link "Brújula" en el menú — el acceso REAL a /brujula y
      // /api/brujula siempre se valida contra la base de datos en cada
      // request (ver requiereAccesoBrujula en routes/brujula.js), así que
      // si el admin cambia el permiso, la próxima vez que esa persona
      // vuelva a iniciar sesión el menú ya refleja el cambio correcto.
      accesoBrujula: usuario.rol === "admin" || usuario.acceso_brujula === true,
    };
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Error en login:", error);
    res.status(500).render("login", { error: "Tuvimos un problema técnico. Intenta de nuevo." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

export default router;
