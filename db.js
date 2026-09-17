const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'salidas.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  // 1. Tabla de Usuarios y Roles (RBAC)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL, -- 'sistemas', 'garita', 'lider'
      area TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 2. Tabla del Directorio Oficial de Líderes
  db.exec(`
    CREATE TABLE IF NOT EXISTS lideres_directorio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE,
      area_default TEXT DEFAULT 'Operaciones',
      activo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Poblar los 27 líderes oficiales de la empresa si está vacía
  const checkLideres = db.prepare('SELECT COUNT(*) as count FROM lideres_directorio').get();
  if (checkLideres.count === 0) {
    const insertLider = db.prepare('INSERT OR IGNORE INTO lideres_directorio (nombre, area_default) VALUES (?, ?)');
    const nominaLideres = [
      'Anderson Guzman',
      'Asdrubal',
      'Brandon Castillo',
      'Brandon Jacome',
      'Carolina Sangucho',
      'Cinthya Pavon',
      'Estefania Chasipanta',
      'Edgar Jumbo',
      'Edinxon Mendoza',
      'Edumary Gabriela',
      'Avila Bryan',
      'Ivy Estupinan',
      'Jose Castillo',
      'Maycol Viana',
      'Jordan Trujillo',
      'Joshep Casarez',
      'Juan Lopez',
      'Alexander',
      'William',
      'Rafaela',
      'Ricardo',
      'Roberto Flores',
      'Romel Chuchimbe',
      'Sabrina',
      'Samantha Fonseca',
      'Victor',
      'Rayza'
    ];

    for (const l of nominaLideres) {
      insertLider.run(l, 'Operaciones');
    }
  }

  // 3. Tabla de Catálogo de Asesores Habituales por Líder (Memoria del Equipo)
  db.exec(`
    CREATE TABLE IF NOT EXISTS asesores_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lider_nombre TEXT NOT NULL,
      cedula TEXT NOT NULL,
      nombres TEXT NOT NULL,
      codigo_maquina TEXT NOT NULL,
      modelo TEXT DEFAULT 'DELL',
      tipo_equipo TEXT DEFAULT 'Laptop',
      area TEXT DEFAULT '',
      activo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(lider_nombre, cedula)
    );

    CREATE INDEX IF NOT EXISTS idx_cat_lider ON asesores_catalogo(lider_nombre);
    CREATE INDEX IF NOT EXISTS idx_cat_cedula ON asesores_catalogo(cedula);
  `);

  // 4. Tabla de Áreas / Campañas
  db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE
    );
  `);

  // 5. Tabla de Solicitudes de Salida
  db.exec(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cedula TEXT NOT NULL,
      nombres TEXT NOT NULL,
      area TEXT NOT NULL,
      lider_nombre TEXT DEFAULT '',
      codigo_maquina TEXT NOT NULL,
      modelo TEXT DEFAULT 'DELL',
      tipo_equipo TEXT DEFAULT 'Laptop',
      fecha_salida TEXT NOT NULL,
      fecha_retorno_estimada TEXT,
      estado TEXT DEFAULT 'PENDIENTE', -- PENDIENTE, APROBADO, RECHAZADO, SALIO, RETORNADO, NO_SALIO
      motivo_rechazo TEXT,
      codigo_maquina_anterior TEXT,
      motivo_cambio_equipo TEXT,
      aprobado_por TEXT,
      aprobado_en TEXT,
      despachado_por TEXT,
      despachado_en TEXT,
      retornado_por TEXT,
      retornado_en TEXT,
      observaciones TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_solicitudes_cedula ON solicitudes(cedula);
    CREATE INDEX IF NOT EXISTS idx_solicitudes_codigo ON solicitudes(codigo_maquina);
    CREATE INDEX IF NOT EXISTS idx_solicitudes_fecha ON solicitudes(fecha_salida);
    CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes(estado);
    CREATE INDEX IF NOT EXISTS idx_solicitudes_lider ON solicitudes(lider_nombre);
  `);

  // Asegurar columnas existentes
  try {
    const tableInfo = db.prepare("PRAGMA table_info(solicitudes)").all();
    const cols = tableInfo.map(c => c.name);
    if (!cols.includes('modelo')) {
      db.exec("ALTER TABLE solicitudes ADD COLUMN modelo TEXT DEFAULT 'DELL'");
    }
    if (!cols.includes('codigo_maquina_anterior')) {
      db.exec("ALTER TABLE solicitudes ADD COLUMN codigo_maquina_anterior TEXT");
    }
    if (!cols.includes('motivo_cambio_equipo')) {
      db.exec("ALTER TABLE solicitudes ADD COLUMN motivo_cambio_equipo TEXT");
    }
  } catch (err) {}

  // 6. Tabla de Auditoría / Historial de Movimientos
  db.exec(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      solicitud_id INTEGER,
      accion TEXT NOT NULL,
      usuario TEXT DEFAULT 'Sistema',
      detalles TEXT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Insertar usuarios base si faltan
  const checkUsuarios = db.prepare('SELECT COUNT(*) as count FROM usuarios').get();
  if (checkUsuarios.count === 0) {
    const insertUsuario = db.prepare(`
      INSERT INTO usuarios (username, password, nombre, rol, area)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertUsuario.run('sistemas', 'sistemas123', 'David Sistemas', 'sistemas', 'Sistemas / TI');
    insertUsuario.run('seguridad', 'garita123', 'Guardia de Garita', 'garita', 'Seguridad Física');
    insertUsuario.run('lider', 'lider123', 'Líder de Área', 'lider', 'Cobranzas');
  } else {
    // Asegurar que el usuario sistemas tenga el nombre oficial David Sistemas
    db.prepare("UPDATE usuarios SET nombre = 'David Sistemas', area = 'Sistemas / TI' WHERE username = 'sistemas'").run();
  }

  // Sincronizar catálogo oficial y estricto de áreas
  const defaultAreas = [
    'Cobranzas',
    'Minimarket / Tiendita',
    'Recursos Humanos',
    'Gerencia de Cobranzas',
    'Limpieza',
    'Sistemas / TI'
  ];

  // Limpiar áreas no oficiales y asegurar las 6 oficiales
  const existingAreas = db.prepare('SELECT nombre FROM areas').all().map(a => a.nombre);
  const deleteArea = db.prepare('DELETE FROM areas WHERE nombre NOT IN (?, ?, ?, ?, ?, ?)');
  deleteArea.run(...defaultAreas);

  const insertArea = db.prepare('INSERT OR IGNORE INTO areas (nombre) VALUES (?)');
  for (const area of defaultAreas) {
    insertArea.run(area);
  }

  // Actualizar área por defecto de líderes al área operativa real (Cobranzas)
  db.prepare("UPDATE lideres_directorio SET area_default = 'Cobranzas' WHERE area_default = 'Operaciones' OR area_default = ''").run();
  db.prepare("UPDATE solicitudes SET area = 'Cobranzas' WHERE area IN ('Ventas', 'Soporte Técnico', 'Atención al Cliente (ATC)', 'Fidelización', 'Backoffice / Operaciones', 'Calidad / Monitoreo', 'Samantha Fonceca')").run();
}

initDb();

module.exports = db;
