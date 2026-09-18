const db = require('./db');

(async () => {
  console.log('--- PURGANDO DATOS DE PRUEBA (TURSO / LOCAL) ---');

  await db.exec('DELETE FROM solicitudes;');
  await db.exec('DELETE FROM auditoria;');
  await db.exec('DELETE FROM asesores_catalogo;');

  try {
    await db.exec("DELETE FROM sqlite_sequence WHERE name IN ('solicitudes', 'auditoria', 'asesores_catalogo');");
  } catch (e) {}

  await db.prepare("UPDATE usuarios SET nombre = 'Líder de Área', area = 'Cobranzas' WHERE username = 'lider'").run();

  const sol = await db.prepare('SELECT COUNT(*) as c FROM solicitudes').get();
  const aud = await db.prepare('SELECT COUNT(*) as c FROM auditoria').get();
  const cat = await db.prepare('SELECT COUNT(*) as c FROM asesores_catalogo').get();
  const lid = await db.prepare('SELECT COUNT(*) as c FROM lideres_directorio').get();
  const ar = await db.prepare('SELECT COUNT(*) as c FROM areas').get();
  const us = await db.prepare('SELECT id, username, nombre, rol, area FROM usuarios').all();

  console.log('✅ BASE DE DATOS 100% LIMPIA Y LISTA PARA PRODUCCIÓN');
  console.log('Solicitudes registradas:', sol.c);
  console.log('Logs de auditoría:', aud.c);
  console.log('Catálogo de asesores:', cat.c);
  console.log('Directorio de Líderes Oficiales:', lid.c);
  console.log('Áreas Oficiales:', ar.c);
  console.log('Usuarios:', us);
  process.exit(0);
})();
