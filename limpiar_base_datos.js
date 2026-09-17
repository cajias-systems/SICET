const db = require('./db');

console.log('--- PURGANDO DATOS DE PRUEBA DE SALIDAS.DB ---');

// 1. Limpiar tablas de pruebas
db.exec('DELETE FROM solicitudes;');
db.exec('DELETE FROM auditoria;');
db.exec('DELETE FROM asesores_catalogo;');

// 2. Reiniciar secuencias autoincrementables
try {
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('solicitudes', 'auditoria', 'asesores_catalogo');");
} catch (e) {
  console.log('Nota sqlite_sequence:', e.message);
}

// 3. Normalizar usuario lider base
db.prepare("UPDATE usuarios SET nombre = 'Líder de Área', area = 'Cobranzas' WHERE username = 'lider'").run();

// 4. Compactar base de datos
db.exec('VACUUM;');

console.log('✅ Base de datos 100% limpia y lista para producción.');
console.log('Solicitudes registradas:', db.prepare('SELECT COUNT(*) as c FROM solicitudes').get().c);
console.log('Logs de auditoría:', db.prepare('SELECT COUNT(*) as c FROM auditoria').get().c);
console.log('Catálogo de asesores:', db.prepare('SELECT COUNT(*) as c FROM asesores_catalogo').get().c);
console.log('Directorio de Líderes Oficiales:', db.prepare('SELECT COUNT(*) as c FROM lideres_directorio').get().c);
console.log('Áreas Oficiales:', db.prepare('SELECT COUNT(*) as c FROM areas').get().c);
console.log('Usuarios:', db.prepare('SELECT id, username, nombre, rol, area FROM usuarios').all());
