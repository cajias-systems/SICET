const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configurar multer para carga temporal de archivos
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// Función auxiliar para obtener fecha actual en zona horaria oficial de Ecuador (America/Guayaquil, UTC-5)
function getFechaLocalEcuador(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(d);
}

// Función auxiliar para obtener timestamp completo (YYYY-MM-DD HH:mm:ss) en hora oficial de Ecuador
function getTimestampLocalEcuador(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d).replace(', ', ' ');
}

// Función para formatear cualquier timestamp (UTC de SQLite o ISO) a la hora oficial de Ecuador (Quito, UTC-5)
function formatearTimestampEcuador(raw) {
  if (!raw) return '--';
  const str = String(raw).trim();
  let dateObj;
  if (!str.endsWith('Z') && !str.includes('+') && !str.includes('-05:00')) {
    dateObj = new Date(str.replace(' ', 'T') + 'Z');
  } else {
    dateObj = new Date(str);
  }
  if (isNaN(dateObj.getTime())) return raw;
  return new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(dateObj);
}

// Validación de horario de recepción para líderes (06:00 a 17:30, hora de Ecuador)
// Permite bypass las 24h para Sistemas y casos de emergencia médica / contingencia justificada
function verificarHorarioRecepcionLideres(userRole, observaciones = '', esEmergencia = false) {
  if (userRole === 'sistemas') {
    return { permitido: true }; // Sistemas tiene permiso las 24 horas para operar y autorizar
  }

  // Permitir emergencias médicas, salud o contingencias fuera de horario
  if (esEmergencia || /emergencia|urgente|m[eé]dic|salud|enferm|epilep/i.test(observaciones)) {
    return { permitido: true, esEmergencia: true };
  }

  const d = new Date();
  const options = { timeZone: 'America/Guayaquil', hour12: false, hour: 'numeric', minute: 'numeric' };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(d);
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }

  const totalMin = hour * 60 + minute;
  const inicio = 6 * 60;        // 06:00 AM
  const fin = 17 * 60 + 30;     // 17:30 (5:30 PM)

  if (totalMin < inicio || totalMin > fin) {
    const horaStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      permitido: false,
      error: `Horario fuera de turno (${horaStr}): Las solicitudes de salida para teletrabajo habitualmente se reciben de 06:00 a 17:30 (hora oficial de Ecuador). Para casos fuera de turno por salud o contingencia, incluya la palabra "emergencia" o "médica" en las observaciones.`
    };
  }

  return { permitido: true };
}

// ==========================================
// CANAL REACTIVO EN TIEMPO REAL (SSE - Server-Sent Events)
// ==========================================
const sseClients = new Set();

// Caché en memoria para estadísticas (ahorro crítico de ancho de banda saliente hacia Turso)
let statsCache = {
  data: null,
  fecha: null,
  timestamp: 0
};

function invalidarStatsCache() {
  statsCache.data = null;
  statsCache.timestamp = 0;
}

function broadcastEvent(type, data = {}) {
  invalidarStatsCache();
  const payload = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// Endpoint SSE para clientes conectados
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', data: { status: 'ok' }, timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  // Ping periódico cada 20 segundos para mantener la conexión viva en Render
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      clearInterval(keepAliveInterval);
      sseClients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sseClients.delete(res);
  });
});

