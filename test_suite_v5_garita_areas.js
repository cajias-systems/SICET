process.env.PORT = '3009';
const http = require('http');
require('./server');
const PORT = 3009;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      hostname: '127.0.0.1',
      port: PORT,
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
  console.log('--- TEST SUITE V5: GARITA PENDIENTES, CATALOGO DE AREAS Y DAVID SISTEMAS ---');
  await new Promise(r => setTimeout(r, 500));

  try {
    // 1. Validar Catalogo Oficial de Areas
    console.log('\n[1] Verificando catalogo oficial de 6 areas...');
    const resAreas = await request('/api/areas');
    const areas = resAreas.body.data.map(a => a.nombre);
    console.log('Areas encontradas:', areas);

    const areasEsperadas = [
      'Cobranzas',
      'Minimarket / Tiendita',
      'Recursos Humanos',
      'Gerencia de Cobranzas',
      'Limpieza',
      'Sistemas / TI'
    ];
    for (const esp of areasEsperadas) {
      if (!areas.includes(esp)) {
        throw new Error(`Falta el area oficial: ${esp}`);
      }
    }
    if (areas.includes('Ventas') || areas.includes('Soporte Tecnico') || areas.includes('Atención al Cliente (ATC)')) {
      throw new Error('Se encontraron areas obsoletas que debian eliminarse.');
    }
    console.log('OK - Catalogo de areas estricto y correcto (6 areas oficiales).');

    // 2. Validar Usuario David Sistemas
    console.log('\n[2] Verificando perfil unico de Sistemas (David Sistemas)...');
    const resLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'sistemas', password: 'sistemas123' }
    });
    if (!resLogin.body.ok || resLogin.body.user.nombre !== 'David Sistemas') {
      throw new Error(`El usuario de sistemas deberia ser 'David Sistemas', se obtuvo: ${resLogin.body.user ? resLogin.body.user.nombre : 'error'}`);
    }
    console.log('OK - Usuario Sistemas autenticado correctamente:', resLogin.body.user.nombre);

    // 3. Crear solicitud como Lider Jordan Trujillo
    console.log('\n[3] Creando solicitud para asesor de Jordan Trujillo en Cobranzas...');
    const testFecha = new Date().toISOString().slice(0, 10);
    const testCedula = '17' + Math.floor(10000000 + Math.random() * 89999999);
    const testSerial = 'LAP-G-' + Date.now();
    const resSol = await request('/api/solicitudes', {
      method: 'POST',
      headers: { 'x-user-role': 'lider' },
      body: {
        cedula: testCedula,
        nombres: 'ASESOR TEST GARITA FLUJO',
        area: 'Cobranzas',
        lider_nombre: 'Jordan Trujillo',
        codigo_maquina: testSerial,
        modelo: 'DELL LATITUDE',
        fecha_salida: testFecha
      }
    });
    const solId = resSol.body.id;
    console.log(`OK - Solicitud creada con ID: ${solId}, estado PENDIENTE`);

    // 4. Sistemas aprueba la solicitud
    console.log('\n[4] Sistemas aprueba la salida...');
    const resAprobar = await request(`/api/solicitudes/${solId}/aprobar`, {
      method: 'PATCH',
      headers: { 'x-user-role': 'sistemas' },
      body: { aprobado_por: 'David Sistemas' }
    });
    if (!resAprobar.body.ok) {
      throw new Error('Error al aprobar solicitud');
    }
    console.log('OK - Solicitud aprobada por David Sistemas.');

    // 5. Garita consulta pendientes de despacho
    console.log('\n[5] Garita consulta cola de pendientes de despacho...');
    const resPendientes = await request(`/api/garita/pendientes-despacho?fecha=${testFecha}`);
    if (!resPendientes.body.ok) throw new Error('Error en /api/garita/pendientes-despacho');
    const pendienteEncontrado = resPendientes.body.data.find(s => s.id === solId);
    if (!pendienteEncontrado) {
      throw new Error('La solicitud aprobada NO aparecio en la lista de pendientes de despacho de Garita.');
    }
    console.log(`OK - Solicitud #${solId} (${pendienteEncontrado.nombres} - ${pendienteEncontrado.codigo_maquina}) visible en la cola de Garita.`);

    // 6. Garita despacha la salida
    console.log('\n[6] Guardia de Garita confirma la salida fisica...');
    const resDespachar = await request('/api/garita/despachar', {
      method: 'POST',
      headers: { 'x-user-role': 'garita' },
      body: {
        id: solId,
        guardia_nombre: 'Guardia Garita Turno Tarde'
      }
    });
    if (!resDespachar.body.ok) {
      throw new Error(`Error al despachar: ${resDespachar.body.error}`);
    }
    console.log('OK - Despacho confirmado por el guardia:', resDespachar.body.message);

    // 7. Verificar que ya no esta en pendientes y ahora esta en salidas despachadas
    console.log('\n[7] Verificando transicion de estados...');
    const resPendientesAfter = await request(`/api/garita/pendientes-despacho?fecha=${testFecha}`);
    const siguePendiente = resPendientesAfter.body.data.find(s => s.id === solId);
    if (siguePendiente) {
      throw new Error('La solicitud sigue apareciendo como pendiente despues de despacharse.');
    }
    console.log('OK - Ya no aparece en la cola de pendientes.');

    const resDespachados = await request(`/api/solicitudes?fecha=${testFecha}`);
    const despachadoEncontrado = resDespachados.body.data.find(s => s.id === solId);
    if (!despachadoEncontrado || despachadoEncontrado.estado !== 'SALIO') {
      throw new Error('La solicitud no esta en estado SALIO en las salidas despachadas.');
    }
    console.log(`OK - Solicitud en estado SALIO, despachada por: ${despachadoEncontrado.despachado_por}`);

    console.log('\n======================================================');
    console.log('TODAS LAS PRUEBAS V5 PASARON SATISFACTORIAMENTE');
    console.log('======================================================');
    process.exit(0);
  } catch (error) {
    console.error('\nERROR EN TEST:', error.message);
    process.exit(1);
  }
}

runTests();
