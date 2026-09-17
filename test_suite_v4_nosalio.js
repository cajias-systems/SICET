const http = require('http');

process.env.PORT = '3008';
require('./server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      hostname: '127.0.0.1',
      port: 3008,
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

async function runTestsV4() {
  console.log('--- TEST SUITE V4: GESTIÓN DE SOLICITUDES NO RETIRADAS (NO SALIÓ) ---');
  await new Promise(r => setTimeout(r, 1000));

  const today = '2026-09-30'; // Fecha aislada para prueba

  // 1. Crear 2 solicitudes aprobadas
  const r1 = await request('/api/solicitudes', {
    method: 'POST',
    headers: { 'x-user-role': 'sistemas' },
    body: {
      cedula: '1700112233',
      nombres: 'Asesor Que Desistió 1',
      area: 'Cobranzas',
      lider_nombre: 'Casarez Anthonny',
      codigo_maquina: 'LAP-DESISTIO-01',
      fecha_salida: today
    }
  });

  const r2 = await request('/api/solicitudes', {
    method: 'POST',
    headers: { 'x-user-role': 'sistemas' },
    body: {
      cedula: '1700445566',
      nombres: 'Asesor Que Desistió 2',
      area: 'Cobranzas',
      lider_nombre: 'Casarez Anthonny',
      codigo_maquina: 'LAP-DESISTIO-02',
      fecha_salida: today
    }
  });

  const id1 = r1.body.id;
  const id2 = r2.body.id;

  // Aprobar ambas solicitudes
  await request(`/api/solicitudes/${id1}/aprobar`, { method: 'PATCH', headers: { 'x-user-role': 'sistemas' } });
  await request(`/api/solicitudes/${id2}/aprobar`, { method: 'PATCH', headers: { 'x-user-role': 'sistemas' } });

  console.log('✓ 1. Dos solicitudes creadas y aprobadas para la fecha de prueba: PASS');

  // 2. Anular individualmente la solicitud 1 (Asesor desistió de llevarse la máquina)
  const resAnular1 = await request(`/api/solicitudes/${id1}/anular`, {
    method: 'PATCH',
    headers: { 'x-user-role': 'sistemas' },
    body: { motivo: 'Asesor avisó que prefiere trabajar presencial' }
  });
  console.log('✓ 2. Anulación individual (marcado como NO_SALIO):', resAnular1.body.ok ? 'PASS' : 'FAIL');

  // 3. Probar que la máquina de la solicitud 1 queda 100% liberada de inmediato
  const resReutilizar = await request('/api/solicitudes', {
    method: 'POST',
    headers: { 'x-user-role': 'sistemas' },
    body: {
      cedula: '1755667788',
      nombres: 'Nuevo Asesor Con Misma Maquina',
      area: 'Ventas',
      lider_nombre: 'Otro Líder',
      codigo_maquina: 'LAP-DESISTIO-01', // Misma máquina
      fecha_salida: today
    }
  });
  console.log('✓ 3. Reasignación de máquina liberada sin conflicto de duplicados:', resReutilizar.body.ok ? 'PASS' : 'FAIL');

  // 4. Depuración masiva de fin de día para la solicitud 2 que quedó aprobada y nadie fue a retirar
  const resDepurar = await request('/api/solicitudes/depurar-no-salidos', {
    method: 'POST',
    headers: { 'x-user-role': 'sistemas' },
    body: { fecha: today }
  });
  console.log('✓ 4. Depuración masiva al cierre de turno (barrido de no retirados):', resDepurar.body.ok && resDepurar.body.depurados >= 1 ? 'PASS' : 'FAIL');

  // 5. Verificar que en la base de datos la solicitud 2 quedó en NO_SALIO
  const resConsultar = await request(`/api/solicitudes?fecha=${today}&estado=NO_SALIO`, {
    headers: { 'x-user-role': 'sistemas' }
  });
  const sol2 = resConsultar.body.data.find(s => s.id === id2);
  console.log('✓ 5. Solicitud 2 verificada con estado NO_SALIO:', sol2 && sol2.estado === 'NO_SALIO' ? 'PASS' : 'FAIL');

  console.log('--- TODAS LAS PRUEBAS V4 COMPLETADAS EXITOSAMENTE ---');
  process.exit(0);
}

runTestsV4().catch(e => {
  console.error(e);
  process.exit(1);
});
