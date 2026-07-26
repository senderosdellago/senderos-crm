export function requiereLogin(req, res, next) {
  if (!req.session?.usuario) {
    if (req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "No autenticado" });
    }
    return res.redirect("/login");
  }
  next();
}

export function requiereAdmin(req, res, next) {
  if (req.session?.usuario?.rol !== "admin") {
    return res.status(403).json({ error: "Solo un administrador puede hacer esto" });
  }
  next();
}
