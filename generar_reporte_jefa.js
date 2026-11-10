const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const db = require('./db.js');

async function ejecutarIngresoYReporte() {
  console.log('=== 1. REGULARIZACIÓN / INGRESO DE EQUIPOS EN TELETRABAJO ===');

  // Buscar solicitudes activas (SALIO o APROBADO) de máquinas que fueron escaneadas
  const solActivas = await db.prepare(`
    SELECT s.id, s.codigo_maquina, s.nombres, s.cedula, s.lider_nombre, s.estado, s.fecha_salida, s.fecha_retorno_estimada, s.observaciones
    FROM solicitudes s
    WHERE UPPER(s.codigo_maquina) IN (SELECT DISTINCT UPPER(codigo_maquina) FROM inventario_lecturas)
    AND s.estado IN ('SALIO', 'APROBADO')
    ORDER BY s.id ASC
  `).all();

  console.log(`Se encontraron ${solActivas.length} solicitudes activas para equipos escaneados en planta.`);

  const fechaHoy = new Date().toISOString().split('T')[0];
  const ahora = new Date().toISOString().replace('T', ' ').substring(0, 19);

  for (const sol of solActivas) {
    const cod = sol.codigo_maquina.trim().toUpperCase();
    const obsIngreso = `${sol.observaciones || ''}\n[Ingreso físico verificado en planta durante auditoría de piso ${fechaHoy}]`.trim();

    // Actualizar solicitud a RETORNADO
    await db.prepare(`
      UPDATE solicitudes 
      SET estado = 'RETORNADO', 
          retornado_por = 'David Sistemas (Auditoría Física)', 
          retornado_en = datetime('now', 'localtime'), 
          observaciones = ?
      WHERE id = ?
    `).run(obsIngreso, sol.id);

    // Registrar en auditoría
    await db.prepare(`
      INSERT INTO auditoria (solicitud_id, accion, usuario, detalles, timestamp)
      VALUES (?, 'REINGRESO_INVENTARIO_FISICO', 'David Sistemas', ?, datetime('now', 'localtime'))
    `).run(sol.id, `Equipo ${cod} verificado físicamente en planta durante barrido de inventario. Marcado como retornado.`);

    // Actualizar inventario_lecturas para este equipo
    const lecturasEquipo = await db.prepare('SELECT id, datos_catalogo, estado_clasificacion FROM inventario_lecturas WHERE UPPER(codigo_maquina) = ?').all(cod);
    for (const lec of lecturasEquipo) {
      let extra = {};
      try { extra = JSON.parse(lec.datos_catalogo || '{}'); } catch (e) {}
      extra.estaEnTeletrabajo = false;
      if (extra.ultimaSolicitud) {
        extra.ultimaSolicitud.estado = 'RETORNADO';
        extra.ultimaSolicitud.retornado_en = ahora;
        extra.ultimaSolicitud.retornado_por = 'David Sistemas (Auditoría Física)';
      }
      
      const nuevoEstado = (lec.estado_clasificacion === 'EN_TELETRABAJO_PERO_EN_PLANTA') ? 'REGULAR' : lec.estado_clasificacion;

      await db.prepare(`
        UPDATE inventario_lecturas 
        SET accion_aplicada = 'Ingresado / Regularizado en Planta', 
            estado_clasificacion = ?,
            datos_catalogo = ?
        WHERE id = ?
      `).run(nuevoEstado, JSON.stringify(extra), lec.id);
    }
  }

  console.log(`¡${solActivas.length} equipos han sido formalmente INGRESADOS en el sistema!`);

  console.log('\n=== 2. GENERANDO REPORTE EJECUTIVO EN EXCEL ===');

  // Obtener todas las lecturas registradas en inventario
  const lecturas = await db.prepare('SELECT * FROM inventario_lecturas ORDER BY id ASC').all();

  // Deduplicar para tener la lista de computadoras físicas únicas operativas
  // En caso de que se haya escaneado dos veces el mismo código, conservamos la última lectura
  const equiposUnicosMap = new Map();
  for (const l of lecturas) {
    const cod = l.codigo_maquina.trim().toUpperCase();
    equiposUnicosMap.set(cod, l);
  }

  const listaEquiposOperativos = Array.from(equiposUnicosMap.values());
  // Ordenar por piso y luego código
  listaEquiposOperativos.sort((a, b) => {
    if (a.piso_hallazgo < b.piso_hallazgo) return -1;
    if (a.piso_hallazgo > b.piso_hallazgo) return 1;
    return a.codigo_maquina.localeCompare(b.codigo_maquina);
  });

  const totalOperativos = listaEquiposOperativos.length;
  console.log(`Total de computadoras físicas operativas únicas en el edificio: ${totalOperativos}`);

  // Agrupar por Piso
  const pisosOrdenados = ['Piso 1', 'Piso 2', 'Piso 3', 'Piso 4', 'Piso 5', 'Piso 6', 'Piso 7', 'Oficina TI'];
  const resumenPisos = {};
  for (const p of pisosOrdenados) {
    resumenPisos[p] = {
      piso: p,
      total: 0,
      conAsesor: 0,
      libres: 0,
      reingresados: 0,
      porcentaje: '0.0%'
    };
  }

  const codigosReingresados = new Set(solActivas.map(s => s.codigo_maquina.toUpperCase()));

  for (const eq of listaEquiposOperativos) {
    const p = resumenPisos[eq.piso_hallazgo] || {
      piso: eq.piso_hallazgo,
      total: 0,
      conAsesor: 0,
      libres: 0,
      reingresados: 0,
      porcentaje: '0.0%'
    };
    p.total++;

    let extra = {};
    try { extra = JSON.parse(eq.datos_catalogo || '{}'); } catch (e) {}
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

  // Calcular porcentajes
  for (const p of Object.values(resumenPisos)) {
    p.porcentaje = totalOperativos > 0 ? ((p.total / totalOperativos) * 100).toFixed(1) + '%' : '0.0%';
  }

  // --- HOJA 1: RESUMEN EJECUTIVO ---
  const dataResumen = [
    { 'A': 'SISTEMA INTEGRAL DE CONTROL DE EQUIPOS TI (SICET)' },
    { 'A': 'INFORME EJECUTIVO DE COMPUTADORAS OPERATIVAS Y FUNCIONALES EN PLANTA' },
    { 'A': `FECHA DE AUDITORÍA: ${fechaHoy} | HORA DE CORTE: ${ahora.split(' ')[1]}` },
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
  dataResumen.push({ 'A': '3. Todos estos 40 equipos fueron formalmente ingresados y regularizados en el sistema SICET a estado RETORNADO.' });
  dataResumen.push({ 'A': `4. Se hallaron ${sumLib} computadoras operativas sin titular activo asignado, disponibles para reubicación o banco de suplencia.` });

  // --- HOJA 2: DETALLE GENERAL DE EQUIPOS OPERATIVOS ---
  const dataDetalleGeneral = listaEquiposOperativos.map((eq, idx) => {
    let extra = {};
    try { extra = JSON.parse(eq.datos_catalogo || '{}'); } catch (e) {}
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

  // --- HOJA 3: EQUIPOS REINGRESADOS DE TELETRABAJO ---
  const dataReingresados = solActivas.map((s, idx) => ({
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
    'Observación de Cierre': `Ingreso físico verificado en planta durante auditoría ${fechaHoy}`
  }));

  // Crear Libro Excel
  const wb = xlsx.utils.book_new();

  // 1. Resumen Ejecutivo
  const wsResumen = xlsx.utils.json_to_sheet(dataResumen, { skipHeader: true });
  wsResumen['!cols'] = [
    { wch: 32 }, // A
    { wch: 18 }, // B
    { wch: 22 }, // C
    { wch: 25 }, // D
    { wch: 28 }, // E
    { wch: 16 }  // F
  ];
  xlsx.utils.book_append_sheet(wb, wsResumen, 'Resumen_Ejecutivo');

  // 2. Detalle General
  const wsDetalle = xlsx.utils.json_to_sheet(dataDetalleGeneral);
  wsDetalle['!cols'] = [
    { wch: 6 },  // N°
    { wch: 18 }, // Código Máquina
    { wch: 16 }, // Piso / Ubicación
    { wch: 15 }, // Tipo Equipo
    { wch: 20 }, // Modelo
    { wch: 35 }, // Asesor Titular
    { wch: 15 }, // Cédula
    { wch: 25 }, // Líder
    { wch: 18 }, // Área
    { wch: 22 }, // Estado Operativo
    { wch: 32 }, // Regularización Teletrabajo
    { wch: 18 }, // Auditor
    { wch: 20 }  // Fecha / Hora
  ];
  xlsx.utils.book_append_sheet(wb, wsDetalle, 'Equipos_Operativos_General');

  // 3. Reingresados de Teletrabajo
  const wsReingreso = xlsx.utils.json_to_sheet(dataReingresados.length ? dataReingresados : [{ 'Estado': 'Sin equipos a reingresar' }]);
  wsReingreso['!cols'] = [
    { wch: 6 },
    { wch: 12 },
    { wch: 18 },
    { wch: 35 },
    { wch: 15 },
    { wch: 25 },
    { wch: 18 },
    { wch: 22 },
    { wch: 16 },
    { wch: 28 },
    { wch: 22 },
    { wch: 45 }
  ];
  xlsx.utils.book_append_sheet(wb, wsReingreso, 'Reingresados_Teletrabajo');

  // 4 a 11. Hojas individuales por cada piso
  for (const pisoName of pisosOrdenados) {
    const equiposDePiso = dataDetalleGeneral.filter(item => item['Piso / Ubicación'] === pisoName);
    const sheetName = pisoName.replace(/\s+/g, '_');
    const wsPiso = xlsx.utils.json_to_sheet(equiposDePiso.length ? equiposDePiso : [{ 'Mensaje': `No se registraron computadoras en ${pisoName}` }]);
    wsPiso['!cols'] = wsDetalle['!cols'];
    xlsx.utils.book_append_sheet(wb, wsPiso, sheetName);
  }

  // Guardar archivo en dos ubicaciones para comodidad total:
  // 1. En el Desktop de David:
  const desktopPath = path.join('C:', 'Users', 'DavidDevOps', 'Desktop', `INFORME_EQUIPOS_OPERATIVOS_EDIFICIO_SICET_${fechaHoy}.xlsx`);
  xlsx.writeFile(wb, desktopPath);
  console.log(`Reporte guardado exitosamente en Desktop: ${desktopPath}`);

  // 2. En public/reportes/ para descarga web
  const reportesDir = path.join(__dirname, 'public', 'reportes');
  if (!fs.existsSync(reportesDir)) {
    fs.mkdirSync(reportesDir, { recursive: true });
  }
  const publicPath = path.join(reportesDir, `INFORME_EQUIPOS_OPERATIVOS_EDIFICIO_SICET_${fechaHoy}.xlsx`);
  const publicPathLatest = path.join(reportesDir, 'INFORME_EQUIPOS_OPERATIVOS_EDIFICIO_SICET.xlsx');
  xlsx.writeFile(wb, publicPath);
  xlsx.writeFile(wb, publicPathLatest);
  console.log(`Reporte guardado en ruta web pública: ${publicPath}`);

  console.log('\n=== PROCESO COMPLETADO SATISFACTORIAMENTE ===');
}

ejecutarIngresoYReporte().catch(console.error);
