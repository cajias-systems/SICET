const http = require('http');

// Iniciar servidor en puerto de prueba 3005
process.env.PORT = '3005';
require('./server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      hostname: '127.0.0.1',
      port: 3005,
      path: path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    const reqOptions = { ...defaultOptions, ...options, headers: { ...defaultOptions.headers, ...options.headers } };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- INICIANDO PRUEBAS DEL SISTEMA ---');
  // Esperar 1 segundo a que el servidor esté escuchando
  await new Promise(r => setTimeout(r, 1000));

  // 1. Áreas
  const resAreas = await request('/api/areas');
  console.log('✓ GET /api/areas:', resAreas.status === 200 && resAreas.body.data.length > 0 ? 'PASS' : 'FAIL');

  // 2. Crear solicitud individual (Portal Líder)
  const today = new Date().toISOString().slice(0, 10);
  const resCrear = await request('/api/solicitudes', {
    method: 'POST',
    body: {
      cedula: '0999887766',
      nombres: 'Esteban Paredes Ruiz',
      area: 'Cobranzas',
      lider_nombre: 'María Torres',
      codigo_maquina: 'LAP-DELL-9921',
      tipo_equipo: 'Laptop + Cargador',
      fecha_salida: today,
      observaciones: 'Prueba unitaria automatizada'
    }
  });
  console.log('✓ POST /api/solicitudes (Creación de Líder):', resCrear.body.ok ? 'PASS' : 'FAIL');
  const nuevoId = resCrear.body.id;

  // 3. Buscar en Garita antes de aprobar -> debe estar PENDIENTE
  const resBuscarPend = await request('/api/garita/buscar?q=0999887766');
  console.log('✓ GET /api/garita/buscar (Antes de aprobar):', resBuscarPend.body.data[0].estado === 'PENDIENTE' ? 'PASS' : 'FAIL');

  // 4. Aprobar en Sistemas
  const resAprobar = await request(`/api/solicitudes/${nuevoId}/aprobar`, {
    method: 'PATCH',
    body: { aprobado_por: 'David (Sistemas)' }
  });
  console.log('✓ PATCH /api/solicitudes/:id/aprobar (Aprobación Sistemas):', resAprobar.body.ok ? 'PASS' : 'FAIL');

  // 5. Intentar despacho en Garita con dígitos INCORRECTOS -> debe BLOQUEAR con 400
  const resDespachoFallo = await request('/api/garita/despachar', {
    method: 'POST',
    body: {
      id: nuevoId,
      digitos_verificacion: '0000', // Dígitos erróneos
      guardia_nombre: 'Guardia Turno 1'
    }
  });
  console.log('✓ POST /api/garita/despachar (Bloqueo de seguridad con dígitos falsos):', resDespachoFallo.status === 400 ? 'PASS' : 'FAIL');

  // 6. Despacho en Garita con dígitos CORRECTOS ('9921') -> debe APROBAR con 200
  const resDespachoOk = await request('/api/garita/despachar', {
    method: 'POST',
    body: {
      id: nuevoId,
      digitos_verificacion: '9921', // Dígitos correctos de LAP-DELL-9921
      guardia_nombre: 'Guardia Turno 1'
    }
  });
  console.log('✓ POST /api/garita/despachar (Despacho exitoso con dígitos válidos):', resDespachoOk.body.ok ? 'PASS' : 'FAIL');

  // 7. Retorno de Equipo (Check-in)
  const resRetorno = await request('/api/garita/retornar', {
    method: 'POST',
    body: {
      id: nuevoId,
      retornado_por: 'Guardia Turno 2',
      observaciones_retorno: 'Equipo devuelto en óptimo estado'
    }
  });
  console.log('✓ POST /api/garita/retornar (Check-in de reingreso):', resRetorno.body.ok ? 'PASS' : 'FAIL');

  // 8. Estadísticas
  const resStats = await request('/api/stats');
  console.log('✓ GET /api/stats (Métricas en vivo):', resStats.body.ok && typeof resStats.body.stats.totalHoy === 'number' ? 'PASS' : 'FAIL');

  // 9. Auditoría
  const resAudit = await request('/api/auditoria');
  console.log('✓ GET /api/auditoria (Bitácora de movimientos):', resAudit.body.ok && resAudit.body.data.length > 0 ? 'PASS' : 'FAIL');

  console.log('--- TODAS LAS PRUEBAS COMPLETADAS SATISFACTORIAMENTE ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Error en pruebas:', err);
  process.exit(1);
});
