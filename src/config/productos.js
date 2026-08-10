// Lista de productos/negocios conectados al CRM.
// Agregar un producto nuevo = una entrada aquí + sus variables de entorno.
// Nada más del código necesita cambiar.

export const productos = [
  {
    slug: "senderos",
    nombre: "Senderos del Lago",
    // Cadena de conexión a la base de datos del bot de este producto.
    dbEnvVar: "SENDEROS_DATABASE_URL",
    // Debe ser el MISMO valor que CRM_INTERNO_SECRET en el bot de este producto.
    secretoEnvVar: "SENDEROS_INTERNO_SECRET",
    // URL base del bot (para llamar /interno/intervenir, /interno/devolver, etc.)
    botUrlEnvVar: "SENDEROS_BOT_URL",
    // Etapas por defecto si el producto no tiene ninguna todavía (se usan solo
    // para sembrar la tabla `etapas` la primera vez). El porcentaje se asigna
    // en la migración (ver db/crm.js migrarEtapasV2) — ahí está el mapa
    // completo nombre → porcentaje, mantenlo sincronizado con esta lista.
    etapasIniciales: [
      "Lead",
      "Contacto",
      "Visita agendada",
      "Visita realizada",
      "Negociación",
      "Separación",
      "Promesa",
      "Escritura",
      "Entrega",
      "Remarketing",
      "No contactar",
    ],
  },
  // Cuando exista Winncom u otro producto, se agrega aquí:
  // {
  //   slug: "winncom",
  //   nombre: "Winncom",
  //   dbEnvVar: "WINNCOM_DATABASE_URL",
  //   secretoEnvVar: "WINNCOM_INTERNO_SECRET",
  //   botUrlEnvVar: "WINNCOM_BOT_URL",
  //   etapasIniciales: [...],
  // },
];

export function obtenerProducto(slug) {
  return productos.find((p) => p.slug === slug) || null;
}
