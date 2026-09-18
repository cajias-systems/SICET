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

// Función auxiliar para registrar auditoría
async function registrarAuditoria(solicitudId, accion, usuario, detalles) {
  try {
    const stmt = await db.prepare(`
      INSERT INTO auditoria (solicitud_id, accion, usuario, detalles)
      VALUES (?, ?, ?, ?)
    `);
    await stmt.run(solicitudId, accion, usuario, detalles);
  } catch (err) {
    console.error('Error al registrar auditoría:', err);
  }
}

// Función auxiliar para verificar si un equipo o asesor ya está fuera en teletrabajo
async function verificarDisponibilidadEquipo(codigoMaquina, cedula, idIgnorar = null) {
  const normCodigo = codigoMaquina.trim().toUpperCase();
  const normCedula = cedula.trim();

  // Verificar si la máquina física ya está en estado 'SALIO' (en la calle)
  let queryEquipo = "SELECT * FROM solicitudes WHERE codigo_maquina = ? AND estado = 'SALIO'";
  const paramsEquipo = [normCodigo];
  if (idIgnorar) {
    queryEquipo += " AND id != ?";
    paramsEquipo.push(idIgnorar);
  }
  const ocupadoEquipo = await db.prepare(queryEquipo).get(...paramsEquipo);
  if (ocupadoEquipo) {
    return {
      disponible: false,
      error: `El equipo [${normCodigo}] ya está en teletrabajo en posesión de ${ocupadoEquipo.nombres} (${ocupadoEquipo.area}) desde el ${ocupadoEquipo.fecha_salida}. Debe registrarse su retorno antes de asignarlo nuevamente.`
    };
  }

  // Verificar si la cédula ya tiene una máquina fuera activa
  let queryCedula = "SELECT * FROM solicitudes WHERE cedula = ? AND estado = 'SALIO'";
  const paramsCedula = [normCedula];
  if (idIgnorar) {
    queryCedula += " AND id != ?";
    paramsCedula.push(idIgnorar);
  }
  const ocupadoCedula = await db.prepare(queryCedula).get(...paramsCedula);
  if (ocupadoCedula) {
    return {
      disponible: false,
      error: `El asesor con cédula [${normCedula}] (${ocupadoCedula.nombres}) ya tiene un equipo asignado en la calle (${ocupadoCedula.codigo_maquina}) desde el ${ocupadoCedula.fecha_salida}.`
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

// Obtener nómina de los 27 líderes oficiales
app.get('/api/lideres-directorio', async (req, res) => {
  try {
    const lideres = await db.prepare('SELECT * FROM lideres_directorio WHERE activo = 1 ORDER BY nombre ASC').all();
    res.json({ ok: true, data: lideres });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Agregar nuevo líder al directorio (Sistemas)
app.post('/api/lideres-directorio', requireRole(['sistemas']), async (req, res) => {
  try {
    const { nombre, area_default = 'Operaciones' } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre del líder es requerido.' });
    }

    const stmt = db.prepare('INSERT INTO lideres_directorio (nombre, area_default) VALUES (?, ?)');
    const r = await stmt.run(nombre.trim(), area_default.trim());
    await registrarAuditoria(null, 'LIDER_AGREGADO', 'Sistemas', `Nuevo líder agregado al directorio: ${nombre.trim()}`);

    res.json({ ok: true, id: r.lastInsertRowid, message: 'Líder agregado correctamente.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: 'El líder ya existe en el directorio o hubo un error.' });
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

    const today = new Date().toISOString().slice(0, 10);
    const asesores = await db.prepare(`
      SELECT * FROM asesores_catalogo 
      WHERE lider_nombre = ? AND activo = 1 
      ORDER BY nombres ASC
    `).all(lider_nombre.trim());

    // Anotar cada asesor si ya tiene solicitud hoy o si la laptop está afuera
    const resultado = await Promise.all(asesores.map(async a => {
      const solicitudHoy = await db.prepare(`
        SELECT id, estado, fecha_salida 
        FROM solicitudes 
        WHERE cedula = ? AND fecha_salida = ?
        ORDER BY id DESC LIMIT 1
      `).get(a.cedula, today);

      const laptopAfuera = await db.prepare(`
        SELECT nombres, fecha_salida 
        FROM solicitudes 
        WHERE codigo_maquina = ? AND estado = 'SALIO'
        LIMIT 1
      `).get(a.codigo_maquina);

      return {
        ...a,
        solicitud_hoy: solicitudHoy || null,
        laptop_afuera: laptopAfuera ? true : false,
        laptop_afuera_detalle: laptopAfuera ? `En teletrabajo con ${laptopAfuera.nombres} desde ${laptopAfuera.fecha_salida}` : null
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

    const today = new Date().toISOString().slice(0, 10);
    const targetFecha = fecha_salida || today;

    const insertStmt = await db.prepare(`
      INSERT INTO solicitudes 
      (cedula, nombres, area, lider_nombre, codigo_maquina, modelo, tipo_equipo, fecha_salida, fecha_retorno_estimada, estado, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
    `);

    let insertados = 0;
    const omitidos = [];

    for (const a of asesores) {
      // Validar si ya está en la calle
      const disp = await verificarDisponibilidadEquipo(a.codigo_maquina, a.cedula);
      if (!disp.disponible) {
        omitidos.push(`${a.nombres}: ${disp.error}`);
        continue;
      }

      // Validar si ya tiene solicitud para hoy
      const yaExiste = await db.prepare('SELECT id FROM solicitudes WHERE cedula = ? AND fecha_salida = ?').get(a.cedula, targetFecha);
      if (yaExiste) {
        omitidos.push(`${a.nombres}: Ya tiene una solicitud registrada para hoy.`);
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

    if (!cedula || !nombres || !area || !codigo_maquina || !fecha_salida) {
      return res.status(400).json({
        ok: false,
        error: 'Cédula, Nombres, Área, Código de Máquina y Fecha de Salida son obligatorios.'
      });
    }

    // Comprobación anti-duplicados (si la máquina o la persona ya están fuera)
    const disp = await verificarDisponibilidadEquipo(codigo_maquina, cedula);
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
      fecha_salida,
      fecha_retorno_estimada || fecha_salida,
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

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows || rows.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ ok: false, error: 'El archivo está vacío o no tiene el formato correcto.' });
    }

    const insertStmt = db.prepare(`
      INSERT INTO solicitudes 
      (cedula, nombres, area, lider_nombre, codigo_maquina, modelo, tipo_equipo, fecha_salida, fecha_retorno_estimada, estado, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)
    `);

    let insertados = 0;
    const errores = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const row of rows) {
      const cedula = String(row['Cédula'] || row['Cedula'] || row['CEDULA'] || row['cedula'] || '').trim();
      const nombres = String(row['Nombres'] || row['Nombre'] || row['NOMBRES'] || row['Apellidos y Nombres'] || '').trim();
      const area = String(row['Área'] || row['Area'] || row['AREA'] || row['Campaña'] || req.body.area || 'Campañas').trim();
      const codigo = String(row['Código Máquina'] || row['Codigo Maquina'] || row['Serie'] || row['N° de Serie'] || row['CODIGO'] || row['Equipo'] || '').trim().toUpperCase();
      const modelo = String(row['Modelo'] || row['MODELO'] || row['Marca'] || 'DELL').trim().toUpperCase();
      const tipo = String(row['Tipo de Equipo'] || row['Tipo'] || 'Laptop').trim();
      
      let fechaSalida = String(row['Fecha Salida'] || row['Fecha'] || today).trim();
      if (fechaSalida.includes('/')) {
        const parts = fechaSalida.split('/');
        if (parts.length === 3) {
          fechaSalida = parts[2].length === 4 ? `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}` : fechaSalida;
        }
      }
      
      const fechaRetorno = String(row['Fecha Retorno'] || fechaSalida).trim();
      const obs = String(row['Observaciones'] || row['Obs'] || '').trim();

      // Si quien sube es un líder o envió su nombre explícito, la carga pertenece a él
      let lider = lider_default;
      if (!lider || (userRole === 'sistemas' && (row['Líder'] || row['Lider']))) {
        lider = String(row['Líder'] || row['Lider'] || lider_default || 'Líder de Área').trim();
      }

      if (cedula && nombres && codigo) {
        // Verificar disponibilidad anti-duplicados
        const disp = await verificarDisponibilidadEquipo(codigo, cedula);
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
    const today = new Date().toISOString().slice(0, 10);
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

    await registrarAuditoria(id, 'APROBADA', aprobado_por, 'Autorizado formalmente por Sistemas');
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

    await registrarAuditoria(id, 'RECHAZADA', aprobado_por, `Motivo: ${motivo_rechazo}`);
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

// 8.3. Depuración Masiva al Final del Día (Quitar todos los aprobados que no salieron)
app.post('/api/solicitudes/depurar-no-salidos', requireRole(['sistemas']), async (req, res) => {
  try {
    const { fecha, operador = 'Sistemas' } = req.body;
    const targetFecha = fecha || new Date().toISOString().slice(0, 10);

    // Seleccionar todos los registros de la fecha que quedaron en APROBADO o PENDIENTE pero nunca salieron
    const stmt = db.prepare(`
      UPDATE solicitudes 
      SET estado = 'NO_SALIO', 
          observaciones = CASE 
            WHEN observaciones IS NULL OR observaciones = '' THEN 'ANULADO AL CIERRE DE TURNO: No retiró el equipo'
            ELSE observaciones || ' | ANULADO AL CIERRE DE TURNO'
          END
      WHERE fecha_salida = ? AND estado IN ('APROBADO', 'PENDIENTE')
    `);

    const result = await stmt.run(targetFecha);
    const count = result.changes;

    await registrarAuditoria(null, 'DEPURACION_CIERRE_TURNO', operador, `Se anularon ${count} solicitudes aprobadas/pendientes que no fueron retiradas en la fecha ${targetFecha}`);

    res.json({
      ok: true,
      depurados: count,
      message: `Se limpiaron ${count} solicitudes no retiradas de la fecha ${targetFecha}. Los guardias ya no verán pendientes y los equipos quedan liberados.`
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
        const r = await stmt.run(aprobado_por, now, id);
        if (r.changes > 0) {
          await registrarAuditoria(id, 'APROBADA_LOTE', aprobado_por, 'Aprobación por lote seleccionada');
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

    res.json({ ok: true, count, message: `Se aprobaron exitosamente ${count} solicitudes.` });
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
    const today = new Date().toISOString().slice(0, 10);

    // Buscar coincidencia por cédula o serie exacta o parecida
    const rows = await db.prepare(`
      SELECT * FROM solicitudes 
      WHERE (cedula = ? OR codigo_maquina = ? OR cedula LIKE ? OR codigo_maquina LIKE ?)
      ORDER BY 
        CASE WHEN fecha_salida = ? THEN 1 ELSE 2 END,
        id DESC
      LIMIT 10
    `).all(term, term.toUpperCase(), `%${term}%`, `%${term.toUpperCase()}%`, today);

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
    const today = new Date().toISOString().slice(0, 10);
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

// 13. RETORNO RÁPIDO INDIVIDUAL (CHECK-IN POR ESCANEO EN GARITA)
app.post('/api/garita/retornar', async (req, res) => {
  try {
    const { id, codigo_maquina, cedula, retornado_por = 'Guardia Garita', observaciones_retorno = '' } = req.body;

    let solicitud = null;
    if (id) {
      solicitud = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(id);
    } else if (codigo_maquina) {
      solicitud = await db.prepare("SELECT * FROM solicitudes WHERE codigo_maquina = ? AND estado = 'SALIO' ORDER BY id DESC").get(codigo_maquina.trim().toUpperCase());
    } else if (cedula) {
      solicitud = await db.prepare("SELECT * FROM solicitudes WHERE cedula = ? AND estado = 'SALIO' ORDER BY id DESC").get(cedula.trim());
    }

    if (!solicitud) {
      return res.status(404).json({
        ok: false,
        error: 'No se encontró ningún equipo en estado "SALIO" pendiente de retorno para este código o asesor.'
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
      `Equipo [${solicitud.codigo_maquina}] retornado a oficina por el asesor ${solicitud.nombres}`
    );

    res.json({
      ok: true,
      message: `¡Reingreso confirmado para el equipo ${solicitud.codigo_maquina}!`,
      asesor: solicitud.nombres,
      codigo_maquina: solicitud.codigo_maquina,
      fecha_retorno: now
    });
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
      solicitudes: historial,
      logs
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 16. GENERACIÓN DE HOJA OFICIAL DE CONTROL CON POLÍTICAS (IDÉNTICA AL FORMATO FÍSICO)
app.get('/api/hoja-control', async (req, res) => {
  try {
    const { fecha, lider, area } = req.query;
    const today = new Date().toISOString().slice(0, 10);
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
        const horaSalida = r.despachado_en ? new Date(r.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
        const fechaRetorno = r.retornado_en ? new Date(r.retornado_en).toLocaleDateString('es-ES') : '';
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

// 17. Estadísticas del Dashboard
app.get('/api/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const fecha = req.query.fecha || today;

    const totalHoyRow = await db.prepare('SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ?').get(fecha);
    const pendientesRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ? AND estado = 'PENDIENTE'").get(fecha);
    const aprobadasRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ? AND estado = 'APROBADO'").get(fecha);
    const salieronRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ? AND estado = 'SALIO'").get(fecha);
    const retornadosRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ? AND estado = 'RETORNADO'").get(fecha);
    const rechazadosRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE fecha_salida = ? AND estado = 'RECHAZADO'").get(fecha);
    const equiposAfueraTotalRow = await db.prepare("SELECT COUNT(*) as count FROM solicitudes WHERE estado = 'SALIO'").get();

    const totalHoy = totalHoyRow ? totalHoyRow.count : 0;
    const pendientes = pendientesRow ? pendientesRow.count : 0;
    const aprobadas = aprobadasRow ? aprobadasRow.count : 0;
    const salieron = salieronRow ? salieronRow.count : 0;
    const retornados = retornadosRow ? retornadosRow.count : 0;
    const rechazados = rechazadosRow ? rechazadosRow.count : 0;
    const equiposAfueraTotal = equiposAfueraTotalRow ? equiposAfueraTotalRow.count : 0;

    res.json({
      ok: true,
      fecha,
      stats: {
        totalHoy,
        pendientes,
        aprobadas,
        salieron,
        retornados,
        rechazados,
        equiposAfueraTotal
      }
    });
  } catch (error) {
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
      'Hora Aprobación': r.aprobado_en || '',
      'Despachado Por': r.despachado_por || '',
      'Hora Salida Garita': r.despachado_en || '',
      'Retornado Por': r.retornado_por || '',
      'Hora Retorno': r.retornado_en || '',
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

// 19. Auditoría / Logs
app.get('/api/auditoria', async (req, res) => {
  try {
    const logs = await db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT 60').all();
    res.json({ ok: true, data: logs });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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
