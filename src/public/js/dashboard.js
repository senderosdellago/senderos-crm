<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dashboard — <%= productoActual.nombre %></title>
  <link rel="stylesheet" href="/css/estilos.css" />
</head>
<body>
  <header class="encabezado">
    <div>
      <strong><%= productoActual.nombre %></strong>
      <span class="punto-conexion" id="estado-conexion" title="Conexión en tiempo real"></span>
    </div>
    <nav class="nav-principal">
      <a href="/dashboard?producto=<%= productoActual.slug %>" class="activo">Dashboard</a>
      <a href="/bandeja?producto=<%= productoActual.slug %>">Bandeja</a>
    </nav>
    <div class="encabezado-usuario">
      <span><%= usuario.nombre %></span>
      <form method="POST" action="/logout"><button type="submit" class="boton-enlace">Salir</button></form>
    </div>
  </header>

  <main class="contenedor-dashboard">
    <p class="saludo-dashboard">Hola, <%= usuario.nombre.split(" ")[0] %> — estos son los leads que necesitan tu atención hoy.</p>

    <div class="grid-resumen" id="grid-resumen">
      <%- include("parciales/tarjetas-resumen", { resumen }) %>
    </div>

    <section id="seccion-intervencion">
      <h2 class="titulo-seccion titulo-urgente">Requieren intervención ahora</h2>
      <div class="lista-leads" id="lista-intervencion">
        <%- include("parciales/leads-triage", { leads: requierenIntervencion, tipo: "intervencion", producto: productoActual.slug }) %>
      </div>
    </section>

    <section id="seccion-calientes">
      <h2 class="titulo-seccion titulo-caliente">Calientes sin visita agendada</h2>
      <div class="lista-leads" id="lista-calientes">
        <%- include("parciales/leads-triage", { leads: calientesSinAgendar, tipo: "caliente", producto: productoActual.slug }) %>
      </div>
    </section>

    <section id="seccion-seguimiento">
      <h2 class="titulo-seccion">En seguimiento automático (<%= resumen.enSeguimiento %>)</h2>
      <p class="texto-discreto">Paola sigue estas conversaciones sola por ahora — no requieren tu atención todavía.</p>
    </section>
  </main>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const PRODUCTO = "<%= productoActual.slug %>";
  </script>
  <script src="/js/dashboard.js"></script>
</body>
</html>
