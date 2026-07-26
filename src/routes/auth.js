import { Router } from "express";
import bcrypt from "bcrypt";
import { pool, asegurarEsquema } from "../db/crm.js";

const router = Router();

router.get("/login", (req, res) => {
  if (req.session?.usuario) return res.redirect("/bandeja");
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
    };
    res.redirect("/bandeja");
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
