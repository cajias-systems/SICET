require('dotenv').config();
const { createClient } = require('@libsql/client');
const path = require('path');

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'salidas.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

console.log(`[DB] Conectando a: ${url.startsWith('file:') ? 'SQLite Local (salidas.db)' : 'Turso Database Cloud (' + url.split('@')[0] + ')'}`);

const client = createClient({ url, authToken });

const db = {
  client,
  isTurso: !url.startsWith('file:'),

  prepare(sql) {
    return {
      all: async (...args) => {
        const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const rs = await client.execute({ sql, args: flatArgs });
        return rs.rows;
      },
      get: async (...args) => {
        const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const rs = await client.execute({ sql, args: flatArgs });
        return rs.rows[0] || null;
      },
      run: async (...args) => {
        const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        const rs = await client.execute({ sql, args: flatArgs });
        return {
          lastInsertRowid: rs.lastInsertRowid !== undefined ? Number(rs.lastInsertRowid) : undefined,
          changes: rs.rowsAffected
        };
      }
    };
  },

  async exec(sql) {
    return await client.executeMultiple(sql);
  }
};

async function initDb() {
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nombre TEXT NOT NULL,
        rol TEXT NOT NULL,
        area TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS lideres_directorio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE,
        area_default TEXT DEFAULT 'Cobranzas',
        activo INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);

    await client.execute(`
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
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS areas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE
      );
    `);

    await client.execute(`
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
        estado TEXT DEFAULT 'PENDIENTE',
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
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        solicitud_id INTEGER,
        accion TEXT NOT NULL,
        usuario TEXT DEFAULT 'Sistema',
        detalles TEXT,
        timestamp TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);

    // Sembrar los 27 líderes
    const checkLid = await client.execute('SELECT COUNT(*) as c FROM lideres_directorio');
    if (checkLid.rows[0].c === 0) {
      const nominaLideres = [
        'Anderson Guzman', 'Asdrubal', 'Brandon Castillo', 'Brandon Jacome',
        'Carolina Sangucho', 'Cinthya Pavon', 'Estefania Chasipanta', 'Edgar Jumbo',
        'Edinxon Mendoza', 'Edumary Gabriela', 'Avila Bryan', 'Ivy Estupinan',
        'Jose Castillo', 'Maycol Viana', 'Jordan Trujillo', 'Joshep Casarez',
        'Juan Lopez', 'Alexander', 'William', 'Rafaela', 'Ricardo',
        'Roberto Flores', 'Romel Chuchimbe', 'Sabrina', 'Samantha Fonseca',
        'Victor', 'Rayza'
      ];
      for (const l of nominaLideres) {
        await client.execute({ sql: 'INSERT OR IGNORE INTO lideres_directorio (nombre, area_default) VALUES (?, ?)', args: [l, 'Cobranzas'] });
      }
    }

    // Sembrar 6 áreas oficiales
    const defaultAreas = [
      'Cobranzas',
      'Minimarket / Tiendita',
      'Recursos Humanos',
      'Gerencia de Cobranzas',
      'Limpieza',
      'Sistemas / TI'
    ];
    for (const a of defaultAreas) {
      await client.execute({ sql: 'INSERT OR IGNORE INTO areas (nombre) VALUES (?)', args: [a] });
    }

    // Sembrar usuarios
    await client.execute({
      sql: 'INSERT OR IGNORE INTO usuarios (username, password, nombre, rol, area) VALUES (?, ?, ?, ?, ?)',
      args: ['sistemas', 'sistemas123', 'David Sistemas', 'sistemas', 'Sistemas / TI']
    });
    await client.execute({
      sql: 'INSERT OR IGNORE INTO usuarios (username, password, nombre, rol, area) VALUES (?, ?, ?, ?, ?)',
      args: ['seguridad', 'garita123', 'Guardia de Garita', 'garita', 'Seguridad Física']
    });
    await client.execute({
      sql: 'INSERT OR IGNORE INTO usuarios (username, password, nombre, rol, area) VALUES (?, ?, ?, ?, ?)',
      args: ['lider', 'lider123', 'Líder de Área', 'lider', 'Cobranzas']
    });

    console.log('[DB] Esquema y tablas verificadas correctamente.');
  } catch (err) {
    console.error('[DB] Error inicializando tablas:', err.message);
  }
}

db.initDb = initDb;

module.exports = db;
