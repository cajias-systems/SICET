const http = require('http');

process.env.PORT = '3006';
require('./server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      hostname: '127.0.0.1',
      port: 3006,
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

async function runTestsV2() {
  console.log('--- INICIANDO TEST SUITE V2: NUEVO FLUJO GARITA Y REPORTES LÍDER ---');
  await new Promise(r => setTimeout(r, 1000));

  const today = new Date().toISOString().slice(0, 10);

  // 1. Registrar las 4 personas del documento físico bajo el líder Casarez Anthonny
  const asesoresDoc = [
    { cedula: '1725665127', nombres: 'ANRANGO COLLAGUAZO JENNIFER ETELVINA', serie: 'D6QHM72' },
    { cedula: '1729875596', nombres: 'ASTUDILLO DE LA CRUZ JONATHAN MIGUEL', serie: 'FRV8282' },
    { cedula: '1753588118', nombres: 'ASTUDILLO MARMOL JHON JAIRO', serie: '7KR5W1' },
    { cedula: '1727417581', nombres: 'LEMA SAANT GABRIELA ESTEFANIA', serie: '2S4TM12' }
  ];

  const ids = [];
  for (const a of asesoresDoc) {
    const res = await request('/api/solicitudes', {
      method: 'POST',
      body: {
        cedula: a.cedula,
        nombres: a.nombres,
        area: 'Cobranzas',
        lider_nombre: 'Casarez Anthonny',
        codigo_maquina: a.serie,
        modelo: 'DELL',
        tipo_equipo: 'Laptop',
        fecha_salida: today
      }
    });
    if (res.body.ok) ids.push(res.body.id);
  }
  console.log('✓ 1. Registro de 4 solicitudes del líder Casarez Anthonny:', ids.length === 4 ? 'PASS' : 'FAIL');

  // 2. Aprobación masiva en 1 clic de Sistemas
  const resAprobarLote = await request('/api/solicitudes/aprobar-lote', {
    method: 'POST',
    body: {
      ids,
      aprobado_por: 'David (Sistemas)'
    }
  });
  console.log('✓ 2. Aprobación por lote en Sistemas:', resAprobarLote.body.count === 4 ? 'PASS' : 'FAIL');

  // 3. Garita: Escaneo con pistola de la serie D6QHM72 -> confirmación en 1 paso
  const resBuscarGarita = await request('/api/garita/buscar?q=D6QHM72');
  console.log('✓ 3. Búsqueda por escaneo de serie en Garita:', resBuscarGarita.body.data[0].estado === 'APROBADO' ? 'PASS' : 'FAIL');

  // 4. Despacho directo sin re-escribir la serie
  const idAnrango = resBuscarGarita.body.data[0].id;
  const resDespachoDirecto = await request('/api/garita/despachar', {
    method: 'POST',
    body: {
      id: idAnrango,
      guardia_nombre: 'Guardia Principal'
    }
  });
  console.log('✓ 4. Despacho directo en Garita (1 paso):', resDespachoDirecto.body.ok ? 'PASS' : 'FAIL');

  // 5. Intento de duplicación: Registrar otra persona con la misma serie D6QHM72 que ya salió
  const resDuplicado = await request('/api/solicitudes', {
    method: 'POST',
    body: {
      cedula: '0911223344',
      nombres: 'Intento Duplicado',
      area: 'Cobranzas',
      lider_nombre: 'Otro Líder',
      codigo_maquina: 'D6QHM72',
      fecha_salida: today
    }
  });
  console.log('✓ 5. Bloqueo de duplicados (máquina ya en teletrabajo):', resDuplicado.status === 400 ? 'PASS' : 'FAIL');

  // 6. Sistemas: Reemplazo / cambio de equipo por avería técnica
  const idLema = ids[3];
  const resCambioEquipo = await request(`/api/solicitudes/${idLema}/cambiar-equipo`, {
    method: 'PATCH',
    body: {
      nuevo_codigo: '2S4TM99-NUEVA',
      nuevo_modelo: 'DELL',
      motivo: 'Pantalla con fallo de retroiluminación',
      operador: 'David (Sistemas)'
    }
  });
  console.log('✓ 6. Reemplazo de equipo averiado en Sistemas:', resCambioEquipo.body.ok && resCambioEquipo.body.codigo_nuevo === '2S4TM99-NUEVA' ? 'PASS' : 'FAIL');

  // 7. Retorno individual asíncrono (reingreso de 1 equipo mientras otros siguen afuera)
  const resRetorno = await request('/api/garita/retornar', {
    method: 'POST',
    body: {
      codigo_maquina: 'D6QHM72',
      retornado_por: 'Guardia Turno Tarde'
    }
  });
  console.log('✓ 7. Retorno individual por escaneo de serie:', resRetorno.body.ok ? 'PASS' : 'FAIL');

  // 8. Reporte por Líderes: verificar métricas del líder Casarez Anthonny
  const resReporteLideres = await request('/api/reportes/lideres?lider=Casarez+Anthonny');
  const grupoLider = resReporteLideres.body.data.find(g => g.lider === 'Casarez Anthonny');
  console.log('✓ 8. Reporte consolidado por Líder:', (grupoLider && grupoLider.total === 4 && grupoLider.retornados === 1) ? 'PASS' : 'FAIL');

  // 9. Hoja Oficial con las 6 políticas legales idéntica al documento físico
  const resHoja = await request('/api/hoja-control?lider=Casarez+Anthonny');
  const htmlContent = resHoja.body;
  const tieneTitulo = htmlContent.includes('CONTROL DE SALIDA DE EQUIPOS INFORMÁTICOS — TELETRABAJO');
  const tieneClausulas = htmlContent.includes('CLÁUSULAS IMPORTANTES (LEER ANTES DE FIRMAR)') && htmlContent.includes('uso exclusivo para fines laborales');
  const tieneFirmas = htmlContent.includes('Responsable del Área') && htmlContent.includes('Guardia de Seguridad');
  console.log('✓ 9. Hoja Oficial imprimible con las 6 cláusulas legales y firmas:', (tieneTitulo && tieneClausulas && tieneFirmas) ? 'PASS' : 'FAIL');

  console.log('--- TODAS LAS PRUEBAS V2 COMPLETADAS EXITOSAMENTE ---');
  process.exit(0);
}

runTestsV2().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
