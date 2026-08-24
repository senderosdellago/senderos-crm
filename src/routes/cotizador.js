import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// El cotizador es un archivo HTML autocontenido (compilado a partir de un
// artefacto: incluye su propia librería para generar Word, el inventario
// real de lotes, y el logo, todo embebido) — no pasa por EJS, se manda tal
// cual con res.sendFile. Vive en src/assets/ (NO en src/public/) a propósito:
// public/ se sirve sin login (ver express.static en index.js), y este
// archivo tiene precios internos reales — por eso esta ruta si pasa por
// requiereLogin (aplicado en index.js, igual que las demás rutas del CRM).
router.get("/cotizador", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "assets", "cotizador.html"));
});

export default router;
