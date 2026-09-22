import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { asegurarLeadCrm, guardarCotizacion, obtenerCotizacion } from "../db/crm.js";

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

// El bot solo puede ver/descargar las cotizaciones de sus propios leads
// asignados (un admin ve todas) — mismo candado que puedeVerLead en
// routes/bandeja.js, repetido acá porque esa función no está exportada.
async function puedeVerCotizacionDeLead(usuario, producto, telefono) {
  if (usuario.rol === "admin") return true;
  if (!telefono) return false; // cotización "suelta", sin lead — solo admin
  const leadCrm = await asegurarLeadCrm(producto, telefono);
  return leadCrm?.asesor_id === usuario.id;
}

// El PDF llega en base64 dentro de un JSON normal (no multipart/form-data,
// para no depender de una librería nueva como multer) — por eso el límite
// general del body en index.js se subió a 15mb (una propuesta con logo
// puede pesar 1-2 MB, y en base64 pesa ~33% más; con el límite por defecto
// de 100kb esta ruta nunca recibía el body completo).
router.post("/cotizador/guardar", async (req, res) => {
  try {
    const { producto, telefono, nombreCliente, nombreArchivo, archivoPdfBase64 } = req.body;
    if (!nombreArchivo || !archivoPdfBase64) {
      return res.status(400).json({ error: "Falta 'nombreArchivo' o 'archivoPdfBase64'" });
    }
    const slug = producto || "senderos";
    const archivoPdf = Buffer.from(archivoPdfBase64, "base64");

    const guardada = await guardarCotizacion({
      producto: slug,
      telefono: telefono ? telefono.trim() : null,
      nombreCliente: nombreCliente ? nombreCliente.trim() : null,
      nombreArchivo,
      archivoPdf,
      creadoPorId: req.session.usuario.id,
    });

    res.json({ ok: true, id: guardada.id });
  } catch (error) {
    console.error("Error guardando cotización:", error);
    res.status(500).json({ error: "Error interno guardando la cotización" });
  }
});

router.get("/cotizador/descargas/:id", async (req, res) => {
  try {
    const cotizacion = await obtenerCotizacion(req.params.id);
    if (!cotizacion) return res.status(404).send("Cotización no encontrada");

    const autorizado = await puedeVerCotizacionDeLead(req.session.usuario, cotizacion.producto, cotizacion.telefono);
    if (!autorizado) return res.status(403).send("No tienes acceso a esta cotización");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${cotizacion.nombre_archivo}"`);
    res.send(cotizacion.archivo_pdf);
  } catch (error) {
    console.error("Error descargando cotización:", error);
    res.status(500).send("Error interno descargando la cotización");
  }
});

export default router;
