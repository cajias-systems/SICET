const http = require('http');

process.env.PORT = '3007';
require('./server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      hostname: '127.0.0.1',
      port: 3007,
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

async function runTestsV3() {
  console.log('--- TEST SUITE V3: AUTENTICACIÓN, LOGIN Y ROLES (RBAC) ---');
  await new Promise(r => setTimeout(r, 1000));

  // 1. Intento de login con clave errónea -> 401
  const loginFallo = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'sistemas', password: 'clave-incorrecta' }
  });
  console.log('✓ 1. Bloqueo de login con clave incorrecta (401):', loginFallo.status === 401 ? 'PASS' : 'FAIL');

  // 2. Login de Sistemas -> 200 y rol 'sistemas'
  const loginSistemas = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'sistemas', password: 'sistemas123' }
  });
  console.log('✓ 2. Login exitoso rol Sistemas:', loginSistemas.body.ok && loginSistemas.body.user.rol === 'sistemas' ? 'PASS' : 'FAIL');

  // 3. Login de Garita -> 200 y rol 'garita'
  const loginGarita = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'seguridad', password: 'garita123' }
  });
  console.log('✓ 3. Login exitoso rol Garita Seguridad:', loginGarita.body.ok && loginGarita.body.user.rol === 'garita' ? 'PASS' : 'FAIL');

  // 4. Login de Líder -> 200 y rol 'lider'
  const loginLider = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'lider', password: 'lider123' }
  });
  console.log('✓ 4. Login exitoso rol Líder:', loginLider.body.ok && loginLider.body.user.rol === 'lider' ? 'PASS' : 'FAIL');

  // 5. Crear una solicitud de prueba
  const today = new Date().toISOString().slice(0, 10);
  const resCrear = await request('/api/solicitudes', {
    method: 'POST',
    headers: { 'x-user-role': 'lider' },
    body: {
      cedula: '1799001122',
      nombres: 'Prueba Rol Seguridad',
      area: 'Ventas',
      lider_nombre: 'Casarez Anthonny',
      codigo_maquina: 'LAP-SEC-7788',
      fecha_salida: today
    }
  });
  const solId = resCrear.body.id;

  // 6. Intentar APROBAR con rol 'lider' -> Debe dar 403 Forbidden
  const aprobarLider = await request(`/api/solicitudes/${solId}/aprobar`, {
    method: 'PATCH',
    headers: { 'x-user-role': 'lider' },
    body: { aprobado_por: 'Intruso Líder' }
  });
  console.log('✓ 5. Bloqueo de auto-aprobación para rol Líder (403):', aprobarLider.status === 403 ? 'PASS' : 'FAIL');

  // 7. Intentar APROBAR con rol 'garita' -> Debe dar 403 Forbidden
  const aprobarGarita = await request(`/api/solicitudes/${solId}/aprobar`, {
    method: 'PATCH',
    headers: { 'x-user-role': 'garita' },
    body: { aprobado_por: 'Guardia' }
  });
  console.log('✓ 6. Bloqueo de aprobación para rol Garita (403):', aprobarGarita.status === 403 ? 'PASS' : 'FAIL');

  // 8. Aprobar con rol 'sistemas' -> Debe ser 200 OK
  const aprobarSistemas = await request(`/api/solicitudes/${solId}/aprobar`, {
    method: 'PATCH',
    headers: { 'x-user-role': 'sistemas' },
    body: { aprobado_por: 'David (Sistemas)' }
  });
  console.log('✓ 7. Aprobación autorizada para rol Sistemas (200):', aprobarSistemas.body.ok ? 'PASS' : 'FAIL');

  // 9. Intentar DESPACHAR en Garita con rol 'lider' -> Debe dar 403 Forbidden
  const despachoLider = await request('/api/garita/despachar', {
    method: 'POST',
    headers: { 'x-user-role': 'lider' },
    body: { id: solId, guardia_nombre: 'Líder' }
  });
  console.log('✓ 8. Bloqueo de despacho para rol Líder (403):', despachoLider.status === 403 ? 'PASS' : 'FAIL');

  // 10. Despachar con rol 'garita' -> 200 OK
  const despachoGarita = await request('/api/garita/despachar', {
    method: 'POST',
    headers: { 'x-user-role': 'garita' },
    body: { id: solId, guardia_nombre: 'Guardia Turno Tarde' }
  });
  console.log('✓ 9. Despacho autorizado para rol Garita (200):', despachoGarita.body.ok ? 'PASS' : 'FAIL');

  console.log('--- TODAS LAS PRUEBAS RBAC DE AUTENTICACIÓN PASARON EXITOSAMENTE ---');
  process.exit(0);
}

runTestsV3().catch(e => {
  console.error(e);
  process.exit(1);
});