// Función auxiliar para registrar auditoría con marca de tiempo precisa
async function registrarAuditoria(solicitudId, accion, usuario, detalles) {
  try {
    const nowIso = new Date().toISOString();
    const stmt = await db.prepare(`
      INSERT INTO auditoria (solicitud_id, accion, usuario, detalles, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    await stmt.run(solicitudId, accion, usuario, detalles, nowIso);
  } catch (err) {
    console.error('Error al registrar auditoría:', err);
  }
}

// Función auxiliar para verificar disponibilidad anti-duplicados (máquina y asesor)
async function verificarDisponibilidadEquipo(codigoMaquina, cedula, fechaSalida = null, idIgnorar = null) {
  const normCodigo = (codigoMaquina || '').trim().toUpperCase();
  const normCedula = (cedula || '').trim();
  const today = getFechaLocalEcuador();
  const targetFecha = fechaSalida || today;

  // 1. Verificar si la máquina física ya está en estado 'SALIO' (en la calle sin retornar)
  let queryEquipoSalio = "SELECT * FROM solicitudes WHERE codigo_maquina = ? AND estado = 'SALIO'";
  const paramsEquipoSalio = [normCodigo];
  if (idIgnorar) {
    queryEquipoSalio += " AND id != ?";
    paramsEquipoSalio.push(idIgnorar);
  }
  const ocupadoEquipoSalio = await db.prepare(queryEquipoSalio).get(...paramsEquipoSalio);
  if (ocupadoEquipoSalio) {
    return {
      disponible: false,
      error: `El equipo [${normCodigo}] ya está en teletrabajo en posesión de ${ocupadoEquipoSalio.nombres} (${ocupadoEquipoSalio.area}) desde el ${ocupadoEquipoSalio.fecha_salida}. Debe registrarse su retorno antes de asignarlo nuevamente.`
    };
  }

  // 2. Verificar si el asesor con esa cédula ya tiene una máquina en 'SALIO' (en la calle sin retornar)
  let queryCedulaSalio = "SELECT * FROM solicitudes WHERE cedula = ? AND estado = 'SALIO'";
  const paramsCedulaSalio = [normCedula];
  if (idIgnorar) {
    queryCedulaSalio += " AND id != ?";
    paramsCedulaSalio.push(idIgnorar);
  }
  const ocupadoCedulaSalio = await db.prepare(queryCedulaSalio).get(...paramsCedulaSalio);
  if (ocupadoCedulaSalio) {
    return {
      disponible: false,
      error: `El asesor con cédula [${normCedula}] (${ocupadoCedulaSalio.nombres}) ya tiene un equipo asignado en la calle (${ocupadoCedulaSalio.codigo_maquina}) desde el ${ocupadoCedulaSalio.fecha_salida}. Debe retornar ese equipo antes de solicitar otro.`
    };
  }

  // 3. ANTI-DUPLICADOS: Verificar si el equipo ya tiene solicitud activa (PENDIENTE o APROBADO) para esta fecha
  let queryEquipoActivo = "SELECT * FROM solicitudes WHERE codigo_maquina = ? AND fecha_salida = ? AND estado IN ('PENDIENTE', 'APROBADO')";
  const paramsEquipoActivo = [normCodigo, targetFecha];
  if (idIgnorar) {
    queryEquipoActivo += " AND id != ?";
    paramsEquipoActivo.push(idIgnorar);
  }
  const ocupadoEquipoActivo = await db.prepare(queryEquipoActivo).get(...paramsEquipoActivo);
  if (ocupadoEquipoActivo) {
    return {
      disponible: false,
      error: `DUPLICADO: La laptop [${normCodigo}] ya tiene una solicitud para hoy (${targetFecha}) en estado [${ocupadoEquipoActivo.estado}] solicitada por ${ocupadoEquipoActivo.lider_nombre} para ${ocupadoEquipoActivo.nombres}.`
    };
  }

  // 4. ANTI-DUPLICADOS: Verificar si el asesor con esa cédula ya tiene solicitud activa (PENDIENTE o APROBADO) para esta fecha
  let queryCedulaActivo = "SELECT * FROM solicitudes WHERE cedula = ? AND fecha_salida = ? AND estado IN ('PENDIENTE', 'APROBADO')";
  const paramsCedulaActivo = [normCedula, targetFecha];
  if (idIgnorar) {
    queryCedulaActivo += " AND id != ?";
    paramsCedulaActivo.push(idIgnorar);
  }
  const ocupadoCedulaActivo = await db.prepare(queryCedulaActivo).get(...paramsCedulaActivo);
  if (ocupadoCedulaActivo) {
    return {
      disponible: false,
      error: `DUPLICADO: El asesor con cédula [${normCedula}] (${ocupadoCedulaActivo.nombres}) ya tiene una solicitud para hoy (${targetFecha}) en estado [${ocupadoCedulaActivo.estado}] con la laptop [${ocupadoCedulaActivo.codigo_maquina}].`
    };
  }

  return { disponible: true };
}

// Función auxiliar para auto-sincronizar asesores al catálogo personal del líder
async function sincronizarAsesorAlCatalogo(liderNombre, cedula, nombres, codigoMaquina, modelo, tipoEquipo, area) {
  if (!liderNombre || !cedula || !nombres || !codigoMaquina) return;
  try {
    const stmt = db.prepare(`
      INSERT INTO asesores_catalogo (lider_nombre, cedula, nombres, codigo_maquina, modelo, tipo_equipo, area)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lider_nombre, cedula) DO UPDATE SET
        nombres = excluded.nombres,
        codigo_maquina = excluded.codigo_maquina,
        modelo = excluded.modelo,
        tipo_equipo = excluded.tipo_equipo,
        area = excluded.area,
        activo = 1
    `);
    await stmt.run(
      liderNombre.trim(),
      cedula.trim(),
      nombres.trim(),
      codigoMaquina.trim().toUpperCase(),
      (modelo || 'DELL').trim().toUpperCase(),
      (tipoEquipo || 'Laptop').trim(),
      (area || 'General').trim()
    );
  } catch (err) {
    console.error('Error sincronizando al catálogo:', err);
  }
}

// Función para normalizar nombres de líderes contra el directorio oficial
function resolverNombreLiderOficial(nombre, listaDirectorio = []) {
  if (!nombre) return 'Líder de Área';
  const clean = String(nombre).trim();
  if (!clean) return 'Líder de Área';

  // 1. Coincidencia exacta insensible a mayúsculas
  const exact = listaDirectorio.find(l => l.nombre && l.nombre.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.nombre;

  // 2. Mapeo de variantes conocidas (ej. PEREZ RICARDO, RICARDO PEREZ -> Ricardo)
  if (/ricardo/i.test(clean)) {
    const ric = listaDirectorio.find(l => l.nombre && l.nombre.toLowerCase() === 'ricardo');
    if (ric) return ric.nombre;
  }

  // 3. Coincidencia por partes o palabras
  const palabras = clean.toLowerCase().split(/\s+/);
  for (const palabra of palabras) {
    if (palabra.length >= 4) {
      const match = listaDirectorio.find(l => l.nombre && (l.nombre.toLowerCase().includes(palabra) || palabra.includes(l.nombre.toLowerCase())));
      if (match) return match.nombre;
    }
  }

  return clean;
}

// Función para sanitizar fechas provenientes de Excel (números de serie SSF o texto)
function normalizarFechaExcel(rawFecha, fallbackDate) {
  if (!rawFecha) return fallbackDate;

  // Si viene como número o string puramente numérico (ej. 46287 = 2026-09-22)
  if (typeof rawFecha === 'number' || (/^\d+$/.test(String(rawFecha).trim()) && Number(rawFecha) > 30000 && Number(rawFecha) < 70000)) {
    const serial = Number(rawFecha);
    const d = new Date((serial - 25569) * 86400000);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  let str = String(rawFecha).trim();

  // Formato con barras o guiones
  if (str.includes('/') || str.includes('-')) {
    const separator = str.includes('/') ? '/' : '-';
    const parts = str.split(separator);
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        if (d > 31 || m > 12 || isNaN(y) || isNaN(m) || isNaN(d)) {
          return fallbackDate;
        }
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      } else if (parts[2].length === 4) {
        // DD/MM/YYYY
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        if (d > 31 || m > 12 || isNaN(y) || isNaN(m) || isNaN(d)) {
          return fallbackDate;
        }
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    if (d > 31 || m > 12) return fallbackDate;
    return str;
  }

  return fallbackDate;
}

// ==========================================
// RUTAS DE AUTENTICACIÓN Y ROLES (RBAC)
// ==========================================

// Iniciar sesión (Soporta admin TI, guardia de garita y los 27 líderes por combo box)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, lider_nombre } = req.body;
    if (!password) {
      return res.status(400).json({ ok: false, error: 'La contraseña es requerida.' });
    }

    // 1. Acceso de Líder de Área por Combo Box
    if (lider_nombre || username === 'lider') {
      const nombreFinalLider = (lider_nombre || 'Líder de Área').trim();
      
      // Comprobar contraseña de líder (lider123 o configurable)
      const userLiderDb = await db.prepare("SELECT password FROM usuarios WHERE username = 'lider'").get();
      const claveEsperada = userLiderDb ? userLiderDb.password : 'lider123';

      if (password.trim() !== claveEsperada) {
        return res.status(401).json({ ok: false, error: 'Contraseña de Líder incorrecta.' });
      }

      await registrarAuditoria(null, 'LOGIN_LIDER', nombreFinalLider, `Acceso exitoso al portal de líderes: ${nombreFinalLider}`);

      return res.json({
        ok: true,
        user: {
          id: 99,
          username: nombreFinalLider,
          nombre: nombreFinalLider,
          rol: 'lider',
          area: 'Campañas'
        }
      });
    }

    // 2. Acceso regular (sistemas o seguridad)
    if (!username) {
      return res.status(400).json({ ok: false, error: 'Usuario requerido.' });
    }

    const user = await db.prepare('SELECT id, username, password, nombre, rol, area FROM usuarios WHERE username = ?').get(username.trim());

    if (!user || user.password !== password.trim()) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
    }

    await registrarAuditoria(null, 'LOGIN_EXITOSO', user.nombre, `Inicio de sesión con rol [${user.rol}]`);

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        rol: user.rol,
        area: user.area
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Cambiar contraseña
app.patch('/api/auth/cambiar-clave', async (req, res) => {
  try {
    const { username, clave_actual, nueva_clave } = req.body;
    if (!username || !clave_actual || !nueva_clave) {
      return res.status(400).json({ ok: false, error: 'Datos incompletos.' });
    }

    const user = await db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username.trim());
    if (!user || user.password !== clave_actual.trim()) {
      return res.status(401).json({ ok: false, error: 'La contraseña actual es incorrecta.' });
    }

    await db.prepare('UPDATE usuarios SET password = ? WHERE username = ?').run(nueva_clave.trim(), username.trim());
    await registrarAuditoria(null, 'CAMBIO_CLAVE', user.nombre, 'Contraseña actualizada con éxito');

    res.json({ ok: true, message: 'Contraseña actualizada correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Middleware de verificación de rol
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const userRole = req.headers['x-user-role'] || 'sistemas';
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        ok: false,
        error: `Acceso denegado: Su rol [${userRole}] no tiene permisos para esta acción.`
      });
    }
    next();
  };
}

// ==========================================
// RUTAS DEL DIRECTORIO OFICIAL DE LÍDERES
// ==========================================

// Obtener nómina de personal/líderes oficiales (Directorio)
app.get('/api/lideres-directorio', async (req, res) => {
  try {
    const { todos, area } = req.query;
    let query = 'SELECT * FROM lideres_directorio WHERE 1=1';
    const params = [];
    if (!todos) {
      query += ' AND activo = 1';
    }
    if (area && area !== 'TODOS') {
      query += ' AND area_default = ?';
      params.push(area);
    }
    query += ' ORDER BY cargo ASC, nombre_completo ASC, nombre ASC';
    const lideres = await db.prepare(query).all(...params);
    res.json({ ok: true, data: lideres });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Agregar nuevo líder o personal al directorio (Sistemas)
app.post('/api/lideres-directorio', requireRole(['sistemas']), async (req, res) => {
  try {
    const { 
      nombre, 
      nombre_completo, 
      cedula = '', 
      codigo_maquina = '', 
      modelo = 'Laptop', 
      area_default = 'Cobranzas',
      cargo = 'Líder de Operaciones',
      tiene_pase_libre = 1
    } = req.body;

    const nombreFinal = (nombre || nombre_completo || '').trim();
    if (!nombreFinal) {
      return res.status(400).json({ ok: false, error: 'El nombre o usuario es requerido.' });
    }

    const codLimpio = codigo_maquina ? codigo_maquina.trim().toUpperCase() : '';
    const cedLimpia = cedula ? cedula.trim() : '';

    // Validar si el código de máquina ya está asignado a otro miembro
    if (codLimpio) {
      const duplicadoCod = await db.prepare('SELECT id, nombre, nombre_completo FROM lideres_directorio WHERE UPPER(codigo_maquina) = ?').get(codLimpio);
      if (duplicadoCod) {
        return res.status(400).json({ 
          ok: false, 
          error: `El código de máquina [${codLimpio}] ya está asignado a ${duplicadoCod.nombre_completo || duplicadoCod.nombre}.` 
        });
      }
    }

    // Validar cédula si se proporcionó
    if (cedLimpia) {
      const duplicadoCed = await db.prepare('SELECT id, nombre, nombre_completo FROM lideres_directorio WHERE cedula = ?').get(cedLimpia);
      if (duplicadoCed) {
        return res.status(400).json({ 
          ok: false, 
          error: `La cédula [${cedLimpia}] ya está registrada para ${duplicadoCed.nombre_completo || duplicadoCed.nombre}.` 
        });
      }
    }

    const stmt = db.prepare(`
      INSERT INTO lideres_directorio 
      (nombre, nombre_completo, cedula, codigo_maquina, modelo, area_default, cargo, tiene_pase_libre, estado_ubicacion, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EN_PLANTA', 1)
    `);

    const r = await stmt.run(
      nombreFinal,
      (nombre_completo || nombreFinal).trim(),
      cedLimpia,
      codLimpio,
      (modelo || 'Laptop').trim(),
      (area_default || 'Cobranzas').trim(),
      (cargo || 'Líder de Operaciones').trim(),
      tiene_pase_libre !== undefined ? Number(tiene_pase_libre) : 1
    );

    await registrarAuditoria(
      null, 
      'PERSONAL_AGREGADO', 
      'Sistemas', 
      `Nuevo personal registrado: ${nombre_completo || nombreFinal} - Cargo: ${cargo} - Laptop: ${codLimpio || 'Sin asignar'}`
    );

    res.json({ ok: true, id: r.lastInsertRowid, message: 'Personal agregado correctamente al directorio.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Error al agregar personal al directorio.' });
  }
});

// Actualizar información completa de un líder o funcionario (Sistemas)
app.put('/api/lideres-directorio/:id', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      nombre, 
      nombre_completo, 
      cedula, 
      codigo_maquina, 
      modelo, 
      area_default, 
      cargo, 
      tiene_pase_libre, 
      activo 
    } = req.body;

    const actual = await db.prepare('SELECT * FROM lideres_directorio WHERE id = ?').get(id);
    if (!actual) {
      return res.status(404).json({ ok: false, error: 'Registro no encontrado en el directorio.' });
    }

    const codLimpio = codigo_maquina !== undefined ? codigo_maquina.trim().toUpperCase() : actual.codigo_maquina;
    const cedLimpia = cedula !== undefined ? cedula.trim() : actual.cedula;

    // Si cambia de serie, verificar que no colisione con otro
    if (codLimpio && codLimpio !== actual.codigo_maquina) {
      const duplicadoCod = await db.prepare('SELECT id, nombre, nombre_completo FROM lideres_directorio WHERE UPPER(codigo_maquina) = ? AND id != ?').get(codLimpio, id);
      if (duplicadoCod) {
        return res.status(400).json({ 
          ok: false, 
          error: `El código de máquina [${codLimpio}] ya pertenece a ${duplicadoCod.nombre_completo || duplicadoCod.nombre}.` 
        });
      }
    }

    // Si cambia de cédula, verificar que no colisione
    if (cedLimpia && cedLimpia !== actual.cedula) {
      const duplicadoCed = await db.prepare('SELECT id, nombre, nombre_completo FROM lideres_directorio WHERE cedula = ? AND id != ?').get(cedLimpia, id);
      if (duplicadoCed) {
        return res.status(400).json({ 
          ok: false, 
          error: `La cédula [${cedLimpia}] ya pertenece a ${duplicadoCed.nombre_completo || duplicadoCed.nombre}.` 
        });
      }
    }

    const stmt = db.prepare(`
      UPDATE lideres_directorio 
      SET nombre = COALESCE(?, nombre),
          nombre_completo = COALESCE(?, nombre_completo),
          cedula = COALESCE(?, cedula),
          codigo_maquina = COALESCE(?, codigo_maquina),
          modelo = COALESCE(?, modelo),
          area_default = COALESCE(?, area_default),
          cargo = COALESCE(?, cargo),
          tiene_pase_libre = COALESCE(?, tiene_pase_libre),
          activo = COALESCE(?, activo)
      WHERE id = ?
    `);

    await stmt.run(
      nombre ? nombre.trim() : null,
      nombre_completo ? nombre_completo.trim() : null,
      cedula !== undefined ? cedLimpia : null,
      codigo_maquina !== undefined ? codLimpio : null,
      modelo ? modelo.trim() : null,
      area_default ? area_default.trim() : null,
      cargo ? cargo.trim() : null,
      tiene_pase_libre !== undefined ? Number(tiene_pase_libre) : null,
      activo !== undefined ? Number(activo) : null,
      id
    );

    await registrarAuditoria(
      null, 
      'PERSONAL_ACTUALIZADO', 
      'Sistemas', 
      `Personal ID ${id} (${nombre_completo || actual.nombre_completo || actual.nombre}) actualizado por Sistemas. (Laptop: ${codLimpio || 'N/A'}, Cédula: ${cedLimpia || 'N/A'})`
    );

    res.json({ ok: true, message: 'Datos y equipo actualizados correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Eliminar o desactivar funcionario del directorio (Sistemas)
app.delete('/api/lideres-directorio/:id', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const lider = await db.prepare('SELECT * FROM lideres_directorio WHERE id = ?').get(id);
    if (!lider) {
      return res.status(404).json({ ok: false, error: 'Registro no encontrado.' });
    }

    // Verificar si tiene movimientos registrados en lideres_movimientos
    const movs = await db.prepare('SELECT COUNT(*) as c FROM lideres_movimientos WHERE lider_id = ?').get(id);
    if (movs && movs.c > 0) {
      await db.prepare('UPDATE lideres_directorio SET activo = 0 WHERE id = ?').run(id);
      await registrarAuditoria(null, 'PERSONAL_DESACTIVADO', 'Sistemas', `Personal ID ${id} (${lider.nombre_completo || lider.nombre}) desactivado.`);
      return res.json({ ok: true, message: 'Personal desactivado del directorio oficial (conservando historial de movimientos).' });
    } else {
      await db.prepare('DELETE FROM lideres_directorio WHERE id = ?').run(id);
      await registrarAuditoria(null, 'PERSONAL_ELIMINADO', 'Sistemas', `Personal ID ${id} (${lider.nombre_completo || lider.nombre}) eliminado.`);
      return res.json({ ok: true, message: 'Personal eliminado del directorio oficial.' });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Registrar movimiento libre (Salida o Entrada) de laptop para un Líder en Garita
app.post('/api/garita/lideres/movimiento', async (req, res) => {
  try {
    const { lider_id, codigo_maquina, tipo_movimiento, guardia = 'Guardia Garita', observaciones = '' } = req.body;

    let lider = null;
    if (lider_id) {
      lider = await db.prepare('SELECT * FROM lideres_directorio WHERE id = ?').get(lider_id);
    } else if (codigo_maquina) {
      lider = await db.prepare('SELECT * FROM lideres_directorio WHERE UPPER(codigo_maquina) = ?').get(codigo_maquina.trim().toUpperCase());
    }

    if (!lider) {
      return res.status(404).json({ ok: false, error: 'No se encontró ningún líder registrado con este código de máquina.' });
    }

    // Si no se especificó tipo, alternar según su estado actual
    let tipo = tipo_movimiento;
    if (!tipo) {
      tipo = (lider.estado_ubicacion === 'FUERA') ? 'ENTRADA' : 'SALIDA';
    }

    const nuevoEstado = (tipo === 'SALIDA') ? 'FUERA' : 'EN_PLANTA';
    const now = new Date().toISOString();

    // 1. Guardar en bitácora de movimientos
    const stmtMov = db.prepare(`
      INSERT INTO lideres_movimientos (lider_id, lider_nombre, nombre_completo, codigo_maquina, tipo_movimiento, guardia, fecha_hora, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await stmtMov.run(
      lider.id,
      lider.nombre,
      lider.nombre_completo || lider.nombre,
      lider.codigo_maquina,
      tipo,
      guardia,
      now,
      observaciones
    );

    // 2. Actualizar estado de ubicación en el directorio
    const stmtDir = db.prepare(`
      UPDATE lideres_directorio
      SET estado_ubicacion = ?,
          ultimo_movimiento_en = ?,
          ultimo_movimiento_tipo = ?,
          ultimo_guardia = ?
      WHERE id = ?
    `);
    await stmtDir.run(nuevoEstado, now, tipo, guardia, lider.id);

    // 3. Registrar auditoría
    await registrarAuditoria(
      null,
      `LIDER_${tipo}`,
      guardia,
      `Líder ${lider.nombre_completo || lider.nombre} (${lider.codigo_maquina}) registró ${tipo === 'SALIDA' ? 'SALIDA LIBRE' : 'REINGRESO'} en garita. Estado actual: [${nuevoEstado}].`
    );

    broadcastEvent('LIDER_MOVIMIENTO', {
      lider: lider.nombre_completo || lider.nombre,
      codigo: lider.codigo_maquina,
      tipo,
      estado_ubicacion: nuevoEstado
    });

    res.json({
      ok: true,
      message: `¡${tipo === 'SALIDA' ? 'Salida libre' : 'Reingreso'} registrado con éxito para el líder ${lider.nombre_completo || lider.nombre}!`,
      data: {
        id: lider.id,
        nombre: lider.nombre,
        nombre_completo: lider.nombre_completo,
        codigo_maquina: lider.codigo_maquina,
        modelo: lider.modelo,
        tipo_movimiento: tipo,
        estado_ubicacion: nuevoEstado,
        fecha_hora: now,
        guardia
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Obtener bitácora de movimientos de líderes
app.get('/api/garita/lideres/movimientos', async (req, res) => {
  try {
    const { fecha, lider_id } = req.query;
    let query = 'SELECT * FROM lideres_movimientos WHERE 1=1';
    const params = [];

    if (fecha) {
      query += ' AND fecha_hora LIKE ?';
      params.push(`${fecha}%`);
    } else {
      query += " AND fecha_hora >= datetime('now', '-24 hours')";
    }

    if (lider_id) {
      query += ' AND lider_id = ?';
      params.push(lider_id);
    }

    query += ' ORDER BY id DESC LIMIT 100';

    const movimientos = await db.prepare(query).all(...params);
    const data = movimientos.map(m => ({
      ...m,
      fecha_hora: formatearTimestampEcuador(m.fecha_hora)
    }));
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==========================================
// MÓDULO EXCLUSIVO: ACTIVOS Y PERSONAL DE SISTEMAS / TI
// ==========================================

// Listar activos de Sistemas / TI
app.get('/api/activos-ti', async (req, res) => {
  try {
    const { todos } = req.query;
    let query = 'SELECT * FROM activos_ti WHERE 1=1';
    if (!todos) {
      query += ' AND activo = 1';
    }
    query += ' ORDER BY id ASC';
    const rows = await db.prepare(query).all();
    res.json({ ok: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Crear nuevo activo de Sistemas / TI (Solo admin TI)
app.post('/api/activos-ti', requireRole(['sistemas']), async (req, res) => {
  try {
    const {
      nombre,
      nombre_completo,
      cedula = '',
      codigo_maquina,
      modelo = 'Dell Latitude Corporativa',
      area = 'Sistemas / TI',
      cargo = 'Administrador de Infraestructura & DevOps',
      tipo_pase = 'PASE LIBRE CORPORATIVO TI'
    } = req.body;

    if (!codigo_maquina || !codigo_maquina.trim()) {
      return res.status(400).json({ ok: false, error: 'El código de máquina es obligatorio.' });
    }
    const cod = codigo_maquina.trim().toUpperCase();
    const existe = await db.prepare('SELECT id, nombre, nombre_completo FROM activos_ti WHERE UPPER(codigo_maquina) = ?').get(cod);
    if (existe) {
      return res.status(400).json({ ok: false, error: `El código ${cod} ya está registrado para ${existe.nombre_completo || existe.nombre}.` });
    }

    const r = await db.prepare(`
      INSERT INTO activos_ti (nombre, nombre_completo, cedula, codigo_maquina, modelo, area, cargo, tipo_pase, estado_ubicacion, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EN_PLANTA', 1)
    `).run(
      nombre || 'Personal TI',
      nombre_completo || nombre || 'Personal TI',
      cedula,
      cod,
      modelo,
      area,
      cargo,
      tipo_pase
    );

    await registrarAuditoria(null, 'TI_ACTIVO_CREADO', req.user ? req.user.nombre : 'Sistemas', `Nuevo activo TI registrado: [${cod}] (${nombre_completo || nombre}).`);
    broadcastEvent('ACTIVO_TI_MOVIMIENTO', { codigo: cod });
    res.json({ ok: true, message: 'Activo de Sistemas / TI registrado exitosamente.', id: r.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Registrar movimiento (Salida o Reingreso) de un equipo de Sistemas / TI
app.post('/api/garita/activos-ti/movimiento', async (req, res) => {
  try {
    const { activo_id, codigo_maquina, tipo_movimiento, guardia = 'Guardia Garita', observaciones = '' } = req.body;

    let activo = null;
    if (activo_id) {
      activo = await db.prepare('SELECT * FROM activos_ti WHERE id = ?').get(activo_id);
    } else if (codigo_maquina) {
      activo = await db.prepare('SELECT * FROM activos_ti WHERE UPPER(codigo_maquina) = ?').get(codigo_maquina.trim().toUpperCase());
    }

    if (!activo) {
      return res.status(404).json({ ok: false, error: 'No se encontró ningún equipo de Sistemas/TI con este código.' });
    }

    let tipo = tipo_movimiento;
    if (!tipo) {
      tipo = (activo.estado_ubicacion === 'FUERA') ? 'ENTRADA' : 'SALIDA';
    }

    const nuevoEstado = (tipo === 'SALIDA') ? 'FUERA' : 'EN_PLANTA';
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO activos_ti_movimientos (activo_id, nombre_funcionario, cargo, codigo_maquina, tipo_movimiento, guardia, fecha_hora, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activo.id,
      activo.nombre_completo || activo.nombre,
      activo.cargo || 'Administrador de Sistemas',
      activo.codigo_maquina,
      tipo,
      guardia,
      now,
      observaciones || `Tránsito institucional ${tipo === 'SALIDA' ? 'Salida' : 'Reingreso'}`
    );

    await db.prepare(`
      UPDATE activos_ti
      SET estado_ubicacion = ?,
          ultimo_movimiento_en = ?,
          ultimo_movimiento_tipo = ?,
          ultimo_guardia = ?
      WHERE id = ?
    `).run(nuevoEstado, now, tipo, guardia, activo.id);

    await registrarAuditoria(
      null,
      `TI_${tipo}`,
      guardia,
      `Equipo TI ${activo.codigo_maquina} (${activo.nombre_completo || activo.nombre}) registró ${tipo === 'SALIDA' ? 'SALIDA CORPORATIVA' : 'REINGRESO A PLANTA'}. Estado actual: [${nuevoEstado}].`
    );

    broadcastEvent('ACTIVO_TI_MOVIMIENTO', {
      codigo: activo.codigo_maquina,
      tipo,
      estado_ubicacion: nuevoEstado,
      funcionario: activo.nombre_completo || activo.nombre
    });

    res.json({
      ok: true,
      message: `¡${tipo === 'SALIDA' ? 'Salida corporativa' : 'Reingreso a planta'} registrado con éxito para ${activo.nombre_completo || activo.nombre}!`,
      data: {
        id: activo.id,
        funcionario: activo.nombre_completo || activo.nombre,
        codigo_maquina: activo.codigo_maquina,
        tipo_movimiento: tipo,
        estado_ubicacion: nuevoEstado,
        fecha_hora: now,
        guardia
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Obtener bitácora de movimientos de equipos TI
app.get('/api/activos-ti/movimientos', async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = 'SELECT * FROM activos_ti_movimientos WHERE 1=1';
    const params = [];
    if (fecha) {
      query += ' AND fecha_hora LIKE ?';
      params.push(`${fecha}%`);
    } else {
      query += " AND fecha_hora >= datetime('now', '-24 hours')";
    }
    query += ' ORDER BY id DESC LIMIT 100';
    const rows = await db.prepare(query).all(...params);
    const data = rows.map(m => ({
      ...m,
      fecha_hora: formatearTimestampEcuador(m.fecha_hora)
    }));
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Verificar si una máquina escaneada pertenece al líder indicado
app.post('/api/garita/lideres/verificar-coincidencia', async (req, res) => {
  try {
    const { lider_nombre, codigo_maquina } = req.body;
    if (!lider_nombre || !codigo_maquina) {
      return res.status(400).json({ ok: false, error: 'Líder y código de máquina requeridos.' });
    }

    const lider = await db.prepare('SELECT * FROM lideres_directorio WHERE LOWER(nombre) = LOWER(?) OR LOWER(nombre_completo) = LOWER(?)').get(lider_nombre.trim(), lider_nombre.trim());
    if (!lider) {
      return res.status(404).json({ ok: false, error: 'Líder no encontrado en el directorio.' });
    }

    const normEscaneado = codigo_maquina.trim().toUpperCase();
    const normAsignado = (lider.codigo_maquina || '').trim().toUpperCase();

    if (normEscaneado === normAsignado) {
      return res.json({
        ok: true,
        coincide: true,
        lider,
        message: `Coincidencia verificada: La máquina [${normEscaneado}] le pertenece oficialmente al líder ${lider.nombre_completo || lider.nombre}.`
      });
    } else {
      // Buscar a quién pertenece la máquina escaneada
      const itOwner = await db.prepare('SELECT * FROM activos_ti WHERE UPPER(codigo_maquina) = ?').get(normEscaneado);
      const otroLider = await db.prepare('SELECT * FROM lideres_directorio WHERE UPPER(codigo_maquina) = ?').get(normEscaneado);
      const asesor = await db.prepare('SELECT * FROM solicitudes WHERE UPPER(codigo_maquina) = ? ORDER BY id DESC').get(normEscaneado);

      let dueno = 'No registrada en el sistema';
      if (itOwner) {
        dueno = `Pertenece a Personal de Sistemas / TI: ${itOwner.nombre_completo || itOwner.nombre} (${itOwner.codigo_maquina})`;
      } else if (otroLider) {
        dueno = `Pertenece a otro líder: ${otroLider.nombre_completo || otroLider.nombre}`;
      } else if (asesor) {
        dueno = `Pertenece al asesor: ${asesor.nombres} (Líder: ${asesor.lider_nombre})`;
      }

      return res.json({
        ok: true,
        coincide: false,
        lider,
        codigo_escaneado: normEscaneado,
        codigo_asignado: normAsignado,
        pertenece_a: dueno,
        error: `ALERTA DE SEGURIDAD: La máquina [${normEscaneado}] NO le pertenece al líder ${lider.nombre_completo || lider.nombre}. Su laptop asignada es [${normAsignado || 'Ninguna'}]. (${dueno})`
      });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==========================================
// RUTAS DEL CATÁLOGO DE ASESORES ("MI EQUIPO HABITUAL")
// ==========================================

// Obtener el equipo habitual de un líder con estado en tiempo real
app.get('/api/lider/mi-equipo', async (req, res) => {
  try {
    const { lider_nombre } = req.query;
    if (!lider_nombre || !lider_nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'Nombre de líder requerido.' });
    }

    const today = getFechaLocalEcuador();
    const cleanLider = lider_nombre.trim();
    let asesores;
    if (cleanLider.toLowerCase() === 'ricardo') {
      asesores = await db.prepare(`
        SELECT * FROM asesores_catalogo 
        WHERE (lider_nombre = 'Ricardo' OR UPPER(lider_nombre) LIKE '%RICARDO%') AND activo = 1 
        ORDER BY nombres ASC
      `).all();
    } else {
      asesores = await db.prepare(`
        SELECT * FROM asesores_catalogo 
        WHERE (lider_nombre = ? OR LOWER(lider_nombre) = LOWER(?)) AND activo = 1 
        ORDER BY nombres ASC
      `).all(cleanLider, cleanLider);
    }

    // Anotar cada asesor si ya tiene solicitud hoy o si la laptop o asesor están afuera en teletrabajo
    const resultado = await Promise.all(asesores.map(async a => {
      const solicitudHoy = await db.prepare(`
        SELECT id, estado, fecha_salida 
        FROM solicitudes 
        WHERE cedula = ? AND fecha_salida = ?
        ORDER BY id DESC LIMIT 1
      `).get(a.cedula, today);

      // Verificar si la máquina física o el asesor ya están en teletrabajo (SALIO) sin retornar
      const equipoSalio = await db.prepare(`
        SELECT id, nombres, area, lider_nombre, codigo_maquina, fecha_salida, despachado_en, despachado_por
        FROM solicitudes 
        WHERE (codigo_maquina = ? OR cedula = ?) AND estado = 'SALIO'
        ORDER BY id DESC LIMIT 1
      `).get(a.codigo_maquina, a.cedula);

      return {
        ...a,
        solicitud_hoy: solicitudHoy || null,
        esta_en_teletrabajo: equipoSalio ? true : false,
        teletrabajo_desde: equipoSalio ? equipoSalio.fecha_salida : null,
        teletrabajo_lider: equipoSalio ? equipoSalio.lider_nombre : null,
        teletrabajo_asesor: equipoSalio ? equipoSalio.nombres : null,
        laptop_afuera: equipoSalio ? true : false,
        laptop_afuera_detalle: equipoSalio ? `En teletrabajo con ${equipoSalio.nombres} desde ${equipoSalio.fecha_salida}` : null
      };
    }));

    res.json({ ok: true, data: resultado });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Agregar o editar asesor en el equipo habitual del líder
app.post('/api/lider/mi-equipo', async (req, res) => {
  try {
    const { id, lider_nombre, cedula, nombres, codigo_maquina, modelo, tipo_equipo, area } = req.body;
    if (!lider_nombre || !cedula || !nombres || !codigo_maquina) {
      return res.status(400).json({ ok: false, error: 'Líder, cédula, nombres y código de máquina son obligatorios.' });
    }

    if (id) {
      const stmt = db.prepare(`
        UPDATE asesores_catalogo 
        SET cedula = ?, nombres = ?, codigo_maquina = ?, modelo = ?, tipo_equipo = ?, area = ?
        WHERE id = ? AND lider_nombre = ?
      `);
      await stmt.run(
        cedula.trim(),
        nombres.trim(),
        codigo_maquina.trim().toUpperCase(),
        (modelo || 'DELL').trim().toUpperCase(),
        (tipo_equipo || 'Laptop').trim(),
        (area || 'General').trim(),
        id,
        lider_nombre.trim()
      );
      return res.json({ ok: true, message: 'Asesor actualizado correctamente en su equipo habitual.' });
    }

    await sincronizarAsesorAlCatalogo(lider_nombre, cedula, nombres, codigo_maquina, modelo, tipo_equipo, area);

    res.json({ ok: true, message: 'Asesor guardado en el equipo habitual.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Eliminar asesor del equipo habitual del líder
app.delete('/api/lider/mi-equipo/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.prepare('DELETE FROM asesores_catalogo WHERE id = ?').run(id);
    res.json({ ok: true, message: 'Asesor removido de su equipo habitual.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// AUTORIZAR SALIDA DE ASESORES HABITUALES EN 1 CLIC
app.post('/api/lider/autorizar-lote-habitual', async (req, res) => {
  try {
    const { lider_nombre, asesores_ids, asesores: asesoresDirectos, fecha_salida, fecha_retorno_estimada, observaciones, area } = req.body;

    const userRole = req.headers['x-user-role'] || 'lider';
    const checkHorario = verificarHorarioRecepcionLideres(userRole, observaciones, req.body.es_emergencia);
    if (!checkHorario.permitido) {
      return res.status(403).json({ ok: false, error: checkHorario.error });
    }

    if (!lider_nombre) {
      return res.status(400).json({ ok: false, error: 'El nombre del líder es requerido.' });
    }

    let asesores = [];
    if (Array.isArray(asesores_ids) && asesores_ids.length > 0) {
      const placeholders = asesores_ids.map(() => '?').join(',');
      asesores = await db.prepare(`SELECT * FROM asesores_catalogo WHERE id IN (${placeholders})`).all(...asesores_ids);
    } else if (Array.isArray(asesoresDirectos) && asesoresDirectos.length > 0) {
      asesores = asesoresDirectos;
    } else {
      return res.status(400).json({ ok: false, error: 'Seleccione al menos un asesor de su equipo.' });
    }

    const today = getFechaLocalEcuador();
    const targetFecha = fecha_salida || today;

    const insertStmt = await db.prepare(`
      INSERT INTO solicitudes 
      (cedula, nombres, area, lider_nombre, codigo_maquina, modelo, tipo_equipo, fecha_salida, fecha_retorno_estimada, estado, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
    `);

    let insertados = 0;
    const omitidos = [];

    for (const a of asesores) {
      // Validar si ya está en la calle o tiene solicitud activa hoy
      const disp = await verificarDisponibilidadEquipo(a.codigo_maquina, a.cedula, targetFecha);
      if (!disp.disponible) {
        omitidos.push(`${a.nombres}: ${disp.error}`);
        continue;
      }

      // Validar si ya tiene solicitud ACTIVA para hoy (PENDIENTE, APROBADO o SALIO)
      // Si el equipo ya fue RETORNADO en la mañana, se permite autorizar una nueva salida para el turno tarde/noche
      const yaExisteActivo = await db.prepare("SELECT id, estado FROM solicitudes WHERE cedula = ? AND fecha_salida = ? AND estado IN ('PENDIENTE', 'APROBADO', 'SALIO')").get(a.cedula, targetFecha);
      if (yaExisteActivo) {
        omitidos.push(`${a.nombres}: Ya tiene una solicitud activa en estado [${yaExisteActivo.estado}] para hoy.`);
        continue;
      }

      const r = await insertStmt.run(
        a.cedula,
        a.nombres,
        a.area || 'Operaciones',
        lider_nombre,
        a.codigo_maquina,
        a.modelo || 'DELL',
        a.tipo_equipo || 'Laptop',
        targetFecha,
        fecha_retorno_estimada || targetFecha,
        (observaciones || 'Envío rápido desde Mi Equipo Habitual').trim()
      );

      await registrarAuditoria(r.lastInsertRowid, 'SALIDA_HABITUAL_1CLIC', lider_nombre, `Autorizado desde equipo habitual: ${a.nombres} (${a.codigo_maquina})`);
      insertados++;
    }

    if (insertados === 0) {
      return res.status(400).json({
        ok: false,
        error: `No se pudo autorizar ningún asesor:\n${omitidos.join('\n')}`,
        omitidos
      });
    }

    broadcastEvent('SOLICITUD_CREADA', {
      lider: lider_nombre,
      count: insertados,
      tipo: 'HABITUAL_LOTE'
    });

    res.json({
      ok: true,
      insertados,
      omitidos,
      message: `¡Se enviaron ${insertados} asesores a Sistemas con éxito!${omitidos.length ? ` Omitidos: ${omitidos.length}` : ''}`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Cancelar/Anular una solicitud pendiente propia por parte del Líder (en caso de envío accidental)
app.delete('/api/lider/solicitud/:id/cancelar', async (req, res) => {
  try {
    const { id } = req.params;
    const { lider_nombre } = req.body;

    const sol = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!sol) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    if (sol.estado !== 'PENDIENTE') {
      return res.status(400).json({ 
        ok: false, 
        error: `No se puede cancelar una solicitud en estado [${sol.estado}]. Solo se pueden cancelar solicitudes pendientes antes de que Sistemas las apruebe.` 
      });
    }

    // Si viene líder especificado, comprobar coincidencia
    if (lider_nombre && sol.lider_nombre && sol.lider_nombre.toLowerCase() !== String(lider_nombre).toLowerCase().trim()) {
      return res.status(403).json({ ok: false, error: 'No tiene permiso para cancelar solicitudes de otro líder.' });
    }

    await db.prepare('DELETE FROM solicitudes WHERE id = ?').run(id);
    await registrarAuditoria(id, 'CANCELADA_POR_LIDER', lider_nombre || sol.lider_nombre, `El líder canceló el envío accidental a teletrabajo de: ${sol.nombres} (${sol.codigo_maquina})`);

    broadcastEvent('SOLICITUD_CANCELADA', {
      id: sol.id,
      lider: sol.lider_nombre,
      nombres: sol.nombres,
      codigo: sol.codigo_maquina
    });

    res.json({ ok: true, message: `Solicitud de ${sol.nombres} cancelada. El asesor vuelve a estar disponible en su nómina habitual.` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 1. Obtener Áreas
app.get('/api/areas', async (req, res) => {
  try {
    const areas = await db.prepare('SELECT * FROM areas ORDER BY nombre ASC').all();
    res.json({ ok: true, data: areas });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 2. Obtener Lista de Líderes Registrados
app.get('/api/lideres', async (req, res) => {
  try {
    const lideres = await db.prepare(`
      SELECT DISTINCT lider_nombre as nombre, area 
      FROM solicitudes 
      WHERE lider_nombre IS NOT NULL AND lider_nombre != ''
      ORDER BY lider_nombre ASC
    `).all();
    res.json({ ok: true, data: lideres });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 3. Obtener Solicitudes con Filtros
app.get('/api/solicitudes', async (req, res) => {
  try {
    const { fecha, area, estado, search, lider } = req.query;
    let query = 'SELECT * FROM solicitudes WHERE 1=1';
    const params = [];

    if (fecha) {
      if (estado === 'PENDIENTE') {
        query += " AND (fecha_salida = ? OR estado = 'PENDIENTE' OR created_at >= datetime('now', '-48 hours'))";
        params.push(fecha);
      } else if (lider && lider !== 'TODOS') {
        query += " AND (fecha_salida = ? OR estado = 'SALIO' OR created_at >= datetime('now', '-24 hours'))";
        params.push(fecha);
      } else {
        query += ' AND (fecha_salida = ? OR created_at >= datetime(\'now\', \'-24 hours\'))';
        params.push(fecha);
      }
    }
    if (area && area !== 'TODAS') {
      query += ' AND area = ?';
      params.push(area);
    }
    if (lider && lider !== 'TODOS') {
      const lidClean = lider.trim();
      if (lidClean.toLowerCase() === 'ricardo') {
        query += " AND (lider_nombre = 'Ricardo' OR UPPER(lider_nombre) LIKE '%RICARDO%')";
      } else {
        query += ' AND (lider_nombre = ? OR LOWER(lider_nombre) = LOWER(?))';
        params.push(lidClean, lidClean);
      }
    }
    if (estado && estado !== 'TODOS') {
      query += ' AND estado = ?';
      params.push(estado);
    }
    if (search && search.trim()) {
      query += ' AND (cedula LIKE ? OR nombres LIKE ? OR codigo_maquina LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    query += ' ORDER BY id DESC';

    const solicitudes = await db.prepare(query).all(...params);
    res.json({ ok: true, data: solicitudes });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 4. Crear Solicitud Individual (Portal Líder) con Validación Anti-Duplicados
app.post('/api/solicitudes', async (req, res) => {
  try {
    const {
      cedula,
      nombres,
      area,
      lider_nombre,
      codigo_maquina,
      modelo,
      tipo_equipo,
      fecha_salida,
      fecha_retorno_estimada,
      observaciones
    } = req.body;

    const today = getFechaLocalEcuador();
    const userRole = req.headers['x-user-role'] || 'lider';
    const checkHorario = verificarHorarioRecepcionLideres(userRole, observaciones, req.body.es_emergencia);
    if (!checkHorario.permitido) {
      return res.status(403).json({ ok: false, error: checkHorario.error });
    }

    // Para líderes, la fecha de salida siempre es el día de hoy (no agendamiento a futuro)
    const fechaSalidaFinal = (userRole === 'sistemas' && fecha_salida) ? fecha_salida : today;
    const fechaRetornoFinal = fecha_retorno_estimada || fechaSalidaFinal;

    if (!cedula || !nombres || !area || !codigo_maquina) {
      return res.status(400).json({
        ok: false,
        error: 'Cédula, Nombres, Área y Código de Máquina son obligatorios.'
      });
    }

    // Comprobación anti-duplicados (si la máquina o la persona ya están fuera o ya tienen solicitud activa hoy)
    const disp = await verificarDisponibilidadEquipo(codigo_maquina, cedula, fechaSalidaFinal);
    if (!disp.disponible) {
      return res.status(400).json({ ok: false, error: disp.error });
    }

    const stmt = await db.prepare(`
      INSERT INTO solicitudes 
      (cedula, nombres, area, lider_nombre, codigo_maquina, modelo, tipo_equipo, fecha_salida, fecha_retorno_estimada, estado, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
    `);

    const result = await stmt.run(
      cedula.trim(),
      nombres.trim(),
      area.trim(),
      (lider_nombre || '').trim(),
      codigo_maquina.trim().toUpperCase(),
      (modelo || 'DELL').trim().toUpperCase(),
      (tipo_equipo || 'Laptop').trim(),
      fechaSalidaFinal,
      fechaRetornoFinal,
      (observaciones || '').trim()
    );

    await registrarAuditoria(
      result.lastInsertRowid,
      'CREADA',
      lider_nombre || 'Líder',
      `Solicitud creada para ${nombres.trim()} con equipo ${codigo_maquina.trim().toUpperCase()} (${modelo || 'DELL'})`
    );

    // Auto-sincronizar al catálogo del líder para reutilización futura
    if (lider_nombre && lider_nombre.trim()) {
      await sincronizarAsesorAlCatalogo(
        lider_nombre.trim(),
        cedula.trim(),
        nombres.trim(),
        codigo_maquina.trim().toUpperCase(),
        (modelo || 'DELL').trim().toUpperCase(),
        (tipo_equipo || 'Laptop').trim(),
        area.trim()
      );
    }

    broadcastEvent('SOLICITUD_CREADA', {
      id: result.lastInsertRowid,
      lider: (lider_nombre || '').trim(),
      nombres: nombres.trim(),
      codigo: codigo_maquina.trim().toUpperCase(),
      count: 1
    });

    res.json({ ok: true, id: result.lastInsertRowid, message: 'Solicitud registrada exitosamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 5. Carga Masiva desde Excel / CSV (Portal Líder) con Validación Anti-Duplicados
app.post('/api/solicitudes/bulk-excel', upload.single('archivo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se subió ningún archivo.' });
  }

  const lider_default = (req.body.lider_nombre || '').trim();
  const userRole = req.headers['x-user-role'] || 'lider';
  const filePath = req.file.path;

  const checkHorario = verificarHorarioRecepcionLideres(userRole);
  if (!checkHorario.permitido) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(403).json({ ok: false, error: checkHorario.error });
  }

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows || rows.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ ok: false, error: 'El archivo está vacío o no tiene el formato correcto.' });
    }

    // Cargar directorio oficial de líderes para normalización inteligente
    const directorioLideres = await db.prepare("SELECT nombre FROM lideres_directorio WHERE activo = 1").all();

    const insertStmt = db.prepare(`
      INSERT INTO solicitudes 
      (cedula, nombres, area, lider_nombre, codigo_maquina, modelo, tipo_equipo, fecha_salida, fecha_retorno_estimada, estado, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
    `);

    let insertados = 0;
    const errores = [];
    const today = getFechaLocalEcuador();

    for (const row of rows) {
      const cedula = String(row['Cédula'] || row['Cedula'] || row['CEDULA'] || row['cedula'] || '').trim();
      const nombres = String(row['Nombres'] || row['Nombre'] || row['NOMBRES'] || row['Apellidos y Nombres'] || '').trim();
      const area = String(row['Área'] || row['Area'] || row['AREA'] || row['Campaña'] || req.body.area || 'Campañas').trim();
      const codigo = String(row['Código Máquina'] || row['Codigo Maquina'] || row['Serie'] || row['N° de Serie'] || row['CODIGO'] || row['Equipo'] || '').trim().toUpperCase();
      const modelo = String(row['Modelo'] || row['MODELO'] || row['Marca'] || 'DELL').trim().toUpperCase();
      const tipo = String(row['Tipo de Equipo'] || row['Tipo'] || 'Laptop').trim();
      
      // Para líderes, la fecha de salida siempre corresponde al día de hoy para evitar errores de arrastre en celdas de Excel
      let fechaSalida = today;
      if (userRole === 'sistemas') {
        fechaSalida = normalizarFechaExcel(row['Fecha Salida'] || row['Fecha'], today);
      }
      const fechaRetorno = normalizarFechaExcel(row['Fecha Retorno'], fechaSalida);
      const obs = String(row['Observaciones'] || row['Obs'] || '').trim();

      // Normalización inteligente: el líder dueño siempre se asigna con su nombre oficial
      let lider = lider_default;
      if (!lider || userRole === 'sistemas') {
        const rawLider = String(row['Líder'] || row['Lider'] || lider_default || 'Líder de Área').trim();
        lider = resolverNombreLiderOficial(rawLider, directorioLideres);
      } else {
        lider = resolverNombreLiderOficial(lider, directorioLideres);
      }

      if (cedula && nombres && codigo) {
        // Verificar disponibilidad anti-duplicados estricta
        const disp = await verificarDisponibilidadEquipo(codigo, cedula, fechaSalida);
        if (!disp.disponible) {
          errores.push(`${nombres} (${codigo}): ${disp.error}`);
          continue;
        }

        const r = await insertStmt.run(
          cedula,
          nombres,
          area,
          lider,
          codigo,
          modelo,
          tipo,
          fechaSalida,
          fechaRetorno,
          obs
        );
        await registrarAuditoria(r.lastInsertRowid, 'CREADA_MASIVA', lider, `Carga masiva: ${nombres} (${codigo})`);
        
        // Auto-guardar en el catálogo habitual del líder
        await sincronizarAsesorAlCatalogo(lider, cedula, nombres, codigo, modelo, tipo, area);
        
        insertados++;
      }
    }

    fs.unlinkSync(filePath);

    if (insertados > 0) {
      broadcastEvent('SOLICITUD_CREADA', {
        lider: lider_default || 'Excel',
        count: insertados,
        tipo: 'EXCEL'
      });
    }

    res.json({
      ok: true,
      insertados,
      totalFilas: rows.length,
      errores,
      message: `Se importaron ${insertados} registros correctamente.${errores.length ? ` Se omitieron ${errores.length} por estar ya en teletrabajo.` : ''}`
    });
  } catch (error) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ ok: false, error: 'Error al procesar archivo Excel: ' + error.message });
  }
});

// 6. Descargar Plantilla Oficial Excel para Líderes (Con columna Modelo)
app.get('/api/plantilla-excel', async (req, res) => {
  try {
    const today = getFechaLocalEcuador();
    const liderNombre = req.query.lider || 'Mi Nombre de Líder';
    const areaNombre = req.query.area || 'Campañas';
    const templateData = [
      {
        'Cédula': '1725665127',
        'Nombres': 'ANRANGO COLLAGUAZO JENNIFER ETELVINA',
        'Área': areaNombre,
        'Código Máquina': 'D6QHM72',
        'Modelo': 'DELL',
        'Tipo de Equipo': 'Laptop',
        'Fecha Salida': today,
        'Fecha Retorno': today,
        'Líder': liderNombre,
        'Observaciones': 'Turno teletrabajo tarde'
      },
      {
        'Cédula': '1729875596',
        'Nombres': 'ASTUDILLO DE LA CRUZ JONATHAN MIGUEL',
        'Área': areaNombre,
        'Código Máquina': 'FRV8282',
        'Modelo': 'DELL',
        'Tipo de Equipo': 'Laptop',
        'Fecha Salida': today,
        'Fecha Retorno': today,
        'Líder': liderNombre,
        'Observaciones': 'Campaña fin de mes'
      }
    ];

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(templateData);
    xlsx.utils.book_append_sheet(wb, ws, 'Plantilla_Salidas');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Plantilla_Autorizacion_Salidas.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 7. Aprobar Solicitud Individual (Sistemas)
app.patch('/api/solicitudes/:id/aprobar', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const { aprobado_por = 'Sistemas' } = req.body;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET estado = 'APROBADO', aprobado_por = ?, aprobado_en = ? 
      WHERE id = ?
    `);
    const result = await stmt.run(aprobado_por, now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    const sol = await db.prepare('SELECT lider_nombre, nombres, codigo_maquina, modelo FROM solicitudes WHERE id = ?').get(id);
    const detalleAprob = `Autorizado formalmente por ${aprobado_por}. Asesor: ${sol ? sol.nombres : 'N/A'}, Laptop: ${sol ? sol.codigo_maquina : 'N/A'} (${sol ? (sol.modelo || 'DELL') : ''}), Líder: ${sol ? sol.lider_nombre : 'N/A'}`;
    await registrarAuditoria(id, 'APROBADA', aprobado_por, detalleAprob);

    broadcastEvent('SOLICITUD_APROBADA', {
      id: parseInt(id),
      lider: sol ? sol.lider_nombre : '',
      nombres: sol ? sol.nombres : '',
      codigo: sol ? sol.codigo_maquina : '',
      aprobado_por
    });

    res.json({ ok: true, message: 'Solicitud aprobada correctamente.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8. Rechazar Solicitud Individual (Sistemas)
app.patch('/api/solicitudes/:id/rechazar', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rechazo = 'No autorizado por Sistemas', aprobado_por = 'Sistemas' } = req.body;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET estado = 'RECHAZADO', motivo_rechazo = ?, aprobado_por = ?, aprobado_en = ? 
      WHERE id = ?
    `);
    const result = await stmt.run(motivo_rechazo, aprobado_por, now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    const sol = await db.prepare('SELECT lider_nombre, nombres, codigo_maquina, modelo FROM solicitudes WHERE id = ?').get(id);
    const detalleRech = `Rechazada por ${aprobado_por}. Asesor: ${sol ? sol.nombres : 'N/A'}, Laptop: ${sol ? sol.codigo_maquina : 'N/A'}, Líder: ${sol ? sol.lider_nombre : 'N/A'}. Motivo: ${motivo_rechazo}`;
    await registrarAuditoria(id, 'RECHAZADA', aprobado_por, detalleRech);

    broadcastEvent('SOLICITUD_RECHAZADA', {
      id: parseInt(id),
      lider: sol ? sol.lider_nombre : '',
      nombres: sol ? sol.nombres : '',
      codigo: sol ? sol.codigo_maquina : '',
      motivo: motivo_rechazo,
      aprobado_por
    });

    res.json({ ok: true, message: 'Solicitud rechazada.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8.1. Anular / Quitar Solicitud que no llegó a salir (Sistemas)
app.patch('/api/solicitudes/:id/anular', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo = 'Asesor desistió / No retiró el equipo al final del día', operador = 'Sistemas' } = req.body;

    const solicitud = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!solicitud) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    if (solicitud.estado === 'SALIO') {
      return res.status(400).json({
        ok: false,
        error: 'El equipo ya fue registrado como SALIDO en garita. Si ya regresó, use la opción de Retorno.'
      });
    }

    const obsFinal = `${solicitud.observaciones ? solicitud.observaciones + ' | ' : ''}ANULADO: ${motivo}`;
    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET estado = 'NO_SALIO', observaciones = ? 
      WHERE id = ?
    `);
    await stmt.run(obsFinal, id);

    await registrarAuditoria(id, 'ANULADA_NO_SALIO', operador, `Salida anulada para ${solicitud.nombres} (${solicitud.codigo_maquina}). Motivo: ${motivo}`);

    broadcastEvent('SOLICITUD_ANULADA', {
      id: parseInt(id),
      nombres: solicitud.nombres,
      codigo: solicitud.codigo_maquina,
      lider: solicitud.lider_nombre,
      operador
    });

    res.json({
      ok: true,
      message: `Solicitud de ${solicitud.nombres} quitada correctamente (Marcada como No Salió). La máquina ${solicitud.codigo_maquina} queda liberada.`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8.2. Eliminar completamente solicitud si Sistemas lo desea
app.delete('/api/solicitudes/:id', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const solicitud = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!solicitud) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    if (solicitud.estado === 'SALIO') {
      return res.status(400).json({
        ok: false,
        error: 'No se puede eliminar una solicitud con equipo actualmente en la calle. Debe retornar primero.'
      });
    }

    await db.prepare('DELETE FROM solicitudes WHERE id = ?').run(id);
    await registrarAuditoria(id, 'ELIMINADA', 'Sistemas', `Solicitud eliminada de la base de datos: ${solicitud.nombres} (${solicitud.codigo_maquina})`);

    res.json({ ok: true, message: 'Registro eliminado del sistema.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8.2. Edición Completa de Solicitud (Sistemas Super Admin)
app.put('/api/solicitudes/:id', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      cedula,
      nombres,
      area,
      lider_nombre,
      codigo_maquina,
      modelo,
      tipo_equipo,
      fecha_salida,
      fecha_retorno_estimada,
      estado,
      observaciones
    } = req.body;

    const actual = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!actual) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    const stmt = db.prepare(`
      UPDATE solicitudes
      SET cedula = COALESCE(?, cedula),
          nombres = COALESCE(?, nombres),
          area = COALESCE(?, area),
          lider_nombre = COALESCE(?, lider_nombre),
          codigo_maquina = COALESCE(?, codigo_maquina),
          modelo = COALESCE(?, modelo),
          tipo_equipo = COALESCE(?, tipo_equipo),
          fecha_salida = COALESCE(?, fecha_salida),
          fecha_retorno_estimada = COALESCE(?, fecha_retorno_estimada),
          estado = COALESCE(?, estado),
          observaciones = COALESCE(?, observaciones)
      WHERE id = ?
    `);

    await stmt.run(
      cedula ? cedula.trim() : null,
      nombres ? nombres.trim() : null,
      area ? area.trim() : null,
      lider_nombre ? lider_nombre.trim() : null,
      codigo_maquina ? codigo_maquina.trim().toUpperCase() : null,
      modelo ? modelo.trim().toUpperCase() : null,
      tipo_equipo ? tipo_equipo.trim() : null,
      fecha_salida || null,
      fecha_retorno_estimada || null,
      estado || null,
      observaciones !== undefined ? observaciones.trim() : null,
      id
    );

    await registrarAuditoria(
      id,
      'EDITADA_POR_SISTEMAS',
      'Sistemas',
      `Solicitud #${id} modificada por Sistemas. (Asesor: ${nombres || actual.nombres}, Serie: ${codigo_maquina || actual.codigo_maquina}, Cédula: ${cedula || actual.cedula})`
    );

    res.json({ ok: true, message: 'Solicitud actualizada correctamente por Sistemas.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8.2.1. Corregir Fecha de Salida al Día de Hoy en 1 Clic (Sistemas)
app.patch('/api/solicitudes/:id/cambiar-fecha-hoy', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const today = getFechaLocalEcuador();
    const sol = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!sol) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    const fechaAnt = sol.fecha_salida;
    await db.prepare('UPDATE solicitudes SET fecha_salida = ? WHERE id = ?').run(today, id);
    await registrarAuditoria(
      id,
      'FECHA_CORREGIDA',
      'Sistemas',
      `Fecha de salida corregida de ${fechaAnt} a hoy (${today}) para que Garita pueda despachar.`
    );

    if (sol.estado === 'APROBADO') {
      broadcastEvent('SOLICITUD_APROBADA', {
        id: sol.id,
        asesor: sol.nombres,
        lider: sol.lider_nombre,
        codigo: sol.codigo_maquina,
        fecha: today
      });
    } else {
      broadcastEvent('SOLICITUD_CREADA', {
        id: sol.id,
        asesor: sol.nombres,
        lider: sol.lider_nombre,
        codigo: sol.codigo_maquina,
        fecha: today
      });
    }

    res.json({
      ok: true,
      message: `Fecha cambiada con éxito de ${fechaAnt} a hoy (${today}). El equipo ya está visible en Garita.`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 8.3. Depuración Masiva al Final del Día (Quitar solo aprobados antiguos que no salieron)
app.post('/api/solicitudes/depurar-no-salidos', requireRole(['sistemas']), async (req, res) => {
  try {
    const { fecha, operador = 'Sistemas', forzar_recientes = false } = req.body;
    const today = getFechaLocalEcuador();
    const targetFecha = fecha || today;

    // NUNCA tocar solicitudes en estado PENDIENTE (los pendientes esperan revisión de Sistemas, no son abandono en garita)
    // Para la fecha de hoy, SOLO depurar solicitudes aprobadas con más de 3 horas de antigüedad, para evitar anular autorizaciones recién emitidas
    let query = `
      UPDATE solicitudes 
      SET estado = 'NO_SALIO', 
          observaciones = CASE 
            WHEN observaciones IS NULL OR observaciones = '' THEN 'ANULADO AL CIERRE DE TURNO: No retiró el equipo en garita'
            ELSE observaciones || ' | ANULADO AL CIERRE DE TURNO'
          END
      WHERE fecha_salida = ? AND estado = 'APROBADO'
    `;
    const params = [targetFecha];

    if (targetFecha === today && !forzar_recientes) {
      query += " AND (aprobado_en <= datetime('now', '-3 hours') OR (aprobado_en IS NULL AND created_at <= datetime('now', '-3 hours')))";
    }

    const stmt = db.prepare(query);
    const result = await stmt.run(...params);
    const count = result.changes;

    await registrarAuditoria(null, 'DEPURACION_CIERRE_TURNO', operador, `Se anularon ${count} solicitudes aprobadas no retiradas en la fecha ${targetFecha}`);

    broadcastEvent('TURNO_DEPURADO', { count, targetFecha });

    res.json({
      ok: true,
      depurados: count,
      message: `Se limpiaron ${count} solicitudes aprobadas no retiradas de la fecha ${targetFecha}. Las autorizaciones recientes (<3 horas) no fueron afectadas.`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 9. Aprobación Masiva en 1 Clic (Sistemas)
app.post('/api/solicitudes/aprobar-lote', requireRole(['sistemas']), async (req, res) => {
  try {
    const { ids, fecha, area, lider, aprobado_por = 'Sistemas' } = req.body;
    const now = new Date().toISOString();

    let count = 0;
    if (Array.isArray(ids) && ids.length > 0) {
      const stmt = db.prepare(`
        UPDATE solicitudes 
        SET estado = 'APROBADO', aprobado_por = ?, aprobado_en = ? 
        WHERE id = ? AND estado = 'PENDIENTE'
      `);
      for (const id of ids) {
        const sol = await db.prepare('SELECT lider_nombre, nombres, codigo_maquina, modelo FROM solicitudes WHERE id = ?').get(id);
        const r = await stmt.run(aprobado_por, now, id);
        if (r.changes > 0) {
          const det = `Aprobación en lote por ${aprobado_por}. Asesor: ${sol ? sol.nombres : 'ID ' + id}, Laptop: ${sol ? sol.codigo_maquina : 'N/A'}, Líder: ${sol ? sol.lider_nombre : 'N/A'}`;
          await registrarAuditoria(id, 'APROBADA_LOTE', aprobado_por, det);
          count++;
        }
      }
    } else if (fecha) {
      let query = "UPDATE solicitudes SET estado = 'APROBADO', aprobado_por = ?, aprobado_en = ? WHERE fecha_salida = ? AND estado = 'PENDIENTE'";
      const params = [aprobado_por, now, fecha];
      if (area && area !== 'TODAS') {
        query += ' AND area = ?';
        params.push(area);
      }
      if (lider && lider !== 'TODOS') {
        query += ' AND lider_nombre = ?';
        params.push(lider);
      }
      const stmt = db.prepare(query);
      const r = await stmt.run(...params);
      count = r.changes;
      await registrarAuditoria(null, 'APROBACION_GLOBAL', aprobado_por, `Aprobadas ${count} solicitudes para ${fecha} (${area || 'Todas'} - ${lider || 'Todos'})`);
    }

    broadcastEvent('SOLICITUD_APROBADA', {
      count,
      ids: Array.isArray(ids) ? ids : [],
      lider: lider || '',
      aprobado_por
    });

    res.json({ ok: true, count, message: `Se aprobaron exitosamente ${count} solicitudes.` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 9.2. Rechazo Masivo en Lote o por Selección (Sistemas)
app.post('/api/solicitudes/rechazar-lote', requireRole(['sistemas']), async (req, res) => {
  try {
    const { ids, fecha, area, lider, motivo_rechazo = 'Rechazado en lote por Sistemas', aprobado_por = 'Sistemas' } = req.body;
    const now = new Date().toISOString();

    let count = 0;
    if (Array.isArray(ids) && ids.length > 0) {
      const stmt = db.prepare(`
        UPDATE solicitudes 
        SET estado = 'RECHAZADO', motivo_rechazo = ?, aprobado_por = ?, aprobado_en = ? 
        WHERE id = ? AND estado IN ('PENDIENTE', 'APROBADO')
      `);
      for (const id of ids) {
        const sol = await db.prepare('SELECT lider_nombre, nombres, codigo_maquina, modelo FROM solicitudes WHERE id = ?').get(id);
        const r = await stmt.run(motivo_rechazo, aprobado_por, now, id);
        if (r.changes > 0) {
          const det = `Rechazo en lote por ${aprobado_por}. Asesor: ${sol ? sol.nombres : 'ID ' + id}, Laptop: ${sol ? sol.codigo_maquina : 'N/A'}, Líder: ${sol ? sol.lider_nombre : 'N/A'}. Motivo: ${motivo_rechazo}`;
          await registrarAuditoria(id, 'RECHAZADA_LOTE', aprobado_por, det);
          count++;
        }
      }
    } else if (fecha) {
      let query = "UPDATE solicitudes SET estado = 'RECHAZADO', motivo_rechazo = ?, aprobado_por = ?, aprobado_en = ? WHERE fecha_salida = ? AND estado = 'PENDIENTE'";
      const params = [motivo_rechazo, aprobado_por, now, fecha];
      if (area && area !== 'TODAS') {
        query += ' AND area = ?';
        params.push(area);
      }
      if (lider && lider !== 'TODOS') {
        query += ' AND lider_nombre = ?';
        params.push(lider);
      }
      const stmt = db.prepare(query);
      const r = await stmt.run(...params);
      count = r.changes;
      await registrarAuditoria(null, 'RECHAZO_GLOBAL', aprobado_por, `Rechazadas ${count} solicitudes para ${fecha} (${area || 'Todas'} - ${lider || 'Todos'}). Motivo: ${motivo_rechazo}`);
    }

    broadcastEvent('SOLICITUD_RECHAZADA', {
      count,
      ids: Array.isArray(ids) ? ids : [],
      lider: lider || '',
      motivo: motivo_rechazo,
      aprobado_por
    });

    res.json({ ok: true, count, message: `Se rechazaron exitosamente ${count} solicitudes.` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 10. REEMPLAZO O CAMBIO DE EQUIPO POR AVERÍA / HARDWARE (Sistemas)
app.patch('/api/solicitudes/:id/cambiar-equipo', requireRole(['sistemas']), async (req, res) => {
  try {
    const { id } = req.params;
    const { nuevo_codigo, nuevo_modelo, motivo, operador = 'Sistemas' } = req.body;

    if (!nuevo_codigo || !nuevo_codigo.trim()) {
      return res.status(400).json({ ok: false, error: 'Debe ingresar el nuevo código de máquina.' });
    }

    const solicitud = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    if (!solicitud) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    const codAnterior = solicitud.codigo_maquina;
    const codNuevo = nuevo_codigo.trim().toUpperCase();
    const modNuevo = (nuevo_modelo || solicitud.modelo || 'DELL').trim().toUpperCase();

    // Comprobar que el nuevo equipo no esté en posesión de otra persona en la calle
    const disp = await verificarDisponibilidadEquipo(codNuevo, solicitud.cedula, id);
    if (!disp.disponible) {
      return res.status(400).json({ ok: false, error: disp.error });
    }

    const obsActualizada = `${solicitud.observaciones ? solicitud.observaciones + ' | ' : ''}Reemplazo de equipo: ${codAnterior} -> ${codNuevo} (${motivo || 'Cambio técnico'})`;

    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET codigo_maquina = ?, modelo = ?, codigo_maquina_anterior = ?, motivo_cambio_equipo = ?, observaciones = ?
      WHERE id = ?
    `);
    await stmt.run(codNuevo, modNuevo, codAnterior, motivo || 'Cambio por Sistemas', obsActualizada, id);

    await registrarAuditoria(
      id,
      'CAMBIO_EQUIPO',
      operador,
      `Equipo cambiado de [${codAnterior}] a [${codNuevo}] para el asesor ${solicitud.nombres}. Motivo: ${motivo || 'Soporte TI'}`
    );

    res.json({
      ok: true,
      message: `Equipo cambiado exitosamente a ${codNuevo}`,
      codigo_anterior: codAnterior,
      codigo_nuevo: codNuevo
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 11. Búsqueda Rápida para Garita (Por Cédula o Código de Máquina)
app.get('/api/garita/buscar', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ ok: false, error: 'Ingrese cédula o código a buscar.' });
    }

    const term = q.trim();
    const today = getFechaLocalEcuador();

    // 0. Verificar si el término coincide con equipo corporativo de Sistemas / TI (Infraestructura)
    const itMatch = await db.prepare(`
      SELECT * FROM activos_ti 
      WHERE (UPPER(codigo_maquina) = ? OR LOWER(nombre) = LOWER(?) OR LOWER(nombre_completo) = LOWER(?) OR cedula = ?) AND activo = 1
    `).get(term.toUpperCase(), term, term, term);

    if (itMatch) {
      return res.json({
        ok: true,
        encontrado: true,
        es_ti: true,
        activo_ti: itMatch
      });
    }

    // 1. Verificar si el término coincide con la laptop asignada a un Líder oficial o personal autorizado
    const liderMatch = await db.prepare(`
      SELECT * FROM lideres_directorio 
      WHERE (UPPER(codigo_maquina) = ? OR LOWER(nombre) = LOWER(?) OR LOWER(nombre_completo) = LOWER(?) OR cedula = ?) AND activo = 1
    `).get(term.toUpperCase(), term, term, term);

    if (liderMatch) {
      return res.json({
        ok: true,
        encontrado: true,
        es_lider: true,
        lider: liderMatch
      });
    }

    // 2. Buscar coincidencia en solicitudes de asesores priorizando coincidencias exactas y estado APROBADO de hoy
    const rows = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE (cedula = ? OR codigo_maquina = ? OR cedula LIKE ? OR codigo_maquina LIKE ?)
      ORDER BY 
        CASE 
          WHEN (cedula = ? OR codigo_maquina = ?) AND fecha_salida = ? AND estado = 'APROBADO' THEN 1
          WHEN (cedula = ? OR codigo_maquina = ?) AND fecha_salida = ? AND estado = 'SALIO' THEN 2
          WHEN (cedula = ? OR codigo_maquina = ?) AND fecha_salida = ? THEN 3
          WHEN (cedula = ? OR codigo_maquina = ?) THEN 4
          WHEN fecha_salida = ? AND estado = 'APROBADO' THEN 5
          WHEN fecha_salida = ? THEN 6
          ELSE 7 
        END,
        id DESC
      LIMIT 10
    `).all(
      term, term.toUpperCase(), `%${term}%`, `%${term.toUpperCase()}%`,
      term, term.toUpperCase(), today,
      term, term.toUpperCase(), today,
      term, term.toUpperCase(), today,
      term, term.toUpperCase(),
      today,
      today
    );

    if (rows.length === 0) {
      return res.json({ ok: true, encontrado: false, data: [] });
    }

    res.json({ ok: true, encontrado: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 11.1 Laptops Autorizadas por Sistemas Pendientes de Retiro/Despacho en Garita
app.get('/api/garita/pendientes-despacho', async (req, res) => {
  try {
    const today = getFechaLocalEcuador();
    const fecha = req.query.fecha || today;

    // Obtener todas las solicitudes autorizadas que esperan despacho para la fecha (o anteriores aún no despachadas)
    const rows = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE estado = 'APROBADO' AND (fecha_salida = ? OR fecha_salida <= ?)
      ORDER BY fecha_salida DESC, area ASC, nombres ASC
    `).all(fecha, today);

    res.json({ ok: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 11.2 Salidas Despachadas en este Turno para Garita (con ventana de 24 horas y orden cronológico)
app.get('/api/garita/despachos-turno', async (req, res) => {
  try {
    const today = getFechaLocalEcuador();
    const queryFecha = req.query.fecha || today;

    const rows = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE (fecha_salida = ? OR (despachado_en IS NOT NULL AND despachado_en >= datetime('now', '-24 hours')))
        AND estado IN ('SALIO', 'RETORNADO')
      ORDER BY 
        CASE WHEN despachado_en IS NOT NULL THEN despachado_en ELSE created_at END DESC,
        id DESC
    `).all(queryFecha);

    res.json({ ok: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 12. DESPACHO EN GARITA (FLUJO DIRECTO "ANTI-TONTOS" EN 1 PASO)
// El guardia solo escanea con la pistola y presiona Confirmar Salida
app.post('/api/garita/despachar', requireRole(['garita', 'sistemas']), async (req, res) => {
  try {
    const { id, guardia_nombre = 'Guardia Garita', digitos_verificacion } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'ID de solicitud requerido.' });
    }

    const solicitud = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);

    if (!solicitud) {
      return res.status(404).json({ ok: false, error: 'Registro no encontrado en el sistema.' });
    }

    if (solicitud.estado !== 'APROBADO') {
      return res.status(400).json({
        ok: false,
        error: `La solicitud no puede despacharse porque su estado actual es: ${solicitud.estado}. Debe estar APROBADA por Sistemas.`
      });
    }

    // Si se enviaron dígitos para verificación opcional, comprobarlos; si no, permitir confirmación directa
    if (digitos_verificacion && digitos_verificacion.trim()) {
      const codigoReg = solicitud.codigo_maquina.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const digitosIng = digitos_verificacion.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      if (!codigoReg.endsWith(digitosIng) && codigoReg !== digitosIng) {
        await registrarAuditoria(
          id,
          'FALLO_SEGURIDAD_GARITA',
          guardia_nombre,
          `Error de serie en garita. Esperado: ...${codigoReg.slice(-4)}, ingresado: ${digitosIng}`
        );
        return res.status(400).json({
          ok: false,
          error: 'FALLO DE SEGURIDAD: Los dígitos ingresados no coinciden con la máquina física autorizada.'
        });
      }
    }

    const now = new Date().toISOString();
    const updateStmt = await db.prepare(`
      UPDATE solicitudes 
      SET estado = 'SALIO', despachado_por = ?, despachado_en = ? 
      WHERE id = ?
    `);
    await updateStmt.run(guardia_nombre, now, id);

    await registrarAuditoria(
      id,
      'SALIDA_CONFIRMADA',
      guardia_nombre,
      `Salida registrada exitosamente. Asesor: ${solicitud.nombres}, Equipo: ${solicitud.codigo_maquina} (${solicitud.modelo})`
    );

    broadcastEvent('EQUIPO_DESPACHADO', {
      id: solicitud.id,
      nombres: solicitud.nombres,
      codigo: solicitud.codigo_maquina,
      lider: solicitud.lider_nombre,
      guardia: guardia_nombre,
      hora: now
    });

    res.json({
      ok: true,
      message: '¡Salida confirmada y registrada en el sistema!',
      asesor: solicitud.nombres,
      codigo_maquina: solicitud.codigo_maquina,
      modelo: solicitud.modelo,
      hora_salida: now
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 12.1 DESPACHO MASIVO POR CONTINGENCIA (CORTE DE INTERNET / TELETRABAJO MASIVO)
app.post('/api/garita/despacho-masivo-contingencia', requireRole(['garita', 'sistemas']), async (req, res) => {
  try {
    const { operador = 'David Sistemas', fecha, motivo = 'Corte de Internet / Teletrabajo Masivo' } = req.body;
    const today = getFechaLocalEcuador();
    const queryFecha = fecha || today;

    // Obtener todas las solicitudes autorizadas que esperan despacho
    const pendientes = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE estado = 'APROBADO' AND (fecha_salida = ? OR fecha_salida <= ?)
      ORDER BY fecha_salida DESC, id ASC
    `).all(queryFecha, today);

    if (pendientes.length === 0) {
      return res.json({
        ok: true,
        count: 0,
        message: 'No hay solicitudes pendientes de despacho en Garita.'
      });
    }

    const now = new Date().toISOString();
    let despachados = 0;

    for (const sol of pendientes) {
      await db.prepare(`
        UPDATE solicitudes 
        SET estado = 'SALIO', despachado_por = ?, despachado_en = ? 
        WHERE id = ?
      `).run(operador, now, sol.id);

      await registrarAuditoria(
        sol.id,
        'SALIDA_CONFIRMADA_CONTINGENCIA',
        operador,
        `Salida masiva por contingencia (${motivo}). Asesor: ${sol.nombres}, Equipo: ${sol.codigo_maquina} (${sol.modelo})`
      );

      despachados++;
    }

    broadcastEvent('DESPACHO_MASIVO_CONTINGENCIA', {
      total: despachados,
      operador,
      motivo,
      hora: now
    });

    res.json({
      ok: true,
      count: despachados,
      message: `¡Contingencia ejecutada! Se despacharon exitosamente ${despachados} equipos como SALIDA a teletrabajo.`
    });
  } catch (error) {
    console.error('Error en despacho masivo de contingencia:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 13. RETORNO RÁPIDO INDIVIDUAL (CHECK-IN POR ESCANEO EN GARITA)
app.post('/api/garita/retornar', async (req, res) => {
  try {
    const { id, codigo_maquina, cedula, retornado_por = 'Guardia Garita', observaciones_retorno = '' } = req.body;

    let solicitud = null;
    let yaRetornado = null;

    // Si se envía código de máquina o cédula, verificar primero si es equipo TI o de un líder
    const searchCode = (codigo_maquina || cedula || '').trim().toUpperCase();
    if (searchCode) {
      // 0. Verificar si es equipo de Sistemas / TI
      const itMatch = await db.prepare("SELECT * FROM activos_ti WHERE UPPER(codigo_maquina) = ? AND activo = 1").get(searchCode);
      if (itMatch) {
        const now = new Date().toISOString();
        await db.prepare(`
          INSERT INTO activos_ti_movimientos (activo_id, nombre_funcionario, cargo, codigo_maquina, tipo_movimiento, guardia, fecha_hora, observaciones)
          VALUES (?, ?, ?, ?, 'ENTRADA', ?, ?, 'Reingreso registrado desde pantalla de Retornos')
        `).run(itMatch.id, itMatch.nombre_completo || itMatch.nombre, itMatch.cargo || 'Administrador de Sistemas', itMatch.codigo_maquina, retornado_por, now);

        await db.prepare(`
          UPDATE activos_ti 
          SET estado_ubicacion = 'EN_PLANTA', ultimo_movimiento_en = ?, ultimo_movimiento_tipo = 'ENTRADA', ultimo_guardia = ?
          WHERE id = ?
        `).run(now, retornado_por, itMatch.id);

        await registrarAuditoria(null, 'TI_ENTRADA', retornado_por, `Equipo TI ${itMatch.codigo_maquina} (${itMatch.nombre_completo || itMatch.nombre}) reingresó a planta.`);
        broadcastEvent('ACTIVO_TI_MOVIMIENTO', { codigo: itMatch.codigo_maquina, tipo: 'ENTRADA', estado_ubicacion: 'EN_PLANTA' });

        return res.json({
          ok: true,
          es_ti: true,
          message: `¡Reingreso corporativo confirmado exitosamente! El equipo de Sistemas / TI ${itMatch.nombre_completo || itMatch.nombre} reingresa a oficina.`,
          data: {
            id: itMatch.id,
            nombres: itMatch.nombre_completo || itMatch.nombre,
            cedula: 'SISTEMAS TI',
            codigo_maquina: itMatch.codigo_maquina,
            modelo: itMatch.modelo,
            area: itMatch.area || 'Sistemas / TI',
            nuevo_estado: 'EN_PLANTA',
            hora_retorno: now,
            retornado_por
          }
        });
      }

      // 1. Verificar si es laptop de un líder
      const liderMatch = await db.prepare("SELECT * FROM lideres_directorio WHERE UPPER(codigo_maquina) = ? AND activo = 1").get(searchCode);
      if (liderMatch) {
        const now = new Date().toISOString();
        await db.prepare(`
          INSERT INTO lideres_movimientos (lider_id, lider_nombre, nombre_completo, codigo_maquina, tipo_movimiento, guardia, fecha_hora, observaciones)
          VALUES (?, ?, ?, ?, 'ENTRADA', ?, ?, 'Reingreso registrado desde pantalla de Retornos')
        `).run(liderMatch.id, liderMatch.nombre, liderMatch.nombre_completo || liderMatch.nombre, liderMatch.codigo_maquina, retornado_por, now);

        await db.prepare(`
          UPDATE lideres_directorio 
          SET estado_ubicacion = 'EN_PLANTA', ultimo_movimiento_en = ?, ultimo_movimiento_tipo = 'ENTRADA', ultimo_guardia = ?
          WHERE id = ?
        `).run(now, retornado_por, liderMatch.id);

        await registrarAuditoria(null, 'LIDER_ENTRADA', retornado_por, `Líder ${liderMatch.nombre_completo || liderMatch.nombre} (${liderMatch.codigo_maquina}) reingresó a planta.`);

        return res.json({
          ok: true,
          es_lider: true,
          message: `¡Reingreso confirmado exitosamente! El líder ${liderMatch.nombre_completo || liderMatch.nombre} reingresa a oficina.`,
          data: {
            id: liderMatch.id,
            nombres: liderMatch.nombre_completo || liderMatch.nombre,
            cedula: 'LÍDER',
            codigo_maquina: liderMatch.codigo_maquina,
            modelo: liderMatch.modelo,
            lider_nombre: liderMatch.nombre,
            area: liderMatch.area_default || 'Cobranzas',
            nuevo_estado: 'EN_PLANTA',
            hora_retorno: now,
            retornado_por
          }
        });
      }
    }

    if (id) {
      solicitud = await db.prepare("SELECT * FROM solicitudes WHERE id = ?").get(id);
      if (solicitud && solicitud.estado === 'RETORNADO') {
        yaRetornado = solicitud;
        solicitud = null;
      }
    } else if (codigo_maquina) {
      const codeClean = codigo_maquina.trim().toUpperCase();
      solicitud = await db.prepare("SELECT * FROM solicitudes WHERE (codigo_maquina = ? OR cedula = ?) AND estado = 'SALIO' ORDER BY id DESC").get(codeClean, codeClean);
      if (!solicitud) {
        yaRetornado = await db.prepare("SELECT * FROM solicitudes WHERE (codigo_maquina = ? OR cedula = ?) AND estado = 'RETORNADO' ORDER BY id DESC").get(codeClean, codeClean);
      }
    } else if (cedula) {
      const cedClean = cedula.trim();
      solicitud = await db.prepare("SELECT * FROM solicitudes WHERE (cedula = ? OR codigo_maquina = ?) AND estado = 'SALIO' ORDER BY id DESC").get(cedClean, cedClean);
      if (!solicitud) {
        yaRetornado = await db.prepare("SELECT * FROM solicitudes WHERE (cedula = ? OR codigo_maquina = ?) AND estado = 'RETORNADO' ORDER BY id DESC").get(cedClean, cedClean);
      }
    }

    if (yaRetornado) {
      return res.status(200).json({
        ok: false,
        ya_retornado: true,
        error: `El equipo [${yaRetornado.codigo_maquina}] del asesor ${yaRetornado.nombres} ya fue reingresado previamente (recibido por ${yaRetornado.retornado_por || 'Garita'} el ${yaRetornado.retornado_en ? new Date(yaRetornado.retornado_en).toLocaleString('es-ES') : 'Hoy'}). Ya se encuentra en planta.`,
        data: {
          id: yaRetornado.id,
          nombres: yaRetornado.nombres,
          cedula: yaRetornado.cedula,
          codigo_maquina: yaRetornado.codigo_maquina,
          modelo: yaRetornado.modelo,
          lider_nombre: yaRetornado.lider_nombre,
          area: yaRetornado.area,
          estado: 'RETORNADO',
          retornado_por: yaRetornado.retornado_por,
          retornado_en: yaRetornado.retornado_en
        }
      });
    }

    if (!solicitud || solicitud.estado !== 'SALIO') {
      return res.status(404).json({
        ok: false,
        error: 'No se encontró ningún equipo en estado "SALIO" (en teletrabajo) pendiente de retorno para este código o asesor.'
      });
    }

    const now = new Date().toISOString();
    const obsFinal = observaciones_retorno 
      ? `${solicitud.observaciones || ''} | Retorno: ${observaciones_retorno}`.trim()
      : solicitud.observaciones;

    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET estado = 'RETORNADO', retornado_por = ?, retornado_en = ?, observaciones = ? 
      WHERE id = ?
    `);
    await stmt.run(retornado_por, now, obsFinal, solicitud.id);

    await registrarAuditoria(
      solicitud.id,
      'RETORNO_CONFIRMADO',
      retornado_por,
      `Equipo [${solicitud.codigo_maquina}] retornado a oficina por el asesor ${solicitud.nombres}. Pasa a estado PRESENCIAL.`
    );

    broadcastEvent('EQUIPO_RETORNADO', {
      id: solicitud.id,
      nombres: solicitud.nombres,
      codigo: solicitud.codigo_maquina,
      lider: solicitud.lider_nombre,
      guardia: retornado_por,
      hora: now
    });

    res.json({
      ok: true,
      message: `¡Reingreso confirmado exitosamente! El asesor ${solicitud.nombres} pasa a estado PRESENCIAL.`,
      data: {
        id: solicitud.id,
        nombres: solicitud.nombres,
        cedula: solicitud.cedula,
        codigo_maquina: solicitud.codigo_maquina,
        modelo: solicitud.modelo,
        lider_nombre: solicitud.lider_nombre,
        area: solicitud.area,
        estado_anterior: 'SALIO',
        nuevo_estado: 'RETORNADO',
        hora_salida: solicitud.despachado_en,
        hora_retorno: now,
        retornado_por: retornado_por
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 13.1 LISTA DE RETORNOS DEL TURNO (ÚLTIMAS 24 HORAS O FECHA ESPECÍFICA)
app.get('/api/garita/retornos-turno', async (req, res) => {
  try {
    const { fecha, lider } = req.query;
    let query = `
      SELECT * FROM solicitudes 
      WHERE estado = 'RETORNADO'
        AND (
          retornado_en >= datetime('now', '-24 hours')
          ${fecha ? 'OR fecha_salida = ? OR retornado_en LIKE ?' : ''}
        )
    `;
    const params = [];
    if (fecha) {
      params.push(fecha, `${fecha}%`);
    }

    if (lider && lider !== 'TODOS') {
      const lidClean = lider.trim();
      if (lidClean.toLowerCase() === 'ricardo') {
        query += " AND (lider_nombre = 'Ricardo' OR UPPER(lider_nombre) LIKE '%RICARDO%')";
      } else {
        query += ' AND (lider_nombre = ? OR LOWER(lider_nombre) = LOWER(?))';
        params.push(lidClean, lidClean);
      }
    }

    query += ' ORDER BY retornado_en DESC, id DESC LIMIT 100';

    const retornos = await db.prepare(query).all(...params);
    res.json({ ok: true, data: retornos });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 14. REPORTE Y CONTROL POR LÍDERES (SISTEMAS Y AUDITORÍA EN TIEMPO REAL)
app.get('/api/reportes/lideres', async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, lider, estado } = req.query;

    let query = 'SELECT * FROM solicitudes WHERE 1=1';
    const params = [];

    if (estado === 'SOLO_AFUERA') {
      // Muestra únicamente equipos que actualmente están fuera en teletrabajo sin importar la fecha de salida original
      query += " AND estado = 'SALIO'";
    } else if (estado && estado !== 'TODOS') {
      query += ' AND estado = ?';
      params.push(estado);
    }

    if (fecha_desde) {
      query += ' AND fecha_salida >= ?';
      params.push(fecha_desde);
    }
    if (fecha_hasta) {
      query += ' AND fecha_salida <= ?';
      params.push(fecha_hasta);
    }
    if (lider && lider !== 'TODOS') {
      query += ' AND lider_nombre = ?';
      params.push(lider);
    }

    query += ' ORDER BY lider_nombre ASC, fecha_salida DESC, id DESC';

    const solicitudes = await db.prepare(query).all(...params);

    // Agrupar por líder
    const agrupado = {};
    for (const s of solicitudes) {
      const key = s.lider_nombre || 'Sin Líder Asignado';
      if (!agrupado[key]) {
        agrupado[key] = {
          lider: key,
          area: s.area,
          total: 0,
          aprobados: 0,
          pendientes: 0,
          salieron: 0,
          retornados: 0,
          rechazados: 0,
          pendientes_retorno: 0, // Aún en la calle
          items: []
        };
      }
      agrupado[key].total++;
      if (s.estado === 'APROBADO') agrupado[key].aprobados++;
      if (s.estado === 'PENDIENTE') agrupado[key].pendientes++;
      if (s.estado === 'SALIO') {
        agrupado[key].salieron++;
        agrupado[key].pendientes_retorno++;
      }
      if (s.estado === 'RETORNADO') agrupado[key].retornados++;
      if (s.estado === 'RECHAZADO') agrupado[key].rechazados++;

      agrupado[key].items.push(s);
    }

    res.json({ ok: true, data: Object.values(agrupado) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 15. HISTORIAL / TRAZABILIDAD POR SERIE O CÉDULA
app.get('/api/trazabilidad', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ ok: false, error: 'Ingrese el número de serie o cédula.' });
    }
    const term = q.trim().toUpperCase();

    // Historial de solicitudes donde participó esa máquina o asesor
    const historial = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE codigo_maquina = ? OR codigo_maquina_anterior = ? OR cedula = ?
      ORDER BY id DESC
    `).all(term, term, term);

    // Logs de auditoría asociados
    const logs = await db.prepare(`
      SELECT * FROM auditoria 
      WHERE detalles LIKE ? OR detalles LIKE ?
      ORDER BY id DESC
    `).all(`%${term}%`, `%${term}%`);

    res.json({
      ok: true,
      termino: term,
      solicitudes: historial.map(s => ({
        ...s,
        despachado_en: formatearTimestampEcuador(s.despachado_en),
        retornado_en: formatearTimestampEcuador(s.retornado_en),
        aprobado_en: formatearTimestampEcuador(s.aprobado_en)
      })),
      logs: logs.map(l => ({
        ...l,
        timestamp: formatearTimestampEcuador(l.timestamp)
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 16. GENERACIÓN DE HOJA OFICIAL DE CONTROL CON POLÍTICAS (IDÉNTICA AL FORMATO FÍSICO)
app.get('/api/hoja-control', async (req, res) => {
  try {
    const { fecha, lider, area } = req.query;
    const today = getFechaLocalEcuador();
    const targetFecha = fecha || today;

    let query = 'SELECT * FROM solicitudes WHERE fecha_salida = ?';
    const params = [targetFecha];

    if (lider && lider !== 'TODOS') {
      query += ' AND lider_nombre = ?';
      params.push(lider);
    }
    if (area && area !== 'TODAS') {
      query += ' AND area = ?';
      params.push(area);
    }

    query += ' ORDER BY id ASC';
    const registros = await db.prepare(query).all(...params);

    const liderNombre = lider && lider !== 'TODOS' ? lider : (registros[0]?.lider_nombre || 'Líder del Área');
    const totalAutorizados = registros.length;
    const horaGenerado = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    // Fecha en español formateada (ej. VIERNES, 11 DE SEPTIEMBRE DE 2026)
    const partesFecha = targetFecha.split('-');
    const fechaObj = new Date(partesFecha[0], partesFecha[1] - 1, partesFecha[2]);
    const fechaTexto = fechaObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();

    // Renderizar HTML oficial idéntico al documento físico para imprimir en papel o guardar en PDF
    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Control de Equipos - Hoja de Registro</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 15mm 15mm 15mm 15mm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #111827;
      margin: 0;
      padding: 20px;
      font-size: 11px;
      line-height: 1.35;
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: #6b7280;
      margin-bottom: 8px;
    }
    .titulo-principal {
      text-align: center;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
      text-transform: uppercase;
    }
    .subtitulo-fecha {
      text-align: center;
      font-size: 11px;
      font-weight: 700;
      color: #374151;
      margin-bottom: 15px;
      text-transform: uppercase;
    }
    .meta-box {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 12px;
      border-bottom: 1px solid #d1d5db;
      padding-bottom: 6px;
    }
    .clausulas-box {
      border: 1px solid #9ca3af;
      padding: 8px 12px;
      margin-bottom: 14px;
      background-color: #fafafa;
      border-radius: 4px;
    }
    .clausulas-titulo {
      font-weight: 800;
      font-size: 10px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .clausulas-lista {
      margin: 0;
      padding-left: 16px;
      font-size: 9px;
    }
    .clausulas-lista li {
      margin-bottom: 2.5px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 40px;
      font-size: 9.5px;
    }
    th, td {
      border: 1px solid #374151;
      padding: 6px 4px;
      text-align: center;
    }
    th {
      background-color: #f3f4f6;
      font-weight: 700;
      font-size: 9px;
      text-transform: uppercase;
    }
    .col-nombre {
      text-align: left;
      font-weight: 700;
      padding-left: 6px;
      width: 22%;
    }
    .col-cedula { width: 11%; font-family: monospace; font-size: 9.5px; }
    .col-serie { width: 11%; font-family: monospace; font-weight: 700; }
    .col-modelo { width: 8%; }
    .col-firma { width: 12%; height: 38px; }
    .col-hora { width: 8%; font-size: 9px; }
    .col-obs { width: 12%; }
    
    .firmas-section {
      display: flex;
      justify-content: space-around;
      margin-top: 50px;
      page-break-inside: avoid;
    }
    .firma-bloque {
      text-align: center;
      width: 35%;
    }
    .linea-firma {
      border-top: 1px solid #111827;
      margin-bottom: 6px;
    }
    .firma-cargo {
      font-weight: 800;
      font-size: 10px;
    }
    .firma-nombre {
      font-size: 9px;
      color: #374151;
    }
    .doc-footer {
      text-align: center;
      font-size: 8px;
      color: #6b7280;
      margin-top: 30px;
      font-family: monospace;
    }
    .btn-imprimir-flotante {
      position: fixed;
      top: 15px;
      right: 15px;
      padding: 10px 18px;
      background-color: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 4px 6px rgba(0,0,0,0.15);
      font-size: 12px;
    }
    @media print {
      .btn-imprimir-flotante {
        display: none !important;
      }
      body {
        padding: 0;
      }
    }
  </style>
</head>
<body>

  <button class="btn-imprimir-flotante" onclick="window.print()">🖨️ IMPRIMIR HOJA OFICIAL</button>

  <div class="header-top">
    <span>${targetFecha}</span>
    <span>Control de Equipos — Hoja de Registro</span>
  </div>

  <div class="titulo-principal">CONTROL DE SALIDA DE EQUIPOS INFORMÁTICOS — TELETRABAJO</div>
  <div class="subtitulo-fecha">FECHA: ${fechaTexto}</div>

  <div class="meta-box">
    <span><strong>Líder del Área:</strong> ${liderNombre}</span>
    <span><strong>Total autorizados:</strong> ${totalAutorizados} asesor(es)</span>
    <span><strong>Generado:</strong> ${horaGenerado}</span>
  </div>

  <div class="clausulas-box">
    <div class="clausulas-titulo">📄 CLÁUSULAS IMPORTANTES (LEER ANTES DE FIRMAR)</div>
    <ol class="clausulas-lista">
      <li>El equipo entregado es de <strong>uso exclusivo para fines laborales</strong>.</li>
      <li>El asesor es responsable de su <strong>cuidado, buen uso y devolución</strong> en las fechas acordadas.</li>
      <li>En caso de <strong>pérdida, daño o robo</strong>, el asesor deberá reportar inmediatamente y asumir las responsabilidades correspondientes según el reglamento interno.</li>
      <li><strong>No se permitirá</strong> el préstamo o uso del equipo a terceros no autorizados.</li>
      <li>Seguridad <strong>solo permitirá la salida</strong> del equipo si el asesor está en la lista autorizada y firma el presente registro.</li>
      <li>El equipo debe ser devuelto en las mismas condiciones en que fue entregado. Daños no reportados serán responsabilidad del asesor.</li>
    </ol>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 4%;">#</th>
        <th class="col-nombre">Nombre del Asesor</th>
        <th class="col-cedula">Cédula</th>
        <th class="col-serie">N° de Serie</th>
        <th class="col-modelo">Modelo</th>
        <th class="col-firma">Firma Salida</th>
        <th class="col-hora">Hora Salida</th>
        <th class="col-firma">Firma Retorno</th>
        <th class="col-hora">Fecha Retorno</th>
        <th class="col-obs">Observaciones</th>
      </tr>
    </thead>
    <tbody>
      ${registros.length === 0 ? `
        <tr><td colspan="10" style="padding: 20px; text-align: center; color: #9ca3af;">No se encontraron registros para este líder en la fecha seleccionada.</td></tr>
      ` : registros.map((r, index) => {
        const horaSalida = r.despachado_en ? new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.despachado_en)) : '';
        const fechaRetorno = r.retornado_en ? new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.retornado_en)) : '';
        const estadoLabel = r.estado === 'RETORNADO' ? '[DEVUELTO]' : (r.estado === 'SALIO' ? '[EN TELETRABAJO]' : '');

        return `
          <tr>
            <td>${index + 1}</td>
            <td class="col-nombre">${r.nombres}</td>
            <td class="col-cedula">${r.cedula}</td>
            <td class="col-serie">${r.codigo_maquina}</td>
            <td class="col-modelo">${r.modelo || 'DELL'}</td>
            <td class="col-firma">${r.despachado_en ? '✓ DIGITAL' : ''}</td>
            <td class="col-hora">${horaSalida}</td>
            <td class="col-firma">${r.retornado_en ? '✓ RECIBIDO' : ''}</td>
            <td class="col-hora">${fechaRetorno}</td>
            <td class="col-obs" style="font-size: 8px;">${estadoLabel} ${r.observaciones || ''}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>

  <div class="firmas-section">
    <div class="firma-bloque">
      <div class="linea-firma"></div>
      <div class="firma-cargo">Responsable del Área</div>
      <div class="firma-nombre">${liderNombre}</div>
    </div>
    <div class="firma-bloque">
      <div class="linea-firma"></div>
      <div class="firma-cargo">Guardia de Seguridad</div>
      <div class="firma-nombre">Control de Garita</div>
    </div>
  </div>

  <div class="doc-footer">
    Documento generado por el Sistema de Control de Salidas de Equipos — ${new Date().toISOString()}
  </div>

</body>
</html>
    `;

    res.send(html);
  } catch (error) {
    res.status(500).send('Error generando hoja oficial: ' + error.message);
  }
});

// 17. Estadísticas del Dashboard (Optimizado con caché en memoria y 1 sola consulta a Turso)
app.get('/api/stats', async (req, res) => {
  try {
    const today = getFechaLocalEcuador();
    const fecha = req.query.fecha || today;
    const now = Date.now();

    // Servir desde caché si tiene menos de 10 segundos y es la misma fecha
    if (statsCache.data && statsCache.fecha === fecha && (now - statsCache.timestamp < 10000)) {
      return res.json({
        ok: true,
        fecha,
        cached: true,
        stats: statsCache.data
      });
    }

    // 1 sola consulta SQL consolidada (reduce un 85% el tráfico saliente a Turso)
    const row = await db.prepare(`
      SELECT 
        COUNT(CASE WHEN fecha_salida = ? OR (estado = 'PENDIENTE' AND created_at >= datetime('now', '-48 hours')) THEN 1 END) as totalHoy,
        COUNT(CASE WHEN estado = 'PENDIENTE' AND (fecha_salida = ? OR created_at >= datetime('now', '-48 hours')) THEN 1 END) as pendientes,
        COUNT(CASE WHEN fecha_salida = ? AND estado = 'APROBADO' THEN 1 END) as aprobadas,
        COUNT(CASE WHEN fecha_salida = ? AND estado = 'SALIO' THEN 1 END) as salieron,
        COUNT(CASE WHEN fecha_salida = ? AND estado = 'RETORNADO' THEN 1 END) as retornados,
        COUNT(CASE WHEN fecha_salida = ? AND estado = 'RECHAZADO' THEN 1 END) as rechazados,
        COUNT(CASE WHEN estado = 'SALIO' THEN 1 END) as equiposAfueraTotal
      FROM solicitudes
    `).get(fecha, fecha, fecha, fecha, fecha, fecha);

    const stats = {
      totalHoy: row ? Number(row.totalHoy) || 0 : 0,
      pendientes: row ? Number(row.pendientes) || 0 : 0,
      aprobadas: row ? Number(row.aprobadas) || 0 : 0,
      salieron: row ? Number(row.salieron) || 0 : 0,
      retornados: row ? Number(row.retornados) || 0 : 0,
      rechazados: row ? Number(row.rechazados) || 0 : 0,
      equiposAfueraTotal: row ? Number(row.equiposAfueraTotal) || 0 : 0
    };

    // Actualizar caché
    statsCache = {
      data: stats,
      fecha,
      timestamp: now
    };

    res.json({
      ok: true,
      fecha,
      stats
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 17.1 RASTREADOR DE EQUIPO Y ASESOR EN TIEMPO REAL (HISTORIAL & UBICACIÓN ACTUAL)
app.get('/api/equipos/rastrear', requireRole(['sistemas', 'garita']), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ ok: false, error: 'Debe ingresar una serie, cédula o nombre.' });
    }

    const qUpper = q.toUpperCase();
    const qLike = `%${q}%`;

    // 1. Verificar si es equipo exclusivo de Sistemas / TI
    const activoTI = await db.prepare(`
      SELECT * FROM activos_ti 
      WHERE UPPER(codigo_maquina) = ? OR cedula = ? OR UPPER(nombre_completo) LIKE ? OR UPPER(nombre) LIKE ?
    `).get(qUpper, q, qLike, qLike);

    if (activoTI) {
      const movs = await db.prepare(`
        SELECT * FROM activos_ti_movimientos WHERE activo_id = ? ORDER BY id DESC LIMIT 10
      `).all(activoTI.id);

      return res.json({
        ok: true,
        encontrado: true,
        categoria: 'TI',
        codigo_maquina: activoTI.codigo_maquina,
        modelo: activoTI.modelo || 'Dell Latitude Corporativa',
        titular: activoTI.nombre_completo || activoTI.nombre,
        cedula: activoTI.cedula || 'TI',
        area: activoTI.area || 'Sistemas / TI',
        cargo: activoTI.cargo || 'Infraestructura & DevOps',
        lider_nombre: 'Dirección de TI',
        ubicacion_actual: activoTI.estado_ubicacion === 'EN_PLANTA' ? 'EN_PLANTA' : 'EN_TELETRABAJO',
        ultimo_movimiento: {
          tipo: activoTI.ultimo_movimiento_tipo || 'EN_PLANTA',
          fecha_hora: activoTI.ultimo_movimiento_en,
          guardia: activoTI.ultimo_guardia
        },
        historial: movs
      });
    }

    // 2. Verificar si es equipo de un Líder de Operaciones
    const lider = await db.prepare(`
      SELECT * FROM lideres_directorio 
      WHERE UPPER(codigo_maquina) = ? OR cedula = ? OR UPPER(nombre) LIKE ? OR UPPER(nombre_completo) LIKE ?
    `).get(qUpper, q, qLike, qLike);

    if (lider) {
      const movsLider = await db.prepare(`
        SELECT * FROM lideres_movimientos WHERE lider_id = ? ORDER BY id DESC LIMIT 10
      `).all(lider.id);

      return res.json({
        ok: true,
        encontrado: true,
        categoria: 'LIDER',
        codigo_maquina: lider.codigo_maquina,
        modelo: lider.modelo || 'DELL',
        titular: lider.nombre_completo || lider.nombre,
        cedula: lider.cedula || 'LÍDER',
        area: lider.area_default || 'Cobranzas',
        cargo: lider.cargo || 'Líder de Operaciones',
        lider_nombre: lider.nombre,
        ubicacion_actual: lider.estado_ubicacion === 'EN_PLANTA' ? 'EN_PLANTA' : 'EN_TELETRABAJO',
        ultimo_movimiento: {
          tipo: lider.ultimo_movimiento_tipo || 'EN_PLANTA',
          fecha_hora: lider.ultimo_movimiento_en,
          guardia: lider.ultimo_guardia
        },
        historial: movsLider
      });
    }

    // 3. Buscar en Solicitudes de Asesores
    // Primero, si tiene una solicitud en estado SALIO (actualmente afuera)
    const salioActivo = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE (UPPER(codigo_maquina) = ? OR cedula = ? OR UPPER(nombres) LIKE ?) AND estado = 'SALIO'
      ORDER BY id DESC LIMIT 1
    `).get(qUpper, q, qLike);

    // Última solicitud registrada en general
    const ultimaSol = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE UPPER(codigo_maquina) = ? OR cedula = ? OR UPPER(nombres) LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(qUpper, q, qLike);

    // Registro en catálogo habitual
    const cat = await db.prepare(`
      SELECT * FROM asesores_catalogo 
      WHERE UPPER(codigo_maquina) = ? OR cedula = ? OR UPPER(nombres) LIKE ?
      LIMIT 1
    `).get(qUpper, q, qLike);

    if (!salioActivo && !ultimaSol && !cat) {
      return res.json({
        ok: true,
        encontrado: false,
        message: `No se encontraron registros para "${q}". Verifique la serie o cédula.`
      });
    }

    const solRef = salioActivo || ultimaSol;
    const targetCode = (solRef ? solRef.codigo_maquina : (cat ? cat.codigo_maquina : qUpper)).toUpperCase();

    // Historial completo de movimientos de esta máquina
    const historial = await db.prepare(`
      SELECT id, cedula, nombres, area, lider_nombre, codigo_maquina, modelo, fecha_salida, estado, despachado_por, despachado_en, retornado_por, retornado_en
      FROM solicitudes 
      WHERE UPPER(codigo_maquina) = ?
      ORDER BY id DESC LIMIT 15
    `).all(targetCode);

    let ubicacion = 'EN_PLANTA';
    if (salioActivo) {
      ubicacion = 'EN_TELETRABAJO';
    } else if (ultimaSol && (ultimaSol.estado === 'PENDIENTE' || ultimaSol.estado === 'APROBADO')) {
      ubicacion = 'POR_SALIR';
    }

    res.json({
      ok: true,
      encontrado: true,
      categoria: 'ASESOR',
      codigo_maquina: targetCode,
      modelo: solRef ? solRef.modelo : (cat ? cat.modelo : 'DELL'),
      titular: solRef ? solRef.nombres : (cat ? cat.nombres : 'N/A'),
      cedula: solRef ? solRef.cedula : (cat ? cat.cedula : 'N/A'),
      area: solRef ? solRef.area : (cat ? cat.area : 'Cobranzas'),
      lider_nombre: solRef ? solRef.lider_nombre : (cat ? cat.lider_nombre : 'N/A'),
      ubicacion_actual: ubicacion,
      solicitud_activa: salioActivo || null,
      ultima_solicitud: ultimaSol || null,
      catalogo: cat || null,
      historial
    });
  } catch (error) {
    console.error('Error en rastreo de equipo:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==========================================
// MÓDULO DE AUDITORÍA FÍSICA DE PISO E INVENTARIO ANTI-PÉRDIDAS
// ==========================================

// 1. Escaneo Rápido de Equipo con Pistola
app.post('/api/inventario/escanear', requireRole(['sistemas']), async (req, res) => {
  try {
    const { codigo_maquina, piso = 'Piso 3', sesion_id, usuario = 'David Sistemas', area = '', ubicacion_exacta = '' } = req.body;
    if (!codigo_maquina || !codigo_maquina.trim()) {
      return res.status(400).json({ ok: false, error: 'Código de máquina requerido.' });
    }

    const cod = codigo_maquina.trim().toUpperCase();

    // 1.1 Verificar si es equipo de TI
    const activoTI = await db.prepare('SELECT * FROM activos_ti WHERE UPPER(codigo_maquina) = ?').get(cod);

    // 1.2 Verificar si es equipo de un Líder de Operaciones
    const liderDirectorio = await db.prepare('SELECT * FROM lideres_directorio WHERE UPPER(codigo_maquina) = ?').get(cod);

    // 1.3 Buscar todas las asignaciones en el catálogo de asesores
    const catalogoRows = await db.prepare('SELECT * FROM asesores_catalogo WHERE UPPER(codigo_maquina) = ? AND activo = 1').all(cod);

    // 1.4 Buscar última solicitud para conocer si consta en teletrabajo
    const ultimaSol = await db.prepare('SELECT * FROM solicitudes WHERE UPPER(codigo_maquina) = ? ORDER BY id DESC LIMIT 1').get(cod);
    const estaEnTeletrabajo = (ultimaSol && ultimaSol.estado === 'SALIO');

    // 1.5 Verificar si ya fue escaneado hoy por otro compañero de equipo (Detección de doble escaneo concurrente)
    const lecturaPreviaHoy = await db.prepare(`
      SELECT id, usuario_auditor, piso_hallazgo, strftime('%H:%M:%S', fecha_escaneo) as hora_escaneo
      FROM inventario_lecturas
      WHERE UPPER(codigo_maquina) = ? AND date(fecha_escaneo) = date('now', 'localtime')
      ORDER BY id DESC LIMIT 1
    `).get(cod);

    let yaEscaneadoHoy = false;
    let mensajeDuplicadoLectura = null;
    if (lecturaPreviaHoy) {
      yaEscaneadoHoy = true;
      mensajeDuplicadoLectura = `ℹ️ ATENCIÓN: Este equipo ya fue escaneado hoy a las ${lecturaPreviaHoy.hora_escaneo} por [${lecturaPreviaHoy.usuario_auditor}] en ${lecturaPreviaHoy.piso_hallazgo}.`;
    }

    // Determinar Clasificación
    let clasificacion = 'REGULAR';
    let categoria = 'ASESOR';
    let titular = '';
    let liderAsignado = '';
    let areaAsignada = '';
    let modelo = 'DELL';
    let conflicto = false;
    let mensajeDiagnostico = '';

    if (activoTI) {
      categoria = 'TI';
      titular = activoTI.nombre_completo || activoTI.nombre;
      liderAsignado = 'Dirección de TI';
      areaAsignada = activoTI.area || 'Sistemas / TI';
      modelo = activoTI.modelo || 'Dell Latitude Corporativa';
      clasificacion = (piso === 'Oficina TI' || piso.toLowerCase().includes('ti')) ? 'REGULAR' : 'DESPLAZADO';
      mensajeDiagnostico = `Equipo exclusivo de Sistemas (${activoTI.nombre_completo}). Pase Libre TI.`;
    } else if (liderDirectorio) {
      categoria = 'LIDER';
      titular = liderDirectorio.nombre_completo || liderDirectorio.nombre;
      liderAsignado = liderDirectorio.nombre;
      areaAsignada = liderDirectorio.area_default || 'Cobranzas';
      modelo = liderDirectorio.modelo || 'DELL';
      clasificacion = 'REGULAR';
      mensajeDiagnostico = `Equipo oficial del Líder ${liderDirectorio.nombre}.`;
    } else if (catalogoRows.length > 1) {
      conflicto = true;
      clasificacion = 'DUPLICADO';
      titular = catalogoRows.map(c => `${c.nombres} (Líder: ${c.lider_nombre})`).join(' vs ');
      liderAsignado = catalogoRows.map(c => c.lider_nombre).join(', ');
      areaAsignada = catalogoRows[0].area || '';
      modelo = catalogoRows[0].modelo || 'DELL';
      mensajeDiagnostico = `¡CONFLICTO DE ASIGNACIÓN! Este código figura registrado simultáneamente a ${catalogoRows.length} asesores/líderes.`;
    } else if (catalogoRows.length === 1) {
      const c = catalogoRows[0];
      titular = c.nombres;
      liderAsignado = c.lider_nombre;
      areaAsignada = c.area || '';
      modelo = c.modelo || 'DELL';

      if (estaEnTeletrabajo) {
        clasificacion = 'EN_TELETRABAJO_PERO_EN_PLANTA';
        mensajeDiagnostico = `¡ALERTA! El sistema registraba que este equipo SALIÓ a teletrabajo con ${ultimaSol.nombres} el ${ultimaSol.fecha_salida}, pero está físicamente aquí.`;
      } else {
        clasificacion = 'REGULAR';
        mensajeDiagnostico = `Equipo asignado en orden a ${c.nombres} (Líder: ${c.lider_nombre}).`;
      }
    } else {
      if (ultimaSol) {
        titular = ultimaSol.nombres;
        liderAsignado = ultimaSol.lider_nombre || 'Histórico';
        areaAsignada = ultimaSol.area || '';
        modelo = ultimaSol.modelo || 'DELL';
        clasificacion = estaEnTeletrabajo ? 'EN_TELETRABAJO_PERO_EN_PLANTA' : 'DESPLAZADO';
        mensajeDiagnostico = `Equipo sin registro activo en catálogo actual, pero con historial previo con ${ultimaSol.nombres}.`;
      } else {
        clasificacion = 'NO_REGISTRADO';
        titular = 'No registrado';
        mensajeDiagnostico = 'Equipo HUÉRFANO o NUEVO: No consta en el catálogo ni en historial del sistema.';
      }
    }

    // Agregar aviso de escaneo previo si ocurrió hoy
    if (yaEscaneadoHoy && !conflicto) {
      mensajeDiagnostico = `${mensajeDuplicadoLectura} — ${mensajeDiagnostico}`;
    }

    const datosJson = JSON.stringify({
      categoria,
      titular,
      liderAsignado,
      areaAsignada,
      modelo,
      conflicto,
      estaEnTeletrabajo,
      yaEscaneadoHoy,
      mensajeDuplicadoLectura,
      ultimaSolicitud: ultimaSol || null,
      coincidenciasCatalogo: catalogoRows
    });

    const ins = await db.prepare(`
      INSERT INTO inventario_lecturas 
      (sesion_id, codigo_maquina, piso_hallazgo, area_hallazgo, ubicacion_exacta, estado_clasificacion, datos_catalogo, usuario_auditor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sesion_id || null,
      cod,
      piso,
      area,
      ubicacion_exacta,
      clasificacion,
      datosJson,
      usuario
    );

    if (sesion_id) {
      await db.prepare('UPDATE inventario_sesiones SET total_escaneados = total_escaneados + 1 WHERE id = ?').run(sesion_id);
    }

    const respuestaPayload = {
      ok: true,
      lectura_id: ins.lastInsertRowid,
      codigo_maquina: cod,
      piso_hallazgo: piso,
      estado_clasificacion: clasificacion,
      conflicto,
      categoria,
      titular,
      lider_asignado: liderAsignado,
      area_asignada: areaAsignada,
      modelo,
      esta_en_teletrabajo: estaEnTeletrabajo,
      ya_escaneado_hoy: yaEscaneadoHoy,
      mensaje_duplicado_lectura: mensajeDuplicadoLectura,
      mensaje_diagnostico: mensajeDiagnostico,
      coincidencias_catalogo: catalogoRows,
      usuario_auditor: usuario,
      fecha_escaneo: new Date().toLocaleTimeString('es-EC')
    };

    // Sincronización en tiempo real vía SSE a todas las computadoras del equipo de auditoría
    broadcastEvent('INVENTARIO_ESCANEADO', respuestaPayload);

    res.json(respuestaPayload);
  } catch (error) {
    console.error('Error en escaneo de inventario:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 2. Resolver Duplicado o Conflicto en Catálogo en 1 Clic
app.post('/api/inventario/resolver-duplicado', requireRole(['sistemas']), async (req, res) => {
  try {
    const { codigo_maquina, catalogo_id_mantener, catalogo_ids_eliminar, nuevo_lider, nuevo_asesor, usuario = 'David Sistemas' } = req.body;
    if (!codigo_maquina) {
      return res.status(400).json({ ok: false, error: 'Código de máquina requerido.' });
    }

    const cod = codigo_maquina.trim().toUpperCase();

    if (Array.isArray(catalogo_ids_eliminar) && catalogo_ids_eliminar.length > 0) {
      for (const idDel of catalogo_ids_eliminar) {
        await db.prepare('DELETE FROM asesores_catalogo WHERE id = ?').run(idDel);
      }
    }

    if (catalogo_id_mantener) {
      await db.prepare('UPDATE asesores_catalogo SET activo = 1 WHERE id = ?').run(catalogo_id_mantener);
    }

    if (nuevo_lider && nuevo_asesor) {
      await db.prepare(`
        UPDATE inventario_lecturas 
        SET accion_aplicada = 'Conflicto Resuelto: Asignado a ' || ?, estado_clasificacion = 'REGULAR'
        WHERE UPPER(codigo_maquina) = ?
      `).run(`${nuevo_asesor} (${nuevo_lider})`, cod);
    }

    registrarAuditoria(null, 'RESOLUCION_DUPLICADO', usuario, `Conflicto resuelto para equipo ${cod}. Asignado a: ${nuevo_asesor || 'Asesor confirmado'} bajo Líder ${nuevo_lider || 'Confirmado'}.`);

    res.json({ ok: true, message: `Conflicto resuelto exitosamente para la máquina ${cod}.` });
  } catch (error) {
    console.error('Error resolviendo duplicado:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 3. Reasignar Equipo a un Nuevo Asesor / Líder
app.post('/api/inventario/reasignar', requireRole(['sistemas']), async (req, res) => {
  try {
    const { codigo_maquina, lider_nombre, cedula, nombres, modelo = 'DELL', tipo_equipo = 'Laptop', area = 'Cobranzas', usuario = 'David Sistemas' } = req.body;
    if (!codigo_maquina || !lider_nombre || !nombres) {
      return res.status(400).json({ ok: false, error: 'Código de máquina, nuevo líder y nombres son requeridos.' });
    }

    const cod = codigo_maquina.trim().toUpperCase();

    await db.prepare('DELETE FROM asesores_catalogo WHERE UPPER(codigo_maquina) = ?').run(cod);

    const cedulaFinal = (cedula || '').trim() || `GEN-${Date.now().toString().slice(-6)}`;
    await sincronizarAsesorAlCatalogo(lider_nombre, cedulaFinal, nombres.trim(), cod, modelo, tipo_equipo, area);

    await db.prepare(`
      UPDATE inventario_lecturas 
      SET accion_aplicada = 'Reasignado a ' || ?, estado_clasificacion = 'REGULAR'
      WHERE UPPER(codigo_maquina) = ?
    `).run(`${nombres} (${lider_nombre})`, cod);

    registrarAuditoria(null, 'REASIGNACION_EQUIPO', usuario, `Equipo ${cod} reasignado oficialmente a ${nombres} (${lider_nombre}).`);

    res.json({ ok: true, message: `Equipo ${cod} reasignado exitosamente a ${nombres} (${lider_nombre}).` });
  } catch (error) {
    console.error('Error en reasignación de inventario:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 4. Marcar Equipo como Físicamente Recuperado en Planta (Cerrar Falso Teletrabajo)
app.post('/api/inventario/marcar-recuperada', requireRole(['sistemas']), async (req, res) => {
  try {
    const { codigo_maquina, usuario = 'David Sistemas', observaciones = '' } = req.body;
    if (!codigo_maquina) {
      return res.status(400).json({ ok: false, error: 'Código de máquina requerido.' });
    }

    const cod = codigo_maquina.trim().toUpperCase();
    const hoyEcuador = getFechaLocalEcuador();
    const obsFinal = `[Recuperado Físicamente en Planta durante Auditoría - ${hoyEcuador}] ${observaciones}`.trim();

    await db.prepare(`
      UPDATE solicitudes 
      SET estado = 'RETORNADO', retornado_por = ?, retornado_en = datetime('now', 'localtime'), observaciones = coalesce(observaciones, '') || '\n' || ?
      WHERE UPPER(codigo_maquina) = ? AND estado = 'SALIO'
    `).run(usuario, obsFinal, cod);

    await db.prepare(`
      UPDATE inventario_lecturas 
      SET accion_aplicada = 'Recuperado en Planta', estado_clasificacion = 'REGULAR'
      WHERE UPPER(codigo_maquina) = ?
    `).run(cod);

    registrarAuditoria(null, 'RECUPERACION_PLANTA', usuario, `Equipo ${cod} marcado físicamente en planta durante barrido de inventario.`);

    res.json({ ok: true, message: `Equipo ${cod} regularizado como FÍSICAMENTE EN PLANTA.` });
  } catch (error) {
    console.error('Error recuperando equipo en planta:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 5. Motor de Conciliación de Faltantes / Pérdidas de Piso
app.get('/api/inventario/conciliacion-faltantes', requireRole(['sistemas']), async (req, res) => {
  try {
    const { piso = 'TODOS', lider = 'TODOS' } = req.query;

    let sqlCat = 'SELECT * FROM asesores_catalogo WHERE activo = 1';
    const paramsCat = [];
    if (lider && lider !== 'TODOS') {
      sqlCat += ' AND lider_nombre = ?';
      paramsCat.push(lider);
    }
    sqlCat += ' ORDER BY lider_nombre ASC, nombres ASC';
    const catalogo = await db.prepare(sqlCat).all(...paramsCat);

    const enTeletrabajo = await db.prepare("SELECT * FROM solicitudes WHERE estado = 'SALIO'").all();
    const mapTeletrabajo = new Map();
    for (const sol of enTeletrabajo) {
      mapTeletrabajo.set(sol.codigo_maquina.toUpperCase(), sol);
    }

    let sqlLecturas = 'SELECT DISTINCT UPPER(codigo_maquina) as cod, piso_hallazgo, estado_clasificacion, fecha_escaneo FROM inventario_lecturas';
    const paramsLect = [];
    if (piso && piso !== 'TODOS') {
      sqlLecturas += ' WHERE piso_hallazgo = ?';
      paramsLect.push(piso);
    }
    const escaneados = await db.prepare(sqlLecturas).all(...paramsLect);
    const setEscaneados = new Set(escaneados.map(e => e.cod));

    const faltantes = [];
    const enPlantaHallados = [];
    const afueraTeletrabajo = [];

    for (const item of catalogo) {
      const cod = (item.codigo_maquina || '').toUpperCase();
      if (!cod) continue;

      if (setEscaneados.has(cod)) {
        enPlantaHallados.push({
          ...item,
          estado_auditoria: 'VERIFICADO_EN_PLANTA'
        });
      } else if (mapTeletrabajo.has(cod)) {
        const sol = mapTeletrabajo.get(cod);
        afueraTeletrabajo.push({
          ...item,
          solicitud_teletrabajo: sol,
          estado_auditoria: 'LEGALMENTE_EN_TELETRABAJO'
        });
      } else {
        faltantes.push({
          ...item,
          estado_auditoria: 'FALTANTE_DESAPARECIDO',
          motivo_sospecha: 'Equipo en catálogo no salió a teletrabajo y no fue encontrado en el barrido físico.'
        });
      }
    }

    res.json({
      ok: true,
      piso_auditado: piso,
      lider_auditado: lider,
      total_catalogo: catalogo.length,
      total_verificados_planta: enPlantaHallados.length,
      total_en_teletrabajo: afueraTeletrabajo.length,
      total_faltantes: faltantes.length,
      faltantes,
      en_planta_hallados: enPlantaHallados,
      en_teletrabajo: afueraTeletrabajo
    });
  } catch (error) {
    console.error('Error en conciliación de faltantes:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 6. Historial de Lecturas Recientes de Inventario
app.get('/api/inventario/lecturas', requireRole(['sistemas']), async (req, res) => {
  try {
    const { sesion_id, piso, limit = 100 } = req.query;
    let sql = 'SELECT * FROM inventario_lecturas WHERE 1=1';
    const params = [];

    if (sesion_id) {
      sql += ' AND sesion_id = ?';
      params.push(sesion_id);
    }
    if (piso && piso !== 'TODOS') {
      sql += ' AND piso_hallazgo = ?';
      params.push(piso);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(parseInt(limit, 10) || 100);

    const rows = await db.prepare(sql).all(...params);
    const formatted = rows.map(r => {
      let extra = {};
      try { extra = JSON.parse(r.datos_catalogo || '{}'); } catch(e){}
      return {
        lectura_id: r.id,
        codigo_maquina: r.codigo_maquina,
        piso_hallazgo: r.piso_hallazgo,
        estado_clasificacion: r.estado_clasificacion,
        titular: extra.titular || 'No registrado',
        lider_asignado: extra.liderAsignado || 'N/A',
        area_asignada: extra.areaAsignada || '',
        modelo: extra.modelo || 'DELL',
        conflicto: extra.conflicto || (r.estado_clasificacion === 'DUPLICADO'),
        coincidencias_catalogo: extra.coincidenciasCatalogo || [],
        mensaje_diagnostico: r.accion_aplicada || '',
        usuario_auditor: r.usuario_auditor,
        fecha_escaneo: formatearTimestampEcuador(r.fecha_escaneo)
      };
    });
    res.json({ ok: true, data: formatted });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 6.1. Buscador y Localizador Instantáneo de Máquinas en Auditoría (Anti-Pérdidas)
app.get('/api/inventario/buscar-equipo', requireRole(['sistemas']), async (req, res) => {
  try {
    const { codigo } = req.query;
    if (!codigo || !codigo.trim()) {
      return res.status(400).json({ ok: false, error: 'Código de máquina requerido para la búsqueda.' });
    }
    const cod = codigo.trim().toUpperCase();

    // 1. Buscar en inventario_lecturas (búsqueda exacta primero, o LIKE)
    let lectura = await db.prepare('SELECT * FROM inventario_lecturas WHERE UPPER(codigo_maquina) = ? ORDER BY id DESC LIMIT 1').get(cod);
    if (!lectura) {
      lectura = await db.prepare('SELECT * FROM inventario_lecturas WHERE UPPER(codigo_maquina) LIKE ? ORDER BY id DESC LIMIT 1').get(`%${cod}%`);
    }

    // 2. Buscar en asesores_catalogo (para saber a quién pertenece en teoría)
    let catCoincidencias = await db.prepare('SELECT * FROM asesores_catalogo WHERE UPPER(codigo_maquina) = ? AND activo = 1').all(cod);
    if (!catCoincidencias.length) {
      catCoincidencias = await db.prepare('SELECT * FROM asesores_catalogo WHERE UPPER(codigo_maquina) LIKE ? AND activo = 1').all(`%${cod}%`);
    }

    // 3. Buscar en activos_ti (por si es máquina de Sistemas)
    let activoTi = await db.prepare('SELECT * FROM activos_ti WHERE UPPER(codigo_maquina) = ? AND activo = 1').get(cod);

    // 4. Buscar última solicitud en solicitudes
    let ultimaSol = await db.prepare('SELECT * FROM solicitudes WHERE UPPER(codigo_maquina) = ? ORDER BY id DESC LIMIT 1').get(cod);

    if (lectura) {
      let extra = {};
      try { extra = JSON.parse(lectura.datos_catalogo || '{}'); } catch(e){}
      return res.json({
        ok: true,
        encontrado: true,
        enInventario: true,
        codigo_maquina: lectura.codigo_maquina,
        piso_hallazgo: lectura.piso_hallazgo,
        fecha_escaneo: formatearTimestampEcuador(lectura.fecha_escaneo),
        usuario_auditor: lectura.usuario_auditor || 'David Sistemas',
        estado_clasificacion: lectura.estado_clasificacion,
        accion_aplicada: lectura.accion_aplicada || 'Escaneado en Planta',
        titular: extra.titular || (catCoincidencias[0] ? catCoincidencias[0].nombres : (activoTi ? activoTi.nombre_completo : 'Sin titular asignado')),
        cedula: extra.cedula || (catCoincidencias[0] ? catCoincidencias[0].cedula : (activoTi ? activoTi.cedula : '')),
        lider_asignado: extra.liderAsignado || (catCoincidencias[0] ? catCoincidencias[0].lider_nombre : (activoTi ? 'Sistemas / TI' : 'N/A')),
        area_asignada: extra.areaAsignada || (catCoincidencias[0] ? catCoincidencias[0].area : (activoTi ? activoTi.area : 'Cobranzas')),
        modelo: extra.modelo || (catCoincidencias[0] ? catCoincidencias[0].modelo : (activoTi ? activoTi.modelo : 'DELL')),
        tipo_equipo: extra.tipo_equipo || (catCoincidencias[0] ? catCoincidencias[0].tipo_equipo : 'Laptop'),
        estado_planta: 'OPERATIVO EN PLANTA',
        ultima_solicitud: ultimaSol ? {
          id: ultimaSol.id,
          estado: ultimaSol.estado,
          fecha_salida: ultimaSol.fecha_salida,
          retornado_en: ultimaSol.retornado_en
        } : null
      });
    }

    // No fue encontrado en el barrido de piso
    return res.json({
      ok: true,
      encontrado: false,
      enInventario: false,
      codigo_buscado: cod,
      enCatalogo: catCoincidencias.length > 0 || !!activoTi,
      catalogo: catCoincidencias.length > 0 ? catCoincidencias[0] : (activoTi || null),
      ultima_solicitud: ultimaSol ? {
        id: ultimaSol.id,
        estado: ultimaSol.estado,
        fecha_salida: ultimaSol.fecha_salida,
        retornado_en: ultimaSol.retornado_en,
        nombres: ultimaSol.nombres,
        lider_nombre: ultimaSol.lider_nombre
      } : null,
      mensaje: catCoincidencias.length > 0
        ? `La máquina ${cod} figura en catálogo asignada a ${catCoincidencias[0].nombres} (Líder: ${catCoincidencias[0].lider_nombre}), PERO NO FUE ESCANEADA EN NINGÚN PISO durante la auditoría.`
        : (activoTi
          ? `La máquina ${cod} pertenece a Sistemas / TI (${activoTi.nombre_completo}), pero no fue escaneada en el barrido de piso.`
          : `El código ${cod} NO FUE ESCANEADO en el inventario y tampoco consta en el catálogo de equipos registrados.`)
    });
  } catch (error) {
    console.error('Error buscando equipo en inventario:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 7. Exportar Informe de Auditoría Física a Excel para la Jefatura
app.get('/api/inventario/exportar-informe', requireRole(['sistemas']), async (req, res) => {
  try {
    const { piso = 'TODOS', lider = 'TODOS' } = req.query;
    const hoy = getFechaLocalEcuador();

    let sqlLec = 'SELECT * FROM inventario_lecturas WHERE 1=1';
    const paramsLec = [];
    if (piso && piso !== 'TODOS') {
      sqlLec += ' AND piso_hallazgo = ?';
      paramsLec.push(piso);
    }
    sqlLec += ' ORDER BY id ASC';
    const lecturas = await db.prepare(sqlLec).all(...paramsLec);

    // Computadoras físicas únicas operativas
    const equiposUnicosMap = new Map();
    for (const l of lecturas) {
      const cod = l.codigo_maquina.trim().toUpperCase();
      equiposUnicosMap.set(cod, l);
    }
    const listaEquiposOperativos = Array.from(equiposUnicosMap.values());
    listaEquiposOperativos.sort((a, b) => {
      if (a.piso_hallazgo < b.piso_hallazgo) return -1;
      if (a.piso_hallazgo > b.piso_hallazgo) return 1;
      return a.codigo_maquina.localeCompare(b.codigo_maquina);
    });

    const totalOperativos = listaEquiposOperativos.length;

    // Resumen por Pisos
    const pisosOrdenados = ['Piso 1', 'Piso 2', 'Piso 3', 'Piso 4', 'Piso 5', 'Piso 6', 'Piso 7', 'Oficina TI'];
    const resumenPisos = {};
    for (const p of pisosOrdenados) {
      resumenPisos[p] = { piso: p, total: 0, conAsesor: 0, libres: 0, reingresados: 0, porcentaje: '0.0%' };
    }

    // Equipos reingresados de teletrabajo
    const solReingresadas = await db.prepare(`
      SELECT s.id, s.codigo_maquina, s.nombres, s.cedula, s.lider_nombre, s.estado, s.fecha_salida, s.fecha_retorno_estimada, s.retornado_en, s.observaciones
      FROM solicitudes s
      WHERE UPPER(s.codigo_maquina) IN (SELECT DISTINCT UPPER(codigo_maquina) FROM inventario_lecturas)
      AND (s.observaciones LIKE '%auditoría%' OR s.retornado_por LIKE '%Auditoría%' OR s.retornado_por LIKE '%Inventario%')
    `).all();
    const codigosReingresados = new Set(solReingresadas.map(s => s.codigo_maquina.toUpperCase()));

    for (const eq of listaEquiposOperativos) {
      const p = resumenPisos[eq.piso_hallazgo] || { piso: eq.piso_hallazgo, total: 0, conAsesor: 0, libres: 0, reingresados: 0, porcentaje: '0.0%' };
      p.total++;

      let extra = {};
      try { extra = JSON.parse(eq.datos_catalogo || '{}'); } catch(e){}
      if (extra.titular && extra.titular !== 'No registrado' && extra.titular !== 'No registrado en catálogo') {
        p.conAsesor++;
      } else {
        p.libres++;
      }

      if (codigosReingresados.has(eq.codigo_maquina.toUpperCase())) {
        p.reingresados++;
      }
      resumenPisos[eq.piso_hallazgo] = p;
    }

    for (const p of Object.values(resumenPisos)) {
      p.porcentaje = totalOperativos > 0 ? ((p.total / totalOperativos) * 100).toFixed(1) + '%' : '0.0%';
    }

    // HOJA 1: RESUMEN EJECUTIVO
    const dataResumen = [
      { 'A': 'SISTEMA INTEGRAL DE CONTROL DE EQUIPOS TI (SICET)' },
      { 'A': 'INFORME EJECUTIVO DE COMPUTADORAS OPERATIVAS Y FUNCIONALES EN PLANTA' },
      { 'A': `FECHA DE AUDITORÍA: ${hoy}` },
      { 'A': 'RESPONSABLES: David Sistemas & Equipo de Infraestructura TI' },
      { 'A': 'ALCANCE: Verificación física exhaustiva 100% piso por piso mediante lector de código de barras.' },
      { 'A': 'NOTA: Este informe excluye equipos dados de baja o en reparación en taller de sistemas (solo equipos operativos).' },
      {},
      {
        'A': 'Ubicación / Piso',
        'B': 'Equipos Operativos',
        'C': 'Asignados a Asesores',
        'D': 'Disponibles / Sin Asignar',
        'E': 'Reingresados de Teletrabajo',
        'F': '% del Edificio'
      }
    ];

    let sumTotal = 0, sumAsig = 0, sumLib = 0, sumRein = 0;
    for (const p of pisosOrdenados) {
      const d = resumenPisos[p];
      sumTotal += d.total;
      sumAsig += d.conAsesor;
      sumLib += d.libres;
      sumRein += d.reingresados;
      dataResumen.push({
        'A': d.piso,
        'B': d.total,
        'C': d.conAsesor,
        'D': d.libres,
        'E': d.reingresados,
        'F': d.porcentaje
      });
    }

    dataResumen.push({
      'A': 'TOTAL GENERAL EDIFICIO',
      'B': sumTotal,
      'C': sumAsig,
      'D': sumLib,
      'E': sumRein,
      'F': '100.0%'
    });

    dataResumen.push({});
    dataResumen.push({ 'A': '--- CONCLUSIONES Y ACCIONES CLAVE DE LA AUDITORÍA ---' });
    dataResumen.push({ 'A': `1. Se auditaron y confirmaron físicamente ${sumTotal} computadoras totalmente operativas en los 7 pisos y TI.` });
    dataResumen.push({ 'A': `2. Se identificaron ${sumRein} computadoras que figuraban con salidas/teletrabajo pendientes y que YA ESTÁN en planta física.` });
    dataResumen.push({ 'A': '3. Todos estos equipos fueron formalmente ingresados y regularizados en el sistema SICET a estado RETORNADO.' });
    dataResumen.push({ 'A': `4. Se hallaron ${sumLib} computadoras operativas sin titular activo asignado, disponibles para reubicación o banco de suplencia.` });

    // HOJA 2: DETALLE GENERAL
    const dataDetalleGeneral = listaEquiposOperativos.map((eq, idx) => {
      let extra = {};
      try { extra = JSON.parse(eq.datos_catalogo || '{}'); } catch(e){}
      const esReingresado = codigosReingresados.has(eq.codigo_maquina.toUpperCase());
      return {
        'N°': idx + 1,
        'Código de Máquina': eq.codigo_maquina,
        'Piso / Ubicación': eq.piso_hallazgo,
        'Tipo de Equipo': extra.tipo_equipo || 'Laptop',
        'Marca / Modelo': extra.modelo || 'DELL Latitude',
        'Asesor Titular': extra.titular || 'Sin Asignar',
        'Cédula Asesor': extra.cedula || (extra.coincidenciasCatalogo && extra.coincidenciasCatalogo[0] ? extra.coincidenciasCatalogo[0].cedula : ''),
        'Líder Responsable': extra.liderAsignado || 'N/A',
        'Área': extra.areaAsignada || 'Cobranzas',
        'Estado Operativo': 'OPERATIVO EN PLANTA',
        'Regularización Teletrabajo': esReingresado ? 'REINGRESADO HOY (Estaba en Teletrabajo)' : 'OK (En Planta)',
        'Auditor': eq.usuario_auditor || 'David Sistemas',
        'Fecha / Hora Escaneo': eq.fecha_escaneo
      };
    });

    // HOJA 3: REINGRESADOS DE TELETRABAJO
    const dataReingresados = solReingresadas.map((s, idx) => ({
      'N°': idx + 1,
      'ID Solicitud': s.id,
      'Código Máquina': s.codigo_maquina,
      'Asesor / Funcionario': s.nombres,
      'Cédula': s.cedula,
      'Líder de Operaciones': s.lider_nombre,
      'Fecha Salida Previa': s.fecha_salida,
      'Fecha Retorno Estimada': s.fecha_retorno_estimada || 'No indicada',
      'Estado Anterior': s.estado,
      'Estado Actual': 'RETORNADO (Ingresado a Planta)',
      'Verificado En': 'Auditoría Física de Piso',
      'Observación de Cierre': s.observaciones || `Ingreso físico verificado en planta durante auditoría ${hoy}`
    }));

    // HOJA 4: FALTANTES
    let sqlCat = 'SELECT * FROM asesores_catalogo WHERE activo = 1';
    const paramsCat = [];
    if (lider && lider !== 'TODOS') {
      sqlCat += ' AND lider_nombre = ?';
      paramsCat.push(lider);
    }
    const catalogo = await db.prepare(sqlCat).all(...paramsCat);

    const enTeletrabajoActual = await db.prepare("SELECT * FROM solicitudes WHERE estado = 'SALIO'").all();
    const setTeletrabajo = new Set(enTeletrabajoActual.map(s => s.codigo_maquina.toUpperCase()));
    const setEscaneados = new Set(listaEquiposOperativos.map(l => l.codigo_maquina.toUpperCase()));

    const dataFaltantes = [];
    let contadorFaltantes = 1;
    for (const item of catalogo) {
      const cod = (item.codigo_maquina || '').toUpperCase();
      if (!setEscaneados.has(cod) && !setTeletrabajo.has(cod)) {
        dataFaltantes.push({
          'N°': contadorFaltantes++,
          'Código Máquina': cod,
          'Asesor Asignado': item.nombres,
          'Cédula Asesor': item.cedula,
          'Líder de Operaciones': item.lider_nombre,
          'Área': item.area || 'Cobranzas',
          'Modelo': item.modelo || 'DELL',
          'Diagnóstico': 'EQUIPO NO ENCONTRADO EN PLANTA (No salió a teletrabajo)',
          'Alerta': 'CRÍTICA - POSIBLE PÉRDIDA O TRASPASO IRREGULAR'
        });
      }
    }

    const wb = xlsx.utils.book_new();

    // 1. Resumen Ejecutivo
    const wsResumen = xlsx.utils.json_to_sheet(dataResumen, { skipHeader: true });
    wsResumen['!cols'] = [{ wch: 32 }, { wch: 18 }, { wch: 22 }, { wch: 25 }, { wch: 28 }, { wch: 16 }];
    xlsx.utils.book_append_sheet(wb, wsResumen, 'Resumen_Ejecutivo');

    // 2. Detalle General
    const wsDetalle = xlsx.utils.json_to_sheet(dataDetalleGeneral.length ? dataDetalleGeneral : [{ 'Estado': 'Sin equipos registrados' }]);
    wsDetalle['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 16 }, { wch: 15 }, { wch: 20 }, { wch: 35 }, { wch: 15 }, { wch: 25 }, { wch: 18 }, { wch: 22 }, { wch: 32 }, { wch: 18 }, { wch: 20 }];
    xlsx.utils.book_append_sheet(wb, wsDetalle, 'Equipos_Operativos_General');

    // 3. Reingresados Teletrabajo
    const wsReingreso = xlsx.utils.json_to_sheet(dataReingresados.length ? dataReingresados : [{ 'Estado': 'Sin equipos reingresados' }]);
    wsReingreso['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 18 }, { wch: 35 }, { wch: 15 }, { wch: 25 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 45 }];
    xlsx.utils.book_append_sheet(wb, wsReingreso, 'Reingresados_Teletrabajo');

    // 4. Faltantes
    const wsFaltantes = xlsx.utils.json_to_sheet(dataFaltantes.length ? dataFaltantes : [{ 'Estado': 'No se detectaron faltantes' }]);
    xlsx.utils.book_append_sheet(wb, wsFaltantes, 'EQUIPOS_FALTANTES_PERDIDOS');

    // 5 a 12. Hojas por Piso
    for (const pName of pisosOrdenados) {
      const eqsPiso = dataDetalleGeneral.filter(item => item['Piso / Ubicación'] === pName);
      const sheetName = pName.replace(/\s+/g, '_');
      const wsP = xlsx.utils.json_to_sheet(eqsPiso.length ? eqsPiso : [{ 'Mensaje': `No se registraron computadoras en ${pName}` }]);
      wsP['!cols'] = wsDetalle['!cols'];
      xlsx.utils.book_append_sheet(wb, wsP, sheetName);
    }

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `INFORME_EQUIPOS_OPERATIVOS_EDIFICIO_SICET_${piso.replace(/\s+/g, '_')}_${hoy}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exportando informe de inventario:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 18. Exportar a Excel con Filtros
app.get('/api/exportar/excel', async (req, res) => {
  try {
    const { fecha, area, estado, lider } = req.query;
    let query = 'SELECT * FROM solicitudes WHERE 1=1';
    const params = [];

    if (fecha) {
      query += ' AND fecha_salida = ?';
      params.push(fecha);
    }
    if (area && area !== 'TODAS') {
      query += ' AND area = ?';
      params.push(area);
    }
    if (lider && lider !== 'TODOS') {
      query += ' AND lider_nombre = ?';
      params.push(lider);
    }
    if (estado && estado !== 'TODOS') {
      query += ' AND estado = ?';
      params.push(estado);
    }

    query += ' ORDER BY id DESC';
    const rows = await db.prepare(query).all(...params);

    const exportData = rows.map((r) => ({
      'ID': r.id,
      'Cédula': r.cedula,
      'Nombres': r.nombres,
      'Área': r.area,
      'Líder Solicitante': r.lider_nombre,
      'Código Máquina': r.codigo_maquina,
      'Modelo': r.modelo || 'DELL',
      'Código Anterior (si hubo cambio)': r.codigo_maquina_anterior || '',
      'Tipo de Equipo': r.tipo_equipo,
      'Fecha Salida': r.fecha_salida,
      'Fecha Retorno': r.fecha_retorno_estimada,
      'Estado': r.estado,
      'Aprobado Por': r.aprobado_por || '',
      'Hora Aprobación': formatearTimestampEcuador(r.aprobado_en),
      'Despachado Por': r.despachado_por || '',
      'Hora Salida Garita': formatearTimestampEcuador(r.despachado_en),
      'Retornado Por': r.retornado_por || '',
      'Hora Retorno': formatearTimestampEcuador(r.retornado_en),
      'Motivo Rechazo': r.motivo_rechazo || '',
      'Observaciones': r.observaciones || ''
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(exportData);
    xlsx.utils.book_append_sheet(wb, ws, 'Reporte_Salidas');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Reporte_Salidas_${fecha || 'General'}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 19. Auditoría / Logs con Filtros de Fecha (Ecuador), Tipo de Acción y Búsqueda
app.get('/api/auditoria', async (req, res) => {
  try {
    const { fecha, q, accion, limit = 250 } = req.query;
    let query = 'SELECT * FROM auditoria WHERE 1=1';
    const params = [];

    if (fecha && fecha !== 'TODAS') {
      query += " AND strftime('%Y-%m-%d', timestamp, '-5 hours') = ?";
      params.push(fecha);
    }

    if (accion && accion !== 'TODAS') {
      if (accion === 'APROBACIONES') {
        query += " AND (accion = 'APROBADA' OR accion = 'APROBADA_LOTE' OR accion = 'APROBACION_GLOBAL')";
      } else if (accion === 'SALIDAS') {
        query += " AND (accion = 'SALIDA_CONFIRMADA' OR accion = 'LIDER_SALIDA' OR accion = 'SALIDA_HABITUAL_1CLIC')";
      } else if (accion === 'RETORNOS') {
        query += " AND (accion = 'RETORNO_CONFIRMADO' OR accion = 'LIDER_ENTRADA')";
      } else if (accion === 'RECHAZOS') {
        query += " AND (accion = 'RECHAZADA' OR accion = 'RECHAZADA_LOTE' OR accion = 'RECHAZO_GLOBAL' OR accion = 'CANCELADA_POR_LIDER')";
      } else if (accion === 'LOGINS') {
        query += " AND (accion = 'LOGIN_EXITOSO' OR accion = 'LOGIN_LIDER' OR accion = 'CAMBIO_CLAVE')";
      } else {
        query += ' AND accion = ?';
        params.push(accion);
      }
    }

    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      query += ' AND (detalles LIKE ? OR usuario LIKE ? OR accion LIKE ?)';
      params.push(term, term, term);
    }

    query += ' ORDER BY id DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 500, 1000));

    const logs = await db.prepare(query).all(...params);
    const data = logs.map(l => ({
      ...l,
      timestamp_raw: l.timestamp,
      timestamp: formatearTimestampEcuador(l.timestamp)
    }));
    res.json({ ok: true, data, count: data.length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Manejo de rutas /api no encontradas (debe ir antes del SPA fallback)
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}` });
});

// Servir la aplicación web SPA (compatible con Express 4 y 5)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.initDb().then(() => {});
let serverInstance = app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Sistema de Control de Salidas de Equipos Activo`);
  console.log(`🌐 Acceso Web: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

module.exports = { app, server: serverInstance };
