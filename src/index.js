import express from "express";
import dotenv from "dotenv";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import { pool, asegurarEsquema } from "./db/crm.js";
import { requiereLogin } from "./middleware/auth.js";
import rutasAuth from "./routes/auth.js";
import rutasBandeja from "./routes/bandeja.js";
import rutasDashboard from "./routes/dashboard.js";
import rutasAcciones from "./routes/acciones.js";
import rutasAsistente from "./routes/asistente.js";
import rutasWebhook from "./routes/webhook.js";
import rutasCotizador from "./routes/cotizador.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1);
const servidorHttp = createServer(app);
const io = new Server(servidorHttp);
app.set("io", io);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, tableName: "session" }),
    secret: process.env.SESSION_SECRET || "cambia-este-valor-en-produccion",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.get("/", (req, res) => res.redirect(req.session?.usuario ? "/dashboard" : "/login"));
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", detalle: error.message });
  }
});

// El webhook lo llama el bot, sin sesión de usuario — va antes del middleware de login.
app.use(rutasWebhook);

app.use(rutasAuth);
app.use(requiereLogin, rutasBandeja);
app.use(requiereLogin, rutasDashboard);
app.use(requiereLogin, rutasAcciones);
app.use(requiereLogin, rutasAsistente);
app.use(requiereLogin, rutasCotizador);

io.on("connection", (socket) => {
  socket.on("unirse", ({ producto }) => {
    if (producto) socket.join(`producto:${producto}`);
  });
});

const PORT = process.env.PORT || 3100;

asegurarEsquema()
  .then(() => {
    servidorHttp.listen(PORT, () => {
      console.log(`CRM corriendo en puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Error inicializando el esquema de la base de datos:", error);
    process.exit(1);
  });
