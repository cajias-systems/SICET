// =========================================================================
// SISTEMA DE CONTROL DE SALIDAS DE EQUIPOS - CLIENTE RBAC & ROLES
// =========================================================================

let currentUser = null; // { id, username, nombre, rol, area }
let selectedSolicitudesSistemas = new Set();
let debounceTimer = null;
let ultimosDespachosCache = [];
let despachosGaritaCache = [];
let equiposFueraCache = [];
let retornosHoyCache = [];
let lideresEquiposCache = [];
let lideresMovimientosCache = [];

// Obtener fecha actual en zona horaria oficial de Ecuador (America/Guayaquil, UTC-5)
function getFechaLocalEcuador(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(d);
}

// Audio context para sonidos sintetizados
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playTone(freq, type = 'sine', duration = 0.15) {
  try {
    initAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {}
}

function playSuccessSound() {
  playTone(523.25, 'sine', 0.1);
  setTimeout(() => playTone(659.25, 'sine', 0.1), 100);
  setTimeout(() => playTone(783.99, 'sine', 0.25), 200);
}

function playErrorSound() {
  playTone(220, 'sawtooth', 0.2);
  setTimeout(() => playTone(160, 'sawtooth', 0.3), 180);
}

function playLeaderSound() {
  playTone(587.33, 'triangle', 0.12);
  setTimeout(() => playTone(739.99, 'triangle', 0.12), 100);
  setTimeout(() => playTone(880, 'triangle', 0.15), 200);
  setTimeout(() => playTone(1174.66, 'sine', 0.3), 320);
}

// Wrapper para llamadas HTTP incluyendo rol en cabecera y validación robusta contra respuestas HTML (502/503/404)
async function fetchAuth(url, options = {}) {
  const headers = options.headers || {};
  if (currentUser && currentUser.rol) {
    headers['x-user-role'] = currentUser.rol;
  }
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) {
      throw new Error(`El servidor se está reiniciando o actualizando (${res.status}). Por favor espere unos segundos e intente nuevamente.`);
    }
    throw new Error('La respuesta del servidor no tiene formato JSON válido.');
  }
  return res;
}

// =========================================================================
// GESTIÓN DE SESIÓN Y LOGIN
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
  actualizarReloj();
  setInterval(actualizarReloj, 1000);

  // Cargar combo de los 27 líderes oficiales para el login
  cargarComboLideresLogin();

  // Verificar si hay sesión activa guardada
  const sesionGuardada = sessionStorage.getItem('salidas_usuario_activo');
  if (sesionGuardada) {
    try {
      currentUser = JSON.parse(sesionGuardada);
      mostrarAplicacion();
    } catch (e) {
      sessionStorage.removeItem('salidas_usuario_activo');
      mostrarLogin();
    }
  } else {
    mostrarLogin();
  }

  // Pre-seleccionar rol Sistemas por conveniencia en login
  seleccionarRolRapido('sistemas');
  lucide.createIcons();
});

async function cargarComboLideresLogin() {
  try {
    const res = await fetch('/api/lideres-directorio');
    const json = await res.json();
    if (json.ok && json.data) {
      const select = document.getElementById('loginSelectLider');
      if (select) {
        // Filtrar estrictamente solo líderes reales (excluir sistemas, seguridad o garita)
        const soloLideres = json.data.filter(l => {
          const n = (l.nombre || '').toLowerCase();
          const nc = (l.nombre_completo || '').toLowerCase();
          return !n.includes('sistemas') && !nc.includes('sistemas') && !n.includes('seguridad') && !n.includes('garita');
        });
        select.innerHTML = soloLideres.map(l => `<option value="${l.nombre}">${l.nombre}</option>`).join('');
      }
    }
  } catch (e) {
    console.error('Error cargando combo líderes para login:', e);
  }
}

function seleccionarRolRapido(rol) {
  const userInp = document.getElementById('loginUsername');
  const passInp = document.getElementById('loginPassword');
  const btnS = document.getElementById('btnRolSistemas');
  const btnG = document.getElementById('btnRolGarita');
  const btnL = document.getElementById('btnRolLider');
  const campoUser = document.getElementById('campoUsuarioTexto');
  const campoLider = document.getElementById('campoComboLideres');

  [btnS, btnG, btnL].forEach(b => {
    if (b) {
      b.classList.remove('border-blue-500', 'border-emerald-500', 'border-purple-500', 'bg-blue-50', 'bg-emerald-50', 'bg-purple-50');
      b.classList.add('border-slate-200', 'bg-slate-50');
    }
  });

  if (passInp) passInp.value = '';

  if (rol === 'sistemas') {
    if (btnS) {
      btnS.classList.remove('border-slate-200', 'bg-slate-50');
      btnS.classList.add('border-blue-500', 'bg-blue-50');
    }
    if (campoUser) campoUser.classList.remove('hidden');
    if (campoLider) campoLider.classList.add('hidden');
    if (userInp) userInp.value = 'sistemas';
  } else if (rol === 'garita') {
    if (btnG) {
      btnG.classList.remove('border-slate-200', 'bg-slate-50');
      btnG.classList.add('border-emerald-500', 'bg-emerald-50');
    }
    if (campoUser) campoUser.classList.remove('hidden');
    if (campoLider) campoLider.classList.add('hidden');
    if (userInp) userInp.value = 'seguridad';
  } else if (rol === 'lider') {
    if (btnL) {
      btnL.classList.remove('border-slate-200', 'bg-slate-50');
      btnL.classList.add('border-purple-500', 'bg-purple-50');
    }
    if (campoUser) campoUser.classList.add('hidden');
    if (campoLider) campoLider.classList.remove('hidden');
  }

  if (passInp) passInp.focus();
}

async function ejecutarLogin(e) {
  e.preventDefault();
  const passInp = document.getElementById('loginPassword');
  const password = passInp ? passInp.value.trim() : '';
  const errorMsg = document.getElementById('loginErrorMsg');
  const btn = document.getElementById('btnLoginSubmit');
  const campoLider = document.getElementById('campoComboLideres');

  let body = {};
  if (campoLider && !campoLider.classList.contains('hidden')) {
    const selectLider = document.getElementById('loginSelectLider');
    const lider_nombre = selectLider ? selectLider.value : '';
    body = { lider_nombre, password };
  } else {
    const username = document.getElementById('loginUsername').value.trim();
    body = { username, password };
  }

  errorMsg.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = 'Verificando credenciales...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();

    if (!json.ok) {
      playErrorSound();
      errorMsg.textContent = json.error || 'Credenciales incorrectas.';
      errorMsg.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = '<span>INGRESAR AL SISTEMA</span><i data-lucide="arrow-right" class="w-4 h-4"></i>';
      lucide.createIcons();
      return;
    }

    // Login exitoso
    currentUser = json.user;
    sessionStorage.setItem('salidas_usuario_activo', JSON.stringify(currentUser));
    playSuccessSound();
    mostrarAplicacion();
  } catch (err) {
    errorMsg.textContent = 'Error de conexión con el servidor: ' + err.message;
    errorMsg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>INGRESAR AL SISTEMA</span><i data-lucide="arrow-right" class="w-4 h-4"></i>';
    lucide.createIcons();
  }
}

function ejecutarLogout() {
  if (!confirm('¿Desea cerrar la sesión actual?')) return;
  if (window.liderInterval) clearInterval(window.liderInterval);
  sessionStorage.removeItem('salidas_usuario_activo');
  currentUser = null;
  mostrarLogin();
}

function mostrarLogin() {
  document.getElementById('vista-login').classList.remove('hidden');
  document.getElementById('vista-app').classList.add('hidden');
  const loginPass = document.getElementById('loginPassword');
  if (loginPass) loginPass.value = '';
}

function mostrarAplicacion() {
  document.getElementById('vista-login').classList.add('hidden');
  document.getElementById('vista-app').classList.remove('hidden');

  // Actualizar datos del usuario en cabecera
  document.getElementById('appUsuarioNombre').textContent = currentUser.nombre;
  const badgeRol = document.getElementById('headerRolBadge');
  const subtitulo = document.getElementById('headerSubtituloArea');

  if (currentUser.rol === 'sistemas') {
    badgeRol.className = 'text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-400/30';
    badgeRol.textContent = 'ADMINISTRADOR TI';
    subtitulo.textContent = 'Control Total de Autorizaciones, Reportes y Auditoría';
  } else if (currentUser.rol === 'garita') {
    badgeRol.className = 'text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-400/30';
    badgeRol.textContent = 'SEGURIDAD FÍSICA';
    subtitulo.textContent = 'Ventanilla de Garita — Modo Pistola / Despacho Rápido';
  } else if (currentUser.rol === 'lider') {
    badgeRol.className = 'text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-400/30';
    badgeRol.textContent = 'LÍDER DE ÁREA';
    subtitulo.textContent = `Gestión de Salidas para Teletrabajo — ${currentUser.area || 'Campaña'}`;
  }

  // APLICAR RESTRICCIONES ESTRICTAS EN LA BARRA DE NAVEGACIÓN
  configurarPermisosNavegacion(currentUser.rol);

  // Inicializar catálogos y módulos
  cargarAreas();
  cargarLideresSelectores();

  const today = getFechaLocalEcuador();
  const elFechaSistemas = document.getElementById('filtroSistemasFecha');
  if (elFechaSistemas) elFechaSistemas.value = today;

  const elFechaSalidaLider = document.getElementById('liderInputFechaSalida');
  if (elFechaSalidaLider) elFechaSalidaLider.value = today;

  const elFechaRetornoLider = document.getElementById('liderInputFechaRetorno');
  if (elFechaRetornoLider) elFechaRetornoLider.value = today;

  const elReporteDesde = document.getElementById('reporteFechaDesde');
  const elReporteHasta = document.getElementById('reporteFechaHasta');
  if (elReporteDesde) elReporteDesde.value = '';
  if (elReporteHasta) elReporteHasta.value = '';

  // Redirigir al módulo por defecto del rol
  if (currentUser.rol === 'garita') {
    cambiarModulo('garita');
  } else if (currentUser.rol === 'lider') {
    // Si es líder, auto-llenar su nombre y bloquearlo para que no pueda enviar a nombre de otro
    const inputLiderNombre = document.getElementById('liderInputNombre');
    if (inputLiderNombre) {
      inputLiderNombre.value = currentUser.nombre;
      inputLiderNombre.readOnly = true;
      inputLiderNombre.classList.add('bg-slate-100');
    }
    cambiarModulo('lideres');
  } else {
    // Sistemas
    cambiarModulo('sistemas');
  }

  if (window.liderInterval) clearInterval(window.liderInterval);
  if (currentUser.rol === 'lider') {
    window.liderInterval = setInterval(() => {
      const vistaLider = document.getElementById('modulo-lideres');
      if (vistaLider && !vistaLider.classList.contains('hidden')) {
        cargarSolicitudesLiderHoy();
        cargarMiEquipoHabitual();
      }
    }, 20000);
  }

  actualizarMetricasGenerales();
  lucide.createIcons();
}

// Configuración de visibilidad de pestañas según rol
function configurarPermisosNavegacion(rol) {
  const navGarita = document.getElementById('nav-garita');
  const navSistemas = document.getElementById('nav-sistemas');
  const navReporte = document.getElementById('nav-reporte-lideres');
  const navLideres = document.getElementById('nav-lideres');
  const navRetornos = document.getElementById('nav-retornos');
  const navLideresEquipos = document.getElementById('nav-lideres-equipos');
  const navAuditoria = document.getElementById('nav-auditoria');

  // Restablecer visibilidad
  [navGarita, navSistemas, navReporte, navLideres, navRetornos, navLideresEquipos, navAuditoria].forEach(el => {
    if (el) el.classList.remove('hidden');
  });

  const btnAgregarLider = document.getElementById('btnAgregarNuevoLiderEnEquipos');
  const thGestionTI = document.getElementById('thGestionTILideres');

  if (rol === 'garita') {
    // El guardia ve Garita, Retornos y Laptops Líderes (solo lectura y despacho)
    if (navSistemas) navSistemas.classList.add('hidden');
    if (navReporte) navReporte.classList.add('hidden');
    if (navLideres) navLideres.classList.add('hidden');
    if (navAuditoria) navAuditoria.classList.add('hidden');
    if (btnAgregarLider) btnAgregarLider.classList.add('hidden');
    if (thGestionTI) thGestionTI.classList.add('hidden');
  } else if (rol === 'lider') {
    // El líder solo ve el portal de registro de su propio equipo
    if (navGarita) navGarita.classList.add('hidden');
    if (navSistemas) navSistemas.classList.add('hidden');
    if (navReporte) navReporte.classList.add('hidden');
    if (navRetornos) navRetornos.classList.add('hidden');
    if (navLideresEquipos) navLideresEquipos.classList.add('hidden');
    if (navAuditoria) navAuditoria.classList.add('hidden');
    if (btnAgregarLider) btnAgregarLider.classList.add('hidden');
    if (thGestionTI) thGestionTI.classList.add('hidden');
  } else if (rol === 'sistemas') {
    // Sistemas ve absolutamente todo y tiene control total de gestión
    if (btnAgregarLider) btnAgregarLider.classList.remove('hidden');
    if (thGestionTI) thGestionTI.classList.remove('hidden');
  }
}

// =========================================================================
// NAVEGACIÓN Y RELOJ
// =========================================================================

function actualizarReloj() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('es-ES', { hour12: false });
  const dateStr = now.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const elTime = document.getElementById('liveTime');
  const elDate = document.getElementById('liveDate');
  if (elTime) elTime.textContent = timeStr;
  if (elDate) elDate.textContent = dateStr;
}

function cambiarModulo(moduloId) {
  const modulos = ['garita', 'sistemas', 'reporte-lideres', 'lideres', 'retornos', 'lideres-equipos', 'auditoria'];
  modulos.forEach(m => {
    const el = document.getElementById(`modulo-${m}`);
    const nav = document.getElementById(`nav-${m}`);
    if (el) el.classList.add('hidden');
    if (nav) {
      nav.classList.remove('bg-emerald-600', 'bg-blue-600', 'bg-purple-600', 'text-white', 'shadow-sm');
      nav.classList.add('text-slate-300', 'hover:text-white', 'hover:bg-slate-800');
    }
  });

  const activo = document.getElementById(`modulo-${moduloId}`);
  const navActivo = document.getElementById(`nav-${moduloId}`);
  if (activo) activo.classList.remove('hidden');
  if (navActivo) {
    let activeColor = 'bg-blue-600';
    if (moduloId === 'garita' || moduloId === 'retornos') activeColor = 'bg-emerald-600';
    if (moduloId === 'lideres-equipos') activeColor = 'bg-purple-600';
    navActivo.classList.add(activeColor, 'text-white', 'shadow-sm');
    navActivo.classList.remove('text-slate-300', 'hover:text-white', 'hover:bg-slate-800');
  }

  if (moduloId === 'garita') {
    cargarTodoGarita();
    const input = document.getElementById('inputGaritaBusqueda');
    if (input) input.focus();
  } else if (moduloId === 'sistemas') {
    cargarSolicitudesSistemas();
    actualizarMetricasGenerales();
    cargarLideresSelectores();
  } else if (moduloId === 'reporte-lideres') {
    cargarReporteLideres();
  } else if (moduloId === 'lideres') {
    cargarMiEquipoHabitual();
    cargarSolicitudesLiderHoy();
  } else if (moduloId === 'retornos') {
    cargarEquiposFuera();
    cargarRetornosHoy();
    const inputRet = document.getElementById('inputEscaneoRetorno');
    if (inputRet) inputRet.focus();
  } else if (moduloId === 'lideres-equipos') {
    cargarLideresEquipos();
    cargarBitacoraMovimientosLideres();
    const inputLid = document.getElementById('inputEscaneoLider');
    if (inputLid) inputLid.focus();
  } else if (moduloId === 'auditoria') {
    cargarAuditoria();
  }

  lucide.createIcons();
}

async function cargarAreas() {
  try {
    const res = await fetchAuth('/api/areas');
    const json = await res.json();
    if (json.ok) {
      const selectLider = document.getElementById('liderSelectArea');
      if (selectLider) {
        // Los líderes de operaciones solo gestionan sus colaboradores (Cobranzas y Auditoría)
        const areasLider = ['Cobranzas', 'Auditoría'];
        selectLider.innerHTML = areasLider.map(a => `<option value="${a}">${a}</option>`).join('');
      }
    }
  } catch (e) {}
}

async function cargarLideresSelectores() {
  try {
    const res = await fetchAuth('/api/lideres');
    const json = await res.json();
    if (json.ok) {
      const selectSistemas = document.getElementById('filtroSistemasLider');
      const selectReporte = document.getElementById('reporteFiltroLider');

      let optionsHtml = '<option value="TODOS">Todos los Líderes</option>';
      json.data.forEach(l => {
        optionsHtml += `<option value="${l.nombre}">${l.nombre} (${l.area})</option>`;
      });

      if (selectSistemas) selectSistemas.innerHTML = optionsHtml;
      if (selectReporte) selectReporte.innerHTML = optionsHtml;
    }
  } catch (e) {}
}

// =========================================================================
// SECCIÓN 1: GARITA (MODO PISTOLA 1-PASO)
// =========================================================================

function cambiarSubtabGarita(subtab) {
  const btnDespacho = document.getElementById('subtab-garita-despacho');
  const btnBitacora = document.getElementById('subtab-garita-bitacora');
  const vistaDespacho = document.getElementById('garita-vista-despacho');
  const vistaBitacora = document.getElementById('garita-vista-bitacora');

  if (subtab === 'despacho') {
    btnDespacho.className = 'px-4 py-2 rounded-xl text-sm font-black bg-emerald-600 text-white shadow-sm flex items-center gap-2';
    btnBitacora.className = 'px-4 py-2 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-200 flex items-center gap-2';
    vistaDespacho.classList.remove('hidden');
    vistaBitacora.classList.add('hidden');
    const input = document.getElementById('inputGaritaBusqueda');
    if (input) input.focus();
  } else {
    btnBitacora.className = 'px-4 py-2 rounded-xl text-sm font-black bg-emerald-600 text-white shadow-sm flex items-center gap-2';
    btnDespacho.className = 'px-4 py-2 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-200 flex items-center gap-2';
    vistaBitacora.classList.remove('hidden');
    vistaDespacho.classList.add('hidden');
    renderizarBitacoraCompleta();
  }
  lucide.createIcons();
}

async function buscarEnGarita(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('inputGaritaBusqueda');
  const term = input.value.trim();
  const container = document.getElementById('contenedorResultadoGarita');

  if (!term) return;

  try {
    const res = await fetchAuth(`/api/garita/buscar?q=${encodeURIComponent(term)}`);
    const json = await res.json();

    container.classList.remove('hidden');

    // 1. Interceptar Pase Libre Autorizado de Líderes de Operaciones
    if (json.ok && json.encontrado && json.es_lider && json.lider) {
      renderizarPaseLibreLiderEnGarita(json.lider);
      return;
    }

    if (!json.ok || !json.encontrado || !Array.isArray(json.data) || json.data.length === 0 || !json.data[0]) {
      playErrorSound();
      container.innerHTML = `
        <div class="bg-rose-50 border-4 border-rose-600 text-rose-950 p-6 rounded-3xl shadow-xl shake-error">
          <div class="flex items-start gap-4">
            <div class="p-4 bg-rose-200 text-rose-900 rounded-2xl">
              <i data-lucide="shield-alert" class="w-10 h-10"></i>
            </div>
            <div class="flex-1">
              <span class="px-3 py-1 bg-rose-600 text-white text-xs font-black uppercase rounded-full tracking-wider">
                ¡DENEGADO / NO AUTORIZADO!
              </span>
              <h2 class="text-2xl sm:text-3xl font-black text-rose-900 mt-2">NO EXISTE AUTORIZACIÓN PARA: ${term}</h2>
              <p class="text-sm font-bold text-rose-800 mt-1">Esta serie o cédula NO está en la lista de aprobaciones de hoy enviada por Sistemas.</p>
              <div class="mt-3 p-3 bg-white/80 border border-rose-300 rounded-xl text-xs font-semibold text-rose-900">
                🛑 <strong>Protocolo de Garita:</strong> No permita la salida del equipo físico. Indique al asesor que debe regularizar con su Líder y Sistemas.
              </div>
            </div>
            <button onclick="limpiarGarita()" class="px-4 py-2 bg-rose-200 hover:bg-rose-300 text-rose-950 rounded-xl text-xs font-black">Cerrar</button>
          </div>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    // Seleccionar el registro más relevante (priorizar APROBADO de hoy o SALIO)
    let item = json.data[0];
    const itemAprobado = json.data.find(d => d.estado === 'APROBADO');
    if (itemAprobado) {
      item = itemAprobado;
    } else {
      const itemSalio = json.data.find(d => d.estado === 'SALIO');
      if (itemSalio) item = itemSalio;
    }

    renderizarResultadoGarita(item);
  } catch (error) {
    showToast('Error en garita: ' + error.message, 'error');
  }
}

function renderizarResultadoGarita(item) {
  const container = document.getElementById('contenedorResultadoGarita');
  if (!container || !item) return;

  container.innerHTML = ''; // Limpiar previo antes de renderizar

  if (item.estado === 'APROBADO') {
    container.innerHTML = `
      <div class="bg-emerald-50 border-4 border-emerald-500 rounded-3xl p-6 sm:p-8 shadow-2xl card-success-pulse">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-emerald-200">
          <div class="flex items-center gap-5">
            <div class="w-20 h-20 rounded-2xl bg-emerald-600 text-white flex items-center justify-center font-black text-3xl shadow-lg">
              ${item.nombres.charAt(0)}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="px-3 py-1 bg-emerald-600 text-white text-xs font-black uppercase rounded-full tracking-wider">
                  ✓ APROBADO POR SISTEMAS
                </span>
                <span class="text-xs text-emerald-800 font-bold">Autorizado: ${item.fecha_salida}</span>
              </div>
              <h2 class="text-2xl sm:text-4xl font-black text-slate-900 tracking-tight mt-1">${item.nombres}</h2>
              <div class="flex flex-wrap items-center gap-3 text-sm text-slate-700 mt-1 font-semibold">
                <span>Cédula: <strong class="font-mono text-slate-950 bg-white px-2 py-0.5 rounded border border-emerald-300">${item.cedula}</strong></span>
                <span>&bull;</span>
                <span>Líder: <strong class="text-slate-900">${item.lider_nombre || 'N/A'}</strong></span>
                <span>&bull;</span>
                <span>Área: <strong class="text-emerald-900">${item.area}</strong></span>
              </div>
            </div>
          </div>

          <div class="bg-white px-6 py-4 rounded-2xl border-2 border-emerald-400 text-center shadow-md">
            <div class="text-[11px] uppercase font-black text-emerald-800 tracking-wider">N° de Serie Físico Autorizado</div>
            <div class="text-3xl font-mono font-black text-blue-700 mt-1 tracking-widest">${item.codigo_maquina}</div>
            <div class="text-xs font-bold text-slate-600 mt-0.5">Modelo: ${item.modelo || 'DELL'} &bull; ${item.tipo_equipo || 'Laptop'}</div>
          </div>
        </div>

        <div class="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-emerald-100/70 p-4 sm:p-5 rounded-2xl border border-emerald-300">
          <div class="flex items-center gap-3 text-emerald-900">
            <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-600 flex-shrink-0"></i>
            <div>
              <div class="font-black text-base">Equipo comprobado por el lector óptico</div>
              <div class="text-xs text-emerald-800 font-medium">Presione el botón verde o pulse ENTER en su teclado para registrar la salida.</div>
            </div>
          </div>

          <button 
            type="button" 
            id="btnConfirmarSalidaDirecta"
            onclick="confirmarSalidaDirecta(${item.id})"
            class="touch-btn w-full sm:w-auto px-10 py-5 bg-emerald-600 hover:bg-emerald-500 text-white text-lg font-black rounded-2xl shadow-xl shadow-emerald-600/30 flex items-center justify-center gap-3 transition-all transform active:scale-95"
            autofocus
          >
            <i data-lucide="log-out" class="w-7 h-7"></i>
            <span>CONFIRMAR SALIDA (ENTER)</span>
          </button>
        </div>
      </div>
    `;

    setTimeout(() => {
      const btn = document.getElementById('btnConfirmarSalidaDirecta');
      if (btn) btn.focus();
    }, 150);

  } else if (item.estado === 'PENDIENTE') {
    playErrorSound();
    container.innerHTML = `
      <div class="bg-amber-50 border-4 border-amber-400 text-amber-950 p-6 sm:p-8 rounded-3xl shadow-xl">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-amber-200 text-amber-900 rounded-2xl">
            <i data-lucide="clock" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-amber-500 text-slate-950 text-xs font-black uppercase rounded-full">SOLICITUD PENDIENTE</span>
            <h2 class="text-2xl sm:text-3xl font-black text-slate-900 mt-2">${item.nombres} (${item.cedula})</h2>
            <p class="text-sm font-semibold text-slate-800 mt-1">Registrado por: <strong>${item.lider_nombre} (${item.area})</strong></p>
            <div class="mt-4 p-4 bg-amber-100 rounded-xl border border-amber-300 text-xs font-bold text-amber-900">
              ⚠️ <strong>ATENCIÓN GUARDIA:</strong> Esta solicitud NO ha sido autorizada aún por el área de Sistemas. No permita la salida del equipo hasta que Sistemas la apruebe.
            </div>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-amber-200 text-amber-950 rounded-xl text-xs font-black">Cerrar</button>
        </div>
      </div>
    `;
  } else if (item.estado === 'SALIO') {
    container.innerHTML = `
      <div class="bg-blue-50 border-4 border-blue-400 text-blue-950 p-6 sm:p-8 rounded-3xl shadow-xl">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-blue-200 text-blue-900 rounded-2xl">
            <i data-lucide="info" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-blue-600 text-white text-xs font-black uppercase rounded-full">EQUIPO YA EN TELETRABAJO</span>
            <h2 class="text-2xl sm:text-3xl font-black text-slate-900 mt-2">${item.nombres} (${item.cedula})</h2>
            <p class="text-sm text-slate-800 mt-1">El equipo <strong>${item.codigo_maquina} (${item.modelo || 'DELL'})</strong> ya registra salida previa a las <strong>${item.despachado_en || 'Hoy'}</strong> despachado por <strong>${item.despachado_por || 'Garita'}</strong>.</p>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-blue-200 text-blue-950 rounded-xl text-xs font-black">Cerrar</button>
        </div>
      </div>
    `;
  } else if (item.estado === 'RETORNADO') {
    container.innerHTML = `
      <div class="bg-cyan-50 border-4 border-cyan-500 text-cyan-950 p-6 sm:p-8 rounded-3xl shadow-xl">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-cyan-200 text-cyan-900 rounded-2xl">
            <i data-lucide="check-check" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-cyan-600 text-white text-xs font-black uppercase rounded-full">EQUIPO YA RETORNADO / EN PLANTA</span>
            <h2 class="text-2xl sm:text-3xl font-black text-slate-900 mt-2">${item.nombres} (${item.cedula})</h2>
            <p class="text-sm text-slate-800 mt-1">El equipo <strong>${item.codigo_maquina} (${item.modelo || 'DELL'})</strong> ya registró retorno el <strong>${item.retornado_en || 'Hoy'}</strong> recibido por <strong>${item.retornado_por || 'Garita'}</strong>.</p>
            <div class="mt-3 p-3 bg-white border border-cyan-300 rounded-xl text-xs font-bold text-cyan-900">
              🛑 <strong>Aviso:</strong> El equipo ya se encuentra dentro de las instalaciones. Para una nueva salida a teletrabajo, el Líder debe generar una nueva solicitud.
            </div>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-cyan-200 text-cyan-950 rounded-xl text-xs font-black">Cerrar</button>
        </div>
      </div>
    `;
  } else if (item.estado === 'RECHAZADO') {
    playErrorSound();
    container.innerHTML = `
      <div class="bg-rose-50 border-4 border-rose-500 text-rose-950 p-6 sm:p-8 rounded-3xl shadow-xl">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-rose-200 text-rose-900 rounded-2xl">
            <i data-lucide="x-circle" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-rose-600 text-white text-xs font-black uppercase rounded-full">SALIDA RECHAZADA</span>
            <h2 class="text-2xl sm:text-3xl font-black text-slate-900 mt-2">${item.nombres} (${item.cedula})</h2>
            <div class="mt-2 p-3 bg-rose-100 rounded-xl border border-rose-300 text-xs font-bold text-rose-900">
              Motivo de rechazo de Sistemas: ${item.motivo_rechazo || 'No autorizado'}
            </div>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-rose-200 text-rose-950 rounded-xl text-xs font-black">Cerrar</button>
        </div>
      </div>
    `;
  } else if (item.estado === 'NO_SALIO') {
    playErrorSound();
    container.innerHTML = `
      <div class="bg-slate-50 border-4 border-slate-400 text-slate-950 p-6 sm:p-8 rounded-3xl shadow-xl">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-slate-200 text-slate-900 rounded-2xl">
            <i data-lucide="ban" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-slate-600 text-white text-xs font-black uppercase rounded-full">SOLICITUD ANULADA / NO RETIRÓ</span>
            <h2 class="text-2xl sm:text-3xl font-black text-slate-900 mt-2">${item.nombres} (${item.cedula})</h2>
            <p class="text-sm text-slate-800 mt-1">La salida programada fue anulada: <em>${item.observaciones || 'No retiró el equipo'}</em>.</p>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-slate-200 text-slate-950 rounded-xl text-xs font-black">Cerrar</button>
        </div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="bg-slate-50 border-4 border-slate-300 text-slate-900 p-6 rounded-3xl shadow-xl">
        <h2 class="text-xl font-bold">${item.nombres} (${item.cedula})</h2>
        <p class="text-sm">Estado actual: <strong>${item.estado}</strong> - Equipo: <strong>${item.codigo_maquina}</strong></p>
        <button onclick="limpiarGarita()" class="mt-3 px-4 py-2 bg-slate-200 text-slate-900 rounded-xl text-xs font-black">Cerrar</button>
      </div>
    `;
  }

  lucide.createIcons();
}

async function confirmarSalidaDirecta(id) {
  try {
    const res = await fetchAuth('/api/garita/despachar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        guardia_nombre: currentUser ? currentUser.nombre : 'Guardia Garita'
      })
    });

    const json = await res.json();

    if (!json.ok) {
      playErrorSound();
      alert(json.error || 'Error al despachar salida.');
      return;
    }

    playSuccessSound();
    showToast(`✓ Salida confirmada para: ${json.asesor} (${json.codigo_maquina})`, 'success');

    limpiarGarita();
    await cargarTodoGarita();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function limpiarGarita() {
  const input = document.getElementById('inputGaritaBusqueda');
  const container = document.getElementById('contenedorResultadoGarita');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (container) container.classList.add('hidden');
}

// Cargar equipos autorizados por Sistemas que están pendientes de retiro en Garita
let pendientesGaritaCache = [];

async function cargarPendientesDespachoGarita() {
  try {
    const today = getFechaLocalEcuador();
    const res = await fetchAuth(`/api/garita/pendientes-despacho?fecha=${today}`);
    const json = await res.json();

    const tbody = document.getElementById('tablaPendientesDespachoGarita');
    const badge = document.getElementById('badgeConteoPendientesGarita');
    const stat = document.getElementById('statGaritaPendientes');

    if (!json.ok || !json.data || json.data.length === 0) {
      pendientesGaritaCache = [];
      actualizarComboFiltroLideresGarita([]);
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="py-8 text-center text-slate-400">
              <div class="flex flex-col items-center justify-center gap-2">
                <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-500/70"></i>
                <p class="font-bold text-slate-600">No hay laptops pendientes de retiro en este momento.</p>
                <p class="text-xs text-slate-400">Todas las autorizaciones fueron despachadas o no se han emitido nuevas autorizaciones hoy.</p>
              </div>
            </td>
          </tr>
        `;
        lucide.createIcons();
      }
      if (badge) {
        badge.textContent = '0 pendientes';
        badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200';
      }
      if (stat) stat.textContent = '0';
      return;
    }

    pendientesGaritaCache = json.data;
    if (badge) {
      badge.textContent = `${pendientesGaritaCache.length} ${pendientesGaritaCache.length === 1 ? 'pendiente' : 'pendientes'}`;
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-600 text-white shadow-sm';
    }
    if (stat) stat.textContent = pendientesGaritaCache.length;

    actualizarComboFiltroLideresGarita(pendientesGaritaCache);
    filtrarPendientesGaritaPorLider();
  } catch (error) {
    console.error('Error cargando pendientes en garita:', error);
  }
}

function actualizarComboFiltroLideresGarita(items) {
  const select = document.getElementById('filtroGaritaLider');
  if (!select) return;

  const currentVal = select.value || 'TODOS';
  const conteoPorLider = {};
  items.forEach(it => {
    const l = (it.lider_nombre || 'Sin Líder').trim();
    conteoPorLider[l] = (conteoPorLider[l] || 0) + 1;
  });

  let options = `<option value="TODOS">Todos los Líderes (${items.length})</option>`;
  Object.keys(conteoPorLider).sort().forEach(l => {
    options += `<option value="${l}">${l} (${conteoPorLider[l]})</option>`;
  });
  select.innerHTML = options;

  if (conteoPorLider[currentVal] !== undefined || currentVal === 'TODOS') {
    select.value = currentVal;
  } else {
    select.value = 'TODOS';
  }
}

function filtrarPendientesGaritaPorLider() {
  const select = document.getElementById('filtroGaritaLider');
  const lider = select ? select.value : 'TODOS';
  const tbody = document.getElementById('tablaPendientesDespachoGarita');
  if (!tbody) return;

  let items = pendientesGaritaCache;
  if (lider && lider !== 'TODOS') {
    items = items.filter(it => (it.lider_nombre || 'Sin Líder').trim() === lider);
  }

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center text-slate-400">
          <p class="font-bold text-slate-600">No hay laptops pendientes para el líder seleccionado.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => {
    return `
      <tr class="hover:bg-emerald-50/50 transition">
        <td class="py-3 px-4">
          <div class="font-black text-slate-900">${item.nombres}</div>
          <div class="text-[11px] text-slate-500 font-semibold">Salida: ${item.fecha_salida}</div>
        </td>
        <td class="py-3 px-4 font-mono text-xs font-bold text-slate-700">${item.cedula}</td>
        <td class="py-3 px-4">
          <button 
            onclick="seleccionarSerieParaEscanear('${item.codigo_maquina}')" 
            class="font-mono text-xs font-black text-blue-700 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg border border-blue-200 tracking-wider shadow-sm flex items-center gap-1.5 transition"
            title="Haga clic para cargar este código en el escáner"
          >
            <i data-lucide="barcode" class="w-3.5 h-3.5"></i>
            <span>${item.codigo_maquina}</span>
          </button>
        </td>
        <td class="py-3 px-4 font-bold text-xs text-slate-700">${item.modelo || 'DELL'}</td>
        <td class="py-3 px-4">
          <span class="inline-block px-2.5 py-1 bg-purple-100 text-purple-900 border border-purple-200 rounded-lg text-xs font-black shadow-xs">
            ${item.lider_nombre || 'N/A'}
          </span>
          <div class="text-[11px] font-semibold text-emerald-800 mt-0.5">${item.area}</div>
        </td>
        <td class="py-3 px-4 text-xs font-semibold text-slate-600">${item.aprobado_por || 'Sistemas'}</td>
        <td class="py-3 px-4 text-center">
          <button 
            onclick="confirmarSalidaDirecta(${item.id})"
            class="touch-btn px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black rounded-xl shadow-md flex items-center justify-center gap-1.5 transition mx-auto active:scale-95"
            title="Confirmar salida física del asesor"
          >
            <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
            <span>DESPACHAR</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');
  lucide.createIcons();
}

function seleccionarSerieParaEscanear(serie) {
  const input = document.getElementById('inputGaritaBusqueda');
  if (input) {
    input.value = serie;
    input.focus();
    buscarEnGarita();
  }
}

async function cargarTodoGarita() {
  await Promise.all([
    cargarPendientesDespachoGarita(),
    cargarDespachosRecientesGarita()
  ]);
  actualizarMetricasGenerales();
}

async function cargarDespachosRecientesGarita() {
  try {
    const today = getFechaLocalEcuador();
    const res = await fetchAuth(`/api/garita/despachos-turno?fecha=${today}`);
    const json = await res.json();

    const tbody = document.getElementById('tablaDespachosHoy');
    const badge = document.getElementById('badgeConteoDespachadosGarita');
    if (!tbody) return;

    if (!json.ok || !json.data || json.data.length === 0) {
      despachosGaritaCache = [];
      ultimosDespachosCache = [];
      actualizarComboFiltroDespachadosLider([]);
      tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400 font-medium">Aún no ha salido ningún asesor por la garita en este turno.</td></tr>`;
      if (badge) {
        badge.textContent = '0 despachadas';
        badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200';
      }
      return;
    }

    despachosGaritaCache = json.data;
    ultimosDespachosCache = json.data;
    if (badge) {
      badge.textContent = `${despachosGaritaCache.length} despachada${despachosGaritaCache.length === 1 ? '' : 's'}`;
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-xs';
    }

    actualizarComboFiltroDespachadosLider(despachosGaritaCache);
    filtrarDespachadosGaritaPorLider();
  } catch (error) {
    console.error('Error cargando despachos recientes:', error);
  }
}

function actualizarComboFiltroDespachadosLider(items) {
  const select = document.getElementById('filtroDespachadosLider');
  if (!select) return;

  const currentVal = select.value || 'TODOS';
  const conteoPorLider = {};
  items.forEach(it => {
    const l = (it.lider_nombre || 'Sin Líder').trim();
    conteoPorLider[l] = (conteoPorLider[l] || 0) + 1;
  });

  let options = `<option value="TODOS">Todos los Líderes (${items.length})</option>`;
  Object.keys(conteoPorLider).sort().forEach(l => {
    options += `<option value="${l}">${l} (${conteoPorLider[l]})</option>`;
  });
  select.innerHTML = options;

  if (conteoPorLider[currentVal] !== undefined || currentVal === 'TODOS') {
    select.value = currentVal;
  } else {
    select.value = 'TODOS';
  }
}

function filtrarDespachadosGaritaPorLider() {
  const select = document.getElementById('filtroDespachadosLider');
  const lider = select ? select.value : 'TODOS';
  const tbody = document.getElementById('tablaDespachosHoy');
  if (!tbody) return;

  let items = despachosGaritaCache;
  if (lider && lider !== 'TODOS') {
    items = items.filter(it => (it.lider_nombre || 'Sin Líder').trim() === lider);
  }

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400 font-bold">No hay salidas despachadas para el líder seleccionado en este turno.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const hora = item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const badgeClass = getBadgeClass(item.estado);

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-4 font-mono text-xs font-bold text-slate-900">${hora}</td>
        <td class="py-3 px-4">
          <div class="font-black text-slate-900">${item.nombres}</div>
          <div class="text-[11px] text-slate-400 font-medium">Turno: ${item.fecha_salida}</div>
        </td>
        <td class="py-3 px-4 font-mono text-xs text-slate-600">${item.cedula}</td>
        <td class="py-3 px-4 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
        <td class="py-3 px-4 font-bold text-xs text-slate-700">${item.modelo || 'DELL'}</td>
        <td class="py-3 px-4">
          <span class="inline-block px-2.5 py-1 bg-purple-100 text-purple-900 border border-purple-200 rounded-lg text-xs font-black shadow-xs">
            ${item.lider_nombre || 'N/A'}
          </span>
          <div class="text-[11px] font-semibold text-slate-500 mt-0.5">${item.area}</div>
        </td>
        <td class="py-3 px-4 text-xs font-semibold text-slate-600">${item.despachado_por || '--'}</td>
        <td class="py-3 px-4 text-center">
          <span class="px-2.5 py-1 rounded-full text-xs font-black uppercase ${badgeClass}">
            ${item.estado}
          </span>
        </td>
      </tr>
    `;
  }).join('');
  lucide.createIcons();
}

function renderizarBitacoraCompleta() {
  const tbody = document.getElementById('cuerpoBitacoraGarita');
  if (!tbody) return;

  if (ultimosDespachosCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-400">No hay registros de salidas en el turno actual.</td></tr>`;
    return;
  }

  tbody.innerHTML = ultimosDespachosCache.map((item, index) => {
    const hora = item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '--:--';

    return `
      <tr class="hover:bg-slate-50">
        <td class="p-3">${index + 1}</td>
        <td class="p-3 font-mono font-bold">${hora}</td>
        <td class="p-3 font-bold text-slate-900">${item.nombres}</td>
        <td class="p-3 font-mono">${item.cedula}</td>
        <td class="p-3 font-mono font-bold text-blue-700">${item.codigo_maquina}</td>
        <td class="p-3 font-bold">${item.modelo || 'DELL'}</td>
        <td class="p-3">${item.lider_nombre}</td>
        <td class="p-3 text-slate-600">${item.despachado_por || 'Garita'}</td>
      </tr>
    `;
  }).join('');
}

function filtrarBitacoraGarita() {
  const q = document.getElementById('filtroBitacoraGarita')?.value.toLowerCase() || '';
  const rows = document.querySelectorAll('#cuerpoBitacoraGarita tr');
  rows.forEach(r => {
    const text = r.textContent.toLowerCase();
    r.style.display = text.includes(q) ? '' : 'none';
  });
}

function imprimirBitacoraGarita() {
  const fecha = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const w = window.open('', '_blank');
  w.document.write(`
    <html>
    <head>
      <title>Reporte de Turno - Garita de Seguridad</title>
      <style>
        body { font-family: sans-serif; padding: 20px; font-size: 11px; }
        h2, h3 { text-align: center; margin: 2px 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid #333; padding: 6px; text-align: left; }
        th { background: #eee; }
        .footer { margin-top: 40px; display: flex; justify-content: space-around; }
      </style>
    </head>
    <body>
      <h2>BITÁCORA DE CONTROL DE SALIDAS — GARITA DE SEGURIDAD</h2>
      <h3>FECHA: ${fecha.toUpperCase()}</h3>
      <p>Guardia de turno: <strong>${currentUser ? currentUser.nombre : 'Seguridad'}</strong></p>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Hora</th><th>Asesor</th><th>Cédula</th><th>N° Serie</th><th>Modelo</th><th>Líder</th><th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${ultimosDespachosCache.map((item, i) => `
            <tr>
              <td>${i+1}</td>
              <td>${item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES') : ''}</td>
              <td><strong>${item.nombres}</strong></td>
              <td>${item.cedula}</td>
              <td><strong>${item.codigo_maquina}</strong></td>
              <td>${item.modelo || 'DELL'}</td>
              <td>${item.lider_nombre}</td>
              <td>${item.estado}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="footer">
        <div>_________________________________<br>Firma Guardia de Turno</div>
        <div>_________________________________<br>Supervisor de Seguridad</div>
      </div>
      <script>window.print();<\/script>
    </body>
    </html>
  `);
  w.document.close();
}

// =========================================================================
// SECCIÓN 2: SISTEMAS (APROBACIÓN & CONTROL CENTRAL)
// =========================================================================

function debounceCargarSistemas() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    cargarSolicitudesSistemas();
  }, 300);
}

async function cargarSolicitudesSistemas() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || '';
  const lider = document.getElementById('filtroSistemasLider')?.value || 'TODOS';
  const estado = document.getElementById('filtroSistemasEstado')?.value || 'TODOS';
  const search = document.getElementById('filtroSistemasSearch')?.value || '';

  try {
    let url = `/api/solicitudes?fecha=${fecha}&lider=${lider}&estado=${estado}&search=${encodeURIComponent(search)}`;
    const res = await fetchAuth(url);
    const json = await res.json();

    const tbody = document.getElementById('tablaSolicitudesSistemas');
    if (!tbody) return;

    if (!json.ok || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="p-8 text-center text-slate-400 font-medium">No se encontraron solicitudes con los filtros aplicados.</td></tr>`;
      return;
    }

    selectedSolicitudesSistemas.clear();
    const selectAllCheck = document.getElementById('checkSelectAll');
    if (selectAllCheck) selectAllCheck.checked = false;

    tbody.innerHTML = json.data.map(item => {
      const badgeClass = getBadgeClass(item.estado);
      const isPendiente = item.estado === 'PENDIENTE';

      return `
        <tr class="hover:bg-slate-50 transition" id="fila-solicitud-${item.id}">
          <td class="p-4">
            <input type="checkbox" value="${item.id}" ${isPendiente ? '' : 'disabled'} onchange="toggleSelectFila(this)" class="row-checkbox rounded text-blue-600">
          </td>
          <td class="p-4 font-black text-slate-900">${item.nombres}</td>
          <td class="p-4 font-mono text-xs">${item.cedula}</td>
          <td class="p-4 text-xs font-semibold text-slate-700">${item.lider_nombre} <span class="text-slate-400">(${item.area})</span></td>
          <td class="p-4 font-mono text-xs font-bold text-blue-700">
            ${item.codigo_maquina}
            ${item.codigo_maquina_anterior ? `<div class="text-[10px] text-amber-600 font-normal">Ant: ${item.codigo_maquina_anterior}</div>` : ''}
          </td>
          <td class="p-4 text-xs font-bold">${item.modelo || 'DELL'}</td>
          <td class="p-4 text-xs text-slate-600">${item.fecha_salida}</td>
          <td class="p-4 text-center">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-black uppercase ${badgeClass}">
              ${item.estado}
            </span>
          </td>
          <td class="p-4 text-right space-x-1 whitespace-nowrap">
            ${isPendiente ? `
              <button onclick="aprobarSolicitudDirecta(${item.id})" class="touch-btn px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm" title="Aprobar para Garita">
                ✓ Aprobar
              </button>
              <button onclick="abrirModalRechazar(${item.id})" class="touch-btn px-2.5 py-1 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg text-xs font-bold" title="Rechazar">
                ✕ Rechazar
              </button>
            ` : ''}

            ${(item.estado === 'APROBADO' || item.estado === 'PENDIENTE') ? `
              <button onclick="anularSolicitudSistemas(${item.id}, '${item.nombres}')" class="touch-btn px-2 py-1 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-lg text-xs font-bold" title="Quitar de la lista porque el asesor desistió y no salió">
                🚫 No Salió
              </button>
            ` : ''}
            
            <button onclick="abrirModalCambiarEquipo(${item.id}, '${item.nombres}', '${item.codigo_maquina}', '${item.modelo || 'DELL'}')" class="touch-btn px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold" title="Reemplazar máquina averiada por otra">
              🔄 Cambiar
            </button>
            <button onclick="abrirModalEditarSolicitudDirecta(${item.id})" class="touch-btn px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-lg text-xs font-bold" title="Editar todos los datos (cédula, serie, etc.)">
              ✏️ Editar
            </button>
          </td>
        </tr>
      `;
    }).join('');

    lucide.createIcons();
  } catch (error) {
    showToast('Error cargando solicitudes: ' + error.message, 'error');
  }
}

// Anular una solicitud individual que no llegó a salir
async function anularSolicitudSistemas(id, asesorNombre) {
  const motivo = prompt(`Confirmar que el asesor ${asesorNombre} NO RETIRÓ el equipo al final del día.\nIngrese motivo (o presione Aceptar):`, 'Asesor desistió de teletrabajo / No retiró equipo');
  if (motivo === null) return;

  try {
    const res = await fetchAuth(`/api/solicitudes/${id}/anular`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motivo: motivo.trim() || 'No retiró el equipo',
        operador: currentUser ? currentUser.nombre : 'Sistemas'
      })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'info');
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al quitar solicitud.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// Depuración masiva de todas las solicitudes aprobadas/pendientes que nunca salieron hoy
async function depurarNoSalidosHoy() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || getFechaLocalEcuador();

  const confirmacion = confirm(`¿Desea limpiar y marcar como "NO SALIÓ" todas las solicitudes de la fecha ${fecha} que quedaron aprobadas pero que los asesores NUNCA fueron a retirar a garita?\n\nEsto liberará automáticamente las computadoras y limpiará el listado.`);
  if (!confirmacion) return;

  try {
    const res = await fetchAuth('/api/solicitudes/depurar-no-salidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha,
        operador: currentUser ? currentUser.nombre : 'Sistemas'
      })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al depurar solicitudes.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function toggleSelectAll(master) {
  const checkboxes = document.querySelectorAll('.row-checkbox:not(:disabled)');
  checkboxes.forEach(cb => {
    cb.checked = master.checked;
    if (master.checked) {
      selectedSolicitudesSistemas.add(parseInt(cb.value));
    } else {
      selectedSolicitudesSistemas.delete(parseInt(cb.value));
    }
  });
}

function toggleSelectFila(cb) {
  const id = parseInt(cb.value);
  if (cb.checked) {
    selectedSolicitudesSistemas.add(id);
  } else {
    selectedSolicitudesSistemas.delete(id);
  }
}

async function aprobarSolicitudDirecta(id) {
  try {
    const res = await fetchAuth(`/api/solicitudes/${id}/aprobar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aprobado_por: currentUser ? currentUser.nombre : 'Sistemas' })
    });
    const json = await res.json();

    if (json.ok) {
      showToast('Solicitud aprobada con éxito', 'success');
      playSuccessSound();
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al aprobar.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function abrirModalRechazar(id) {
  document.getElementById('modalRechazarId').value = id;
  document.getElementById('modalRechazarMotivo').value = '';
  const modal = document.getElementById('modalRechazar');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function cerrarModalRechazar() {
  const modal = document.getElementById('modalRechazar');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function confirmarRechazoSistemas() {
  const id = document.getElementById('modalRechazarId').value;
  const motivo = document.getElementById('modalRechazarMotivo').value.trim();

  if (!motivo) {
    alert('Por favor especifique un motivo de rechazo.');
    return;
  }

  try {
    const res = await fetchAuth(`/api/solicitudes/${id}/rechazar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo_rechazo: motivo, aprobado_por: currentUser ? currentUser.nombre : 'Sistemas' })
    });
    const json = await res.json();

    if (json.ok) {
      cerrarModalRechazar();
      showToast('Solicitud rechazada.', 'info');
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al rechazar.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

async function aprobarLoteSistemas() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || '';
  const lider = document.getElementById('filtroSistemasLider')?.value || 'TODOS';
  const selectedIds = Array.from(selectedSolicitudesSistemas);

  let mensajeConfirm = '';
  let payload = { aprobado_por: currentUser ? currentUser.nombre : 'Sistemas' };

  if (selectedIds.length > 0) {
    mensajeConfirm = `¿Desea aprobar formalmente las ${selectedIds.length} solicitudes seleccionadas?`;
    payload.ids = selectedIds;
  } else {
    mensajeConfirm = `¿Desea aprobar formalmente TODAS las solicitudes pendientes para la fecha ${fecha} (${lider})?`;
    payload.fecha = fecha;
    payload.lider = lider;
  }

  if (!confirm(mensajeConfirm)) return;

  try {
    const res = await fetchAuth('/api/solicitudes/aprobar-lote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al procesar el lote.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function abrirModalCambiarEquipo(id, nombre, codigoActual, modeloActual) {
  document.getElementById('modalCambiarId').value = id;
  document.getElementById('modalCambiarNombre').textContent = nombre;
  document.getElementById('modalCambiarNuevoCodigo').value = '';
  document.getElementById('modalCambiarNuevoModelo').value = modeloActual || 'DELL';
  document.getElementById('modalCambiarMotivo').value = '';

  const modal = document.getElementById('modalCambiarEquipo');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => document.getElementById('modalCambiarNuevoCodigo').focus(), 100);
}

function cerrarModalCambiarEquipo() {
  const modal = document.getElementById('modalCambiarEquipo');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function confirmarCambioEquipoSistemas() {
  const id = document.getElementById('modalCambiarId').value;
  const nuevo_codigo = document.getElementById('modalCambiarNuevoCodigo').value.trim();
  const nuevo_modelo = document.getElementById('modalCambiarNuevoModelo').value.trim();
  const motivo = document.getElementById('modalCambiarMotivo').value.trim();

  if (!nuevo_codigo) {
    alert('Debe ingresar el nuevo código de máquina.');
    return;
  }

  try {
    const res = await fetchAuth(`/api/solicitudes/${id}/cambiar-equipo`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nuevo_codigo,
        nuevo_modelo,
        motivo,
        operador: currentUser ? currentUser.nombre : 'Sistemas'
      })
    });
    const json = await res.json();

    if (json.ok) {
      cerrarModalCambiarEquipo();
      playSuccessSound();
      showToast(json.message, 'success');
      cargarSolicitudesSistemas();
    } else {
      alert(json.error || 'Error al cambiar equipo.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function abrirHojaOficialImpresion() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || '';
  const lider = document.getElementById('filtroSistemasLider')?.value || 'TODOS';
  const url = `/api/hoja-control?fecha=${fecha}&lider=${encodeURIComponent(lider)}`;
  window.open(url, '_blank');
}

async function depurarNoSalidosHoy() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || getFechaLocalEcuador();
  if (!confirm(`¿Desea depurar todos los asesores aprobados para la fecha ${fecha} que NUNCA salieron por garita?\n\nPasarán a estado "NO RETIRÓ" para no congestionar garita ni reportes.`)) return;

  try {
    const res = await fetchAuth('/api/solicitudes/depurar-no-salidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fecha, operador: currentUser ? currentUser.nombre : 'Sistemas' })
    });
    const json = await res.json();
    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al depurar solicitudes.');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// GESTIÓN DEL DIRECTORIO OFICIAL DE LÍDERES
async function abrirModalDirectorioLideres() {
  const modal = document.getElementById('modalDirectorioLideres');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  await cargarListaDirectorioModal();
}

function cerrarModalDirectorioLideres() {
  const modal = document.getElementById('modalDirectorioLideres');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// GESTIÓN COMPLETA DEL DIRECTORIO DE PERSONAL Y EQUIPOS (SISTEMAS SUPER ADMIN)
let personalDirectorioModalCache = [];

async function cargarListaDirectorioModal() {
  const cont = document.getElementById('listaPersonalDirectorioModal');
  if (!cont) return;
  try {
    const res = await fetchAuth('/api/lideres-directorio?todos=1');
    const json = await res.json();
    if (json.ok && json.data) {
      personalDirectorioModalCache = json.data;
      filtrarListaPersonalModal();
    }
  } catch (e) {
    cont.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-rose-500 font-bold">Error al cargar directorio de personal.</td></tr>';
  }
}

function filtrarListaPersonalModal() {
  const cont = document.getElementById('listaPersonalDirectorioModal');
  if (!cont) return;

  const q = (document.getElementById('filtroModalPersonal')?.value || '').toLowerCase().trim();
  const depto = document.getElementById('filtroDeptoModalPersonal')?.value || 'TODOS';

  let items = personalDirectorioModalCache.filter(l => {
    const matchQ = !q ||
      (l.nombre && l.nombre.toLowerCase().includes(q)) ||
      (l.nombre_completo && l.nombre_completo.toLowerCase().includes(q)) ||
      (l.cedula && l.cedula.toLowerCase().includes(q)) ||
      (l.codigo_maquina && l.codigo_maquina.toLowerCase().includes(q)) ||
      (l.cargo && l.cargo.toLowerCase().includes(q));

    const matchDepto = (depto === 'TODOS' || (l.area_default || 'Cobranzas') === depto);

    return matchQ && matchDepto;
  });

  if (items.length === 0) {
    cont.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-400 font-bold">No se encontraron funcionarios o líderes con los filtros aplicados.</td></tr>';
    return;
  }

  cont.innerHTML = items.map((l) => {
    const esPaseLibre = (l.tiene_pase_libre !== 0);
    const esActivo = (l.activo !== 0);

    return `
      <tr class="hover:bg-slate-50 transition border-b border-slate-100">
        <td class="py-2.5 px-3">
          <div class="font-black text-slate-900">${l.nombre_completo || l.nombre}</div>
          <div class="text-[11px] text-purple-700 font-mono font-bold">Usuario: ${l.nombre}</div>
        </td>
        <td class="py-2.5 px-3 font-mono font-bold text-slate-700">
          ${l.cedula ? `<span class="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">${l.cedula}</span>` : '<span class="text-slate-400 italic">Sin cédula</span>'}
        </td>
        <td class="py-2.5 px-3">
          <div class="font-bold text-slate-800">${l.area_default || 'Cobranzas'}</div>
          <div class="text-[11px] text-slate-500 font-medium">${l.cargo || 'Funcionario'}</div>
        </td>
        <td class="py-2.5 px-3 font-mono font-black text-blue-700">
          ${l.codigo_maquina ? `<span class="bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">${l.codigo_maquina}</span>` : '<span class="text-rose-400 font-normal italic">Sin equipo</span>'}
        </td>
        <td class="py-2.5 px-3 text-slate-600 font-medium">
          ${l.modelo || 'Laptop'}
        </td>
        <td class="py-2.5 px-3 text-center">
          ${esPaseLibre 
            ? '<span class="px-2 py-0.5 bg-amber-100 text-amber-900 rounded-full font-black text-[10px] border border-amber-300">👑 Pase Libre</span>' 
            : '<span class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-full font-bold text-[10px]">📄 Ticket</span>'}
        </td>
        <td class="py-2.5 px-3 text-center">
          ${esActivo 
            ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full font-bold text-[10px]">Activo</span>' 
            : '<span class="px-2 py-0.5 bg-rose-100 text-rose-800 rounded-full font-bold text-[10px]">Inactivo</span>'}
        </td>
        <td class="py-2.5 px-3 text-center space-x-1 whitespace-nowrap">
          <button 
            type="button" 
            onclick="abrirModalFormularioPersonal(${l.id})" 
            class="touch-btn px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-lg font-bold text-xs transition"
            title="Editar información completa, cédula y laptop"
          >
            ✏️ Editar
          </button>
          <button 
            type="button" 
            onclick="eliminarPersonalDirectorio(${l.id}, '${l.nombre_completo || l.nombre}')" 
            class="touch-btn px-2 py-1 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg font-bold text-xs transition"
            title="Eliminar o desactivar funcionario"
          >
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

function abrirModalFormularioPersonal(id = null) {
  const modal = document.getElementById('modalFormularioPersonal');
  if (!modal) return;

  const inputId = document.getElementById('formPersonalId');
  const inputNomComp = document.getElementById('formPersonalNombreCompleto');
  const inputNom = document.getElementById('formPersonalNombre');
  const inputCed = document.getElementById('formPersonalCedula');
  const selectArea = document.getElementById('formPersonalArea');
  const inputCargo = document.getElementById('formPersonalCargo');
  const inputCod = document.getElementById('formPersonalCodigoMaquina');
  const inputMod = document.getElementById('formPersonalModelo');
  const selectPase = document.getElementById('formPersonalPaseLibre');
  const selectAct = document.getElementById('formPersonalActivo');
  const titulo = document.getElementById('tituloModalPersonal');
  const btnGuardar = document.getElementById('btnGuardarPersonal');

  if (id) {
    let l = (Array.isArray(personalDirectorioModalCache) && personalDirectorioModalCache.find(item => item.id === id))
         || (Array.isArray(lideresEquiposCache) && lideresEquiposCache.find(item => item.id === id));
    
    if (!l) {
      fetchAuth(`/api/lideres-directorio?todos=1`)
        .then(r => r.json())
        .then(res => {
          if (res.ok && res.data) {
            personalDirectorioModalCache = res.data;
            abrirModalFormularioPersonal(id);
          }
        })
        .catch(() => alert('No se encontraron datos para el líder seleccionado.'));
      return;
    }

    if (inputId) inputId.value = l.id;
    if (inputNomComp) inputNomComp.value = l.nombre_completo || l.nombre;
    if (inputNom) inputNom.value = l.nombre;
    if (inputCed) inputCed.value = l.cedula || '';
    if (selectArea) selectArea.value = l.area_default || 'Cobranzas';
    if (inputCargo) inputCargo.value = l.cargo || 'Líder de Operaciones';
    if (inputCod) inputCod.value = l.codigo_maquina || '';
    if (inputMod) inputMod.value = l.modelo || 'Laptop DELL';
    if (selectPase) selectPase.value = (l.tiene_pase_libre !== 0) ? '1' : '0';
    if (selectAct) selectAct.value = (l.activo !== 0) ? '1' : '0';

    if (titulo) titulo.innerHTML = `<span class="text-blue-600">✏️ Editar Líder:</span> <span class="text-slate-900 font-bold">${l.nombre_completo || l.nombre}</span>`;
    if (btnGuardar) btnGuardar.innerHTML = `<span>💾 GUARDAR CAMBIOS</span>`;
  } else {
    if (inputId) inputId.value = '';
    if (inputNomComp) inputNomComp.value = '';
    if (inputNom) inputNom.value = '';
    if (inputCed) inputCed.value = '';
    if (selectArea) selectArea.value = 'Cobranzas';
    if (inputCargo) inputCargo.value = 'Líder de Operaciones';
    if (inputCod) inputCod.value = '';
    if (inputMod) inputMod.value = 'Laptop DELL';
    if (selectPase) selectPase.value = '1';
    if (selectAct) selectAct.value = '1';

    if (titulo) titulo.innerHTML = `<span class="text-purple-600">➕ Agregar Nuevo Líder de Operaciones</span>`;
    if (btnGuardar) btnGuardar.innerHTML = `<span>➕ REGISTRAR LÍDER</span>`;
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function cerrarModalFormularioPersonal() {
  const modal = document.getElementById('modalFormularioPersonal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function guardarFormularioPersonal(e) {
  e.preventDefault();
  const id = document.getElementById('formPersonalId')?.value;
  const nombre_completo = document.getElementById('formPersonalNombreCompleto')?.value.trim();
  const nombre = document.getElementById('formPersonalNombre')?.value.trim();
  const cedula = document.getElementById('formPersonalCedula')?.value.trim();
  const area_default = document.getElementById('formPersonalArea')?.value;
  const cargo = document.getElementById('formPersonalCargo')?.value.trim();
  const codigo_maquina = document.getElementById('formPersonalCodigoMaquina')?.value.trim().toUpperCase();
  const modelo = document.getElementById('formPersonalModelo')?.value.trim().toUpperCase();
  const tiene_pase_libre = Number(document.getElementById('formPersonalPaseLibre')?.value || 1);
  const activo = Number(document.getElementById('formPersonalActivo')?.value || 1);

  if (!nombre) {
    alert('El usuario o alias es requerido.');
    return;
  }

  const payload = {
    nombre,
    nombre_completo: nombre_completo || nombre,
    cedula,
    area_default,
    cargo,
    codigo_maquina,
    modelo: modelo || 'Laptop DELL',
    tiene_pase_libre,
    activo
  };

  try {
    let res;
    if (id) {
      res = await fetchAuth(`/api/lideres-directorio/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetchAuth('/api/lideres-directorio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const json = await res.json();
    if (json.ok) {
      playSuccessSound();
      showToast(json.message || 'Personal guardado correctamente.', 'success');
      cerrarModalFormularioPersonal();
      await cargarListaDirectorioModal();
      if (typeof cargarLideresEquipos === 'function') {
        cargarLideresEquipos();
      }
      if (typeof cargarComboLideresLogin === 'function') cargarComboLideresLogin();
      if (typeof cargarLideresSelectores === 'function') cargarLideresSelectores();
    } else {
      playErrorSound();
      alert(json.error || 'Error al guardar personal.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

async function eliminarPersonalDirectorio(id, nombre) {
  const confirmacion = confirm(`¿Está seguro de que desea retirar o desactivar a "${nombre}" del directorio oficial?\n\nSi tiene movimientos históricos, se desactivará para conservar la auditoría.`);
  if (!confirmacion) return;

  try {
    const res = await fetchAuth(`/api/lideres-directorio/${id}`, {
      method: 'DELETE'
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'info');
      await cargarListaDirectorioModal();
      if (typeof cargarLideresEquipos === 'function') {
        cargarLideresEquipos();
      }
    } else {
      playErrorSound();
      alert(json.error || 'Error al eliminar funcionario.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// EDITAR SOLICITUD DIRECTAMENTE DESDE SISTEMAS
async function abrirModalEditarSolicitudDirecta(id) {
  try {
    const res = await fetchAuth(`/api/solicitudes?search=&estado=TODOS`);
    const json = await res.json();

    let sol = null;
    if (json.ok && Array.isArray(json.data)) {
      sol = json.data.find(s => s.id === id);
    }

    if (!sol) {
      alert('No se pudo encontrar los datos de la solicitud.');
      return;
    }

    document.getElementById('editSolId').value = sol.id;
    document.getElementById('editSolCedula').value = sol.cedula;
    document.getElementById('editSolNombres').value = sol.nombres;
    document.getElementById('editSolCodigoMaquina').value = sol.codigo_maquina;
    document.getElementById('editSolModelo').value = sol.modelo || 'DELL';
    document.getElementById('editSolArea').value = sol.area || 'Cobranzas';
    document.getElementById('editSolLider').value = sol.lider_nombre || '';
    document.getElementById('editSolFechaSalida').value = sol.fecha_salida;
    document.getElementById('editSolFechaRetorno').value = sol.fecha_retorno_estimada || sol.fecha_salida;
    document.getElementById('editSolEstado').value = sol.estado;
    document.getElementById('editSolObservaciones').value = sol.observaciones || '';

    const modal = document.getElementById('modalEditarSolicitud');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  } catch (e) {
    showToast('Error al abrir solicitud: ' + e.message, 'error');
  }
}

function cerrarModalEditarSolicitud() {
  const modal = document.getElementById('modalEditarSolicitud');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function guardarEdicionSolicitudSistemas(e) {
  e.preventDefault();
  const id = document.getElementById('editSolId')?.value;
  if (!id) return;

  const payload = {
    cedula: document.getElementById('editSolCedula')?.value.trim(),
    nombres: document.getElementById('editSolNombres')?.value.trim().toUpperCase(),
    codigo_maquina: document.getElementById('editSolCodigoMaquina')?.value.trim().toUpperCase(),
    modelo: document.getElementById('editSolModelo')?.value.trim().toUpperCase(),
    area: document.getElementById('editSolArea')?.value,
    lider_nombre: document.getElementById('editSolLider')?.value.trim(),
    fecha_salida: document.getElementById('editSolFechaSalida')?.value,
    fecha_retorno_estimada: document.getElementById('editSolFechaRetorno')?.value,
    estado: document.getElementById('editSolEstado')?.value,
    observaciones: document.getElementById('editSolObservaciones')?.value.trim()
  };

  try {
    const res = await fetchAuth(`/api/solicitudes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (json.ok) {
      playSuccessSound();
      showToast(json.message || 'Solicitud actualizada con éxito.', 'success');
      cerrarModalEditarSolicitud();
      cargarSolicitudesSistemas();
      actualizarMetricasGenerales();
    } else {
      playErrorSound();
      alert(json.error || 'Error al actualizar solicitud.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// Funciones de compatibilidad hacia atrás
async function editarLaptopLiderPrompt(id, nombre, serieActual = '') {
  abrirModalFormularioPersonal(id);
}

async function agregarLiderDirectorio(e) {
  if (e) e.preventDefault();
  abrirModalFormularioPersonal(null);
}

function exportarExcelSistemas() {
  const fecha = document.getElementById('filtroSistemasFecha')?.value || '';
  const lider = document.getElementById('filtroSistemasLider')?.value || 'TODOS';
  const estado = document.getElementById('filtroSistemasEstado')?.value || 'TODOS';
  const url = `/api/exportar/excel?fecha=${fecha}&lider=${encodeURIComponent(lider)}&estado=${estado}`;
  window.location.href = url;
}

// =========================================================================
// SECCIÓN 3: REPORTE POR LÍDERES
// =========================================================================

async function cargarReporteLideres() {
  const lider = document.getElementById('reporteFiltroLider')?.value || 'TODOS';
  const desde = document.getElementById('reporteFechaDesde')?.value || '';
  const hasta = document.getElementById('reporteFechaHasta')?.value || '';
  const estado = document.getElementById('reporteFiltroEstado')?.value || 'SOLO_AFUERA';

  try {
    let url = `/api/reportes/lideres?lider=${encodeURIComponent(lider)}&estado=${encodeURIComponent(estado)}`;
    if (desde) url += `&fecha_desde=${encodeURIComponent(desde)}`;
    if (hasta) url += `&fecha_hasta=${encodeURIComponent(hasta)}`;

    const res = await fetchAuth(url);
    const json = await res.json();

    const container = document.getElementById('contenedorReporteLideres');
    if (!container) return;

    if (!json.ok || json.data.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center text-slate-400 font-medium bg-slate-50 border border-slate-200 rounded-2xl">
          <i data-lucide="shield-check" class="w-8 h-8 text-emerald-500 mx-auto mb-2"></i>
          <p class="font-bold text-slate-700">No hay registros con los filtros seleccionados.</p>
          <p class="text-xs text-slate-400 mt-1">Si el filtro es "Solo Pendientes de Devolución", significa que todos los equipos prestados han sido devueltos a la oficina.</p>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    container.innerHTML = json.data.map(grupo => {
      const tieneAfuera = grupo.pendientes_retorno > 0;
      const borderCard = tieneAfuera ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-200';

      return `
        <div class="bg-white rounded-2xl border ${borderCard} shadow-sm overflow-hidden">
          <div class="bg-slate-50 p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-xl ${tieneAfuera ? 'bg-amber-600' : 'bg-slate-700'} text-white flex items-center justify-center font-black text-xl shadow">
                ${grupo.lider.charAt(0)}
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <h3 class="text-lg font-black text-slate-900">${grupo.lider}</h3>
                  ${tieneAfuera ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-amber-500 text-white animate-pulse">Tiene Equipos Afuera</span>' : '<span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-emerald-100 text-emerald-800">Al Día</span>'}
                </div>
                <div class="text-xs text-slate-500 font-semibold">Área / Campaña: <strong>${grupo.area || 'Operaciones'}</strong></div>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <div class="text-center px-3 py-1.5 bg-white rounded-xl border border-slate-200">
                <div class="text-lg font-black text-slate-800">${grupo.total}</div>
                <div class="text-[10px] text-slate-500 uppercase font-bold">Total Laptops</div>
              </div>
              <div class="text-center px-3 py-1.5 ${tieneAfuera ? 'bg-amber-100 border-2 border-amber-400 text-amber-950' : 'bg-blue-50 border border-blue-200'} rounded-xl shadow-sm">
                <div class="text-xl font-black ${tieneAfuera ? 'text-amber-800' : 'text-blue-600'}">${grupo.pendientes_retorno}</div>
                <div class="text-[10px] font-black uppercase tracking-wider ${tieneAfuera ? 'text-amber-900' : 'text-blue-700'}">🚨 Falta Devolver</div>
              </div>
              <div class="text-center px-3 py-1.5 bg-emerald-50 rounded-xl border border-emerald-200">
                <div class="text-lg font-black text-emerald-600">${grupo.retornados}</div>
                <div class="text-[10px] text-emerald-700 uppercase font-bold">Devueltas</div>
              </div>
              
              <a href="/api/hoja-control?lider=${encodeURIComponent(grupo.lider)}&fecha=${desde || getFechaLocalEcuador()}" target="_blank" class="touch-btn px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm">
                <i data-lucide="printer" class="w-3.5 h-3.5"></i>
                <span>Imprimir Hoja</span>
              </a>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs font-medium">
              <thead class="bg-slate-100 text-slate-600 uppercase font-bold">
                <tr>
                  <th class="p-3">#</th>
                  <th class="p-3">Asesor</th>
                  <th class="p-3">Cédula</th>
                  <th class="p-3">N° Serie</th>
                  <th class="p-3">Modelo</th>
                  <th class="p-3">Fecha de Salida</th>
                  <th class="p-3">Hora Despacho Garita</th>
                  <th class="p-3">Fecha y Hora Retorno</th>
                  <th class="p-3 text-center">Estado</th>
                  <th class="p-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${grupo.items.map((item, idx) => {
                  const badge = getBadgeClass(item.estado);
                  const isFuera = item.estado === 'SALIO';
                  const rowClass = isFuera ? 'bg-amber-50/40 font-semibold' : 'hover:bg-slate-50';

                  return `
                    <tr class="${rowClass}">
                      <td class="p-3 font-bold">${idx + 1}</td>
                      <td class="p-3 font-bold text-slate-900">${item.nombres}</td>
                      <td class="p-3 font-mono">${item.cedula}</td>
                      <td class="p-3 font-mono font-bold text-blue-700">${item.codigo_maquina}</td>
                      <td class="p-3 font-bold">${item.modelo || 'DELL'}</td>
                      <td class="p-3 text-slate-700 font-bold">${item.fecha_salida}</td>
                      <td class="p-3 text-slate-600">${item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '--'}</td>
                      <td class="p-3 text-slate-600">${item.retornado_en ? new Date(item.retornado_en).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '<span class="text-amber-700 font-bold">Pendiente (En posesión)</span>'}</td>
                      <td class="p-3 text-center">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${badge}">
                          ${isFuera ? '🚨 EN TELETRABAJO' : item.estado}
                        </span>
                      </td>
                      <td class="p-3 text-right">
                        ${isFuera ? `
                          <button onclick="confirmarRetornoEquipo(${item.id}, '${(item.nombres || '').replace(/'/g, "\\'")}')" class="touch-btn px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold shadow flex items-center gap-1 ml-auto">
                            <i data-lucide="corner-down-left" class="w-3 h-3"></i>
                            <span>Registrar Devolución</span>
                          </button>
                        ` : '<span class="text-slate-400 text-[11px]">✓ Devuelta</span>'}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }).join('');

    lucide.createIcons();
  } catch (error) {
    showToast('Error cargando reporte por líder: ' + error.message, 'error');
  }
}

function limpiarFiltrosReporteLideres() {
  const fEstado = document.getElementById('reporteFiltroEstado');
  const fLider = document.getElementById('reporteFiltroLider');
  const fDesde = document.getElementById('reporteFechaDesde');
  const fHasta = document.getElementById('reporteFechaHasta');

  if (fEstado) fEstado.value = 'SOLO_AFUERA';
  if (fLider) fLider.value = 'TODOS';
  if (fDesde) fDesde.value = '';
  if (fHasta) fHasta.value = '';

  cargarReporteLideres();
}

function filtrarSoloAfueraEnSistemas() {
  cambiarModulo('reporte-lideres');
  limpiarFiltrosReporteLideres();
}

// =========================================================================
// SECCIÓN 4: PORTAL LÍDERES
// =========================================================================

function cambiarTabLider(tab) {
  const tabHab = document.getElementById('tab-lider-hab');
  const tabInd = document.getElementById('tab-lider-ind');
  const tabMas = document.getElementById('tab-lider-mas');
  const vistaHab = document.getElementById('vista-lider-habitual');
  const vistaInd = document.getElementById('vista-lider-individual');
  const vistaMas = document.getElementById('vista-lider-masivo');

  [tabHab, tabInd, tabMas].forEach(t => {
    if (t) {
      t.className = 'px-4 py-2.5 rounded-xl text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition';
    }
  });

  [vistaHab, vistaInd, vistaMas].forEach(v => {
    if (v) v.classList.add('hidden');
  });

  if (tab === 'habitual') {
    if (tabHab) tabHab.className = 'px-4 py-2.5 rounded-xl bg-white text-purple-700 shadow-sm flex items-center gap-1.5 transition';
    if (vistaHab) vistaHab.classList.remove('hidden');
    cargarMiEquipoHabitual();
  } else if (tab === 'individual') {
    if (tabInd) tabInd.className = 'px-4 py-2.5 rounded-xl bg-white text-purple-700 shadow-sm flex items-center gap-1.5 transition';
    if (vistaInd) vistaInd.classList.remove('hidden');
  } else if (tab === 'masivo') {
    if (tabMas) tabMas.className = 'px-4 py-2.5 rounded-xl bg-white text-purple-700 shadow-sm flex items-center gap-1.5 transition';
    if (vistaMas) vistaMas.classList.remove('hidden');
  }
  lucide.createIcons();
}

let miEquipoHabitualCache = [];

async function cargarMiEquipoHabitual() {
  const tbody = document.getElementById('cuerpoTablaMiEquipo');
  if (!tbody) return;

  const liderNombre = currentUser ? currentUser.nombre : '';
  if (!liderNombre) return;

  try {
    const res = await fetchAuth(`/api/lider/mi-equipo?lider_nombre=${encodeURIComponent(liderNombre)}`);
    const json = await res.json();

    if (!json.ok || !json.data || json.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="p-8 text-center text-slate-400 font-medium">
            <div class="flex flex-col items-center justify-center space-y-2">
              <i data-lucide="users" class="w-8 h-8 text-slate-300"></i>
              <p>Aún no tienes asesores registrados en tu nómina habitual.</p>
              <button onclick="abrirModalAsesorHabitual()" class="touch-btn px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold mt-2 flex items-center gap-1.5 shadow">
                <i data-lucide="user-plus" class="w-4 h-4"></i> Agregar Primer Asesor
              </button>
            </div>
          </td>
        </tr>
      `;
      lucide.createIcons();
      return;
    }

    miEquipoHabitualCache = json.data;

    // Verificar el estado de solicitudes de hoy para estos asesores
    const today = getFechaLocalEcuador();
    const resSol = await fetchAuth(`/api/solicitudes?fecha=${today}&lider=${encodeURIComponent(liderNombre)}`);
    const jsonSol = await resSol.json();
    const solicitudesHoy = jsonSol.ok ? jsonSol.data : [];

    tbody.innerHTML = json.data.map(asesor => {
      // Buscar primero si tiene una solicitud activa (bloqueante) hoy
      const solActiva = solicitudesHoy.find(s => 
        (s.cedula === asesor.cedula || s.codigo_maquina === asesor.codigo_maquina) &&
        ['PENDIENTE', 'APROBADO', 'SALIO'].includes(s.estado)
      );
      const sol = solActiva || solicitudesHoy.find(s => s.cedula === asesor.cedula || s.codigo_maquina === asesor.codigo_maquina);
      let estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">No enviado hoy</span>';
      let isDisabled = '';

      if (sol) {
        if (sol.estado === 'PENDIENTE') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-300">En revisión TI</span>';
          isDisabled = 'disabled';
        } else if (sol.estado === 'APROBADO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300">Aprobado Garita</span>';
          isDisabled = 'disabled';
        } else if (sol.estado === 'SALIO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-300">En Teletrabajo</span>';
          isDisabled = 'disabled';
        } else if (sol.estado === 'RETORNADO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-cyan-100 text-cyan-800 border border-cyan-300">Retornado (Disponible)</span>';
          isDisabled = '';
        } else if (sol.estado === 'RECHAZADO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-300">Rechazado</span>';
          isDisabled = '';
        } else if (sol.estado === 'NO_SALIO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">No salió (Disponible)</span>';
          isDisabled = '';
        }
      }

      return `
        <tr class="hover:bg-purple-50/40 transition">
          <td class="p-3">
            <input 
              type="checkbox" 
              class="check-asesor-habitual rounded text-purple-600 w-4 h-4 cursor-pointer" 
              value="${asesor.id}" 
              ${isDisabled}
              data-cedula="${asesor.cedula}"
              data-nombres="${asesor.nombres}"
              data-codigo="${asesor.codigo_maquina}"
              data-modelo="${asesor.modelo || 'DELL'}"
              data-area="${asesor.area || (currentUser ? currentUser.area : '')}"
            >
          </td>
          <td class="p-3 font-bold text-slate-900">${asesor.nombres}</td>
          <td class="p-3 font-mono text-xs">${asesor.cedula}</td>
          <td class="p-3 font-mono text-xs font-bold text-blue-700">${asesor.codigo_maquina}</td>
          <td class="p-3 font-bold text-xs">${asesor.modelo || 'DELL'}</td>
          <td class="p-3 text-xs text-slate-600">${asesor.area || (currentUser ? currentUser.area : '--')}</td>
          <td class="p-3 text-center">${estadoBadge}</td>
          <td class="p-3 text-right">
            <div class="flex items-center justify-end gap-1">
              <button onclick="abrirModalAsesorHabitual(${asesor.id})" class="p-1.5 text-slate-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition" title="Editar asesor o cambiar serie">
                <i data-lucide="edit-3" class="w-4 h-4 inline"></i>
              </button>
              <button onclick="eliminarDeHabitual(${asesor.id}, '${asesor.nombres}')" class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition" title="Eliminar de mi lista habitual">
                <i data-lucide="trash-2" class="w-4 h-4 inline"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    lucide.createIcons();
  } catch (e) {
    console.error('Error cargando equipo habitual:', e);
    tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-rose-500">Error cargando el equipo habitual: ${e.message}</td></tr>`;
  }
}

function toggleSelectAllHabituales(masterCheckbox) {
  const checkboxes = document.querySelectorAll('.check-asesor-habitual:not([disabled])');
  checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
}

async function autorizarSeleccionadosHabituales() {
  const checkboxes = document.querySelectorAll('.check-asesor-habitual:checked');
  if (checkboxes.length === 0) {
    alert('Por favor marque las casillas de los asesores que van a teletrabajo hoy.');
    return;
  }

  const liderNombre = currentUser ? currentUser.nombre : '';
  const areaLider = currentUser ? (currentUser.area || 'Operaciones') : 'Operaciones';
  const fechaSalida = getFechaLocalEcuador();

  const asesores = Array.from(checkboxes).map(cb => ({
    cedula: cb.getAttribute('data-cedula'),
    nombres: cb.getAttribute('data-nombres'),
    codigo_maquina: cb.getAttribute('data-codigo'),
    modelo: cb.getAttribute('data-modelo'),
    area: cb.getAttribute('data-area') || areaLider
  }));

  if (!confirm(`¿Desea autorizar y enviar a Sistemas a ${asesores.length} asesor(es) de su equipo habitual para teletrabajo hoy?`)) return;

  const btn = document.getElementById('btnAutorizarHabituales');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Procesando...';
  }

  try {
    const res = await fetchAuth('/api/lider/autorizar-lote-habitual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lider_nombre: liderNombre,
        area: areaLider,
        fecha_salida: fechaSalida,
        asesores
      })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      cargarMiEquipoHabitual();
      cargarSolicitudesLiderHoy();
      actualizarMetricasGenerales();
    } else {
      playErrorSound();
      alert(json.error || 'Error al autorizar lote habitual.');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i><span>Autorizar Seleccionados para Hoy</span>';
      lucide.createIcons();
    }
  }
}

// MODAL AGREGAR / EDITAR ASESOR A HABITUAL
function abrirModalAsesorHabitual(asesorId = null) {
  const m = document.getElementById('modalAsesorHabitual');
  if (!m) return;

  const idInp = document.getElementById('modalHabId');
  const titulo = document.getElementById('modalHabTitulo');
  const btn = document.getElementById('btnGuardarHabitual');

  if (asesorId && Array.isArray(miEquipoHabitualCache)) {
    const asesor = miEquipoHabitualCache.find(a => a.id == asesorId);
    if (asesor) {
      if (idInp) idInp.value = asesor.id;
      document.getElementById('modalHabCedula').value = asesor.cedula || '';
      document.getElementById('modalHabNombres').value = asesor.nombres || '';
      document.getElementById('modalHabSerie').value = asesor.codigo_maquina || '';
      document.getElementById('modalHabModelo').value = asesor.modelo || 'DELL';
      const areaInput = document.getElementById('modalHabArea');
      if (areaInput) areaInput.value = asesor.area || (currentUser ? currentUser.area : 'Campañas');
      if (titulo) titulo.textContent = 'Editar Asesor / Serie en Mi Equipo';
      if (btn) btn.textContent = 'Guardar Cambios';
      m.classList.remove('hidden');
      m.classList.add('flex');
      lucide.createIcons();
      setTimeout(() => document.getElementById('modalHabSerie').focus(), 100);
      return;
    }
  }

  // Modo nuevo asesor
  if (idInp) idInp.value = '';
  document.getElementById('modalHabCedula').value = '';
  document.getElementById('modalHabNombres').value = '';
  document.getElementById('modalHabSerie').value = '';
  document.getElementById('modalHabModelo').value = 'DELL';
  const areaInput = document.getElementById('modalHabArea');
  if (areaInput) areaInput.value = currentUser ? (currentUser.area || 'Campañas') : 'Campañas';
  if (titulo) titulo.textContent = 'Agregar Asesor a Mi Equipo Habitual';
  if (btn) btn.textContent = 'Guardar en Mi Equipo';
  m.classList.remove('hidden');
  m.classList.add('flex');
  lucide.createIcons();
  setTimeout(() => document.getElementById('modalHabCedula').focus(), 100);
}

function cerrarModalAsesorHabitual() {
  const m = document.getElementById('modalAsesorHabitual');
  if (m) {
    m.classList.add('hidden');
    m.classList.remove('flex');
  }
}

async function guardarAsesorEnHabitual(e) {
  e.preventDefault();
  const id = document.getElementById('modalHabId') ? document.getElementById('modalHabId').value.trim() : '';
  const cedula = document.getElementById('modalHabCedula').value.trim();
  const nombres = document.getElementById('modalHabNombres').value.trim();
  const codigo_maquina = document.getElementById('modalHabSerie').value.trim().toUpperCase();
  const modelo = document.getElementById('modalHabModelo').value.trim().toUpperCase();
  const lider_nombre = currentUser ? currentUser.nombre : '';
  const area = (document.getElementById('modalHabArea') && document.getElementById('modalHabArea').value.trim()) || (currentUser ? currentUser.area : 'Campañas');

  if (!cedula || !nombres || !codigo_maquina) {
    alert('Por favor complete todos los campos obligatorios.');
    return;
  }

  try {
    const res = await fetchAuth('/api/lider/mi-equipo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || undefined, lider_nombre, area, cedula, nombres, codigo_maquina, modelo })
    });
    const json = await res.json();

    if (json.ok) {
      cerrarModalAsesorHabitual();
      playSuccessSound();
      showToast(json.message || 'Asesor guardado en su catálogo habitual.', 'success');
      cargarMiEquipoHabitual();
    } else {
      alert(json.error || 'Error al guardar asesor.');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function eliminarDeHabitual(id, nombre) {
  if (!confirm(`¿Desea remover al asesor ${nombre} de su lista habitual?`)) return;

  try {
    const res = await fetchAuth(`/api/lider/mi-equipo/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) {
      showToast('Asesor removido de su equipo habitual.', 'info');
      cargarMiEquipoHabitual();
    } else {
      alert(json.error || 'Error al remover asesor.');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function guardarSolicitudIndividual(e) {
  e.preventDefault();

  const payload = {
    lider_nombre: document.getElementById('liderInputNombre').value.trim(),
    area: document.getElementById('liderSelectArea').value,
    fecha_salida: document.getElementById('liderInputFechaSalida').value,
    cedula: document.getElementById('liderInputCedula').value.trim(),
    nombres: document.getElementById('liderInputAsesorNombres').value.trim(),
    codigo_maquina: document.getElementById('liderInputCodigo').value.trim(),
    modelo: document.getElementById('liderInputModelo').value.trim(),
    fecha_retorno_estimada: document.getElementById('liderInputFechaRetorno').value,
    observaciones: document.getElementById('liderInputObs').value.trim()
  };

  try {
    const res = await fetchAuth('/api/solicitudes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (json.ok) {
      showToast('¡Solicitud enviada a Sistemas para aprobación!', 'success');
      document.getElementById('liderInputCedula').value = '';
      document.getElementById('liderInputAsesorNombres').value = '';
      document.getElementById('liderInputCodigo').value = '';
      document.getElementById('liderInputObs').value = '';
      document.getElementById('liderInputCedula').focus();

      cargarSolicitudesLiderHoy();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al registrar.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function archivoExcelSeleccionado(input) {
  const file = input.files[0];
  const label = document.getElementById('nombreArchivoSubido');
  const btn = document.getElementById('btnProcesarExcel');

  if (file) {
    label.textContent = `Archivo cargado: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    label.classList.remove('hidden');
    btn.disabled = false;
    btn.classList.remove('bg-slate-400', 'cursor-not-allowed');
    btn.classList.add('bg-blue-600', 'hover:bg-blue-700');
  }
}

async function procesarCargaMasivaExcel() {
  const input = document.getElementById('inputArchivoExcel');
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('archivo', file);
  formData.append('lider_nombre', currentUser ? currentUser.nombre : 'Líder');

  try {
    const res = await fetchAuth('/api/solicitudes/bulk-excel', {
      method: 'POST',
      body: formData
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      input.value = '';
      document.getElementById('nombreArchivoSubido').classList.add('hidden');
      const btn = document.getElementById('btnProcesarExcel');
      btn.disabled = true;
      btn.classList.add('bg-slate-400', 'cursor-not-allowed');
      btn.classList.remove('bg-blue-600');

      if (json.errores && json.errores.length > 0) {
        alert('Observaciones de carga:\n' + json.errores.join('\n'));
      }

      await cargarMiEquipoHabitual();
      await cargarSolicitudesLiderHoy();
      actualizarMetricasGenerales();
      cambiarTabLider('habitual');
    } else {
      alert(json.error || 'Error en carga masiva.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function descargarPlantillaLider(e) {
  if (e) e.preventDefault();
  const lider = currentUser ? currentUser.nombre : 'Lider';
  const area = currentUser ? (currentUser.area || '') : '';
  const url = `/api/plantilla-excel?lider=${encodeURIComponent(lider)}&area=${encodeURIComponent(area)}`;
  window.location.href = url;
}

async function cargarSolicitudesLiderHoy() {
  try {
    const today = getFechaLocalEcuador();
    let url = `/api/solicitudes?fecha=${today}`;
    if (currentUser && currentUser.rol === 'lider') {
      url += `&lider=${encodeURIComponent(currentUser.nombre)}`;
    }

    const res = await fetchAuth(url);
    const json = await res.json();

    const tbody = document.getElementById('tablaLiderHoy');
    if (!tbody) return;

    if (!json.ok || !json.data || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400 font-medium">No hay solicitudes registradas para el turno de hoy.</td></tr>`;
      return;
    }

    tbody.innerHTML = json.data.map(item => {
      let estadoBadge = '';
      let detalle = '--';

      if (item.estado === 'PENDIENTE') {
        estadoBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-amber-100 text-amber-800 border border-amber-300">EN REVISIÓN TI</span>';
        detalle = 'Esperando revisión y aprobación de Sistemas TI';
      } else if (item.estado === 'APROBADO') {
        estadoBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 border border-emerald-300">APROBADO GARITA</span>';
        detalle = `Aprobado por ${item.aprobado_por || 'Sistemas TI'}. Listo para retiro en garita`;
      } else if (item.estado === 'SALIO') {
        const horaSalida = item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
        estadoBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-blue-100 text-blue-800 border border-blue-300">EN TELETRABAJO</span>';
        detalle = `Retiró de garita a las ${horaSalida || 'hoy'} (Guardia: ${item.despachado_por || 'Garita'})`;
      } else if (item.estado === 'RETORNADO') {
        const horaRet = item.retornado_en ? new Date(item.retornado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
        estadoBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-cyan-100 text-cyan-800 border border-cyan-300">RETORNADO</span>';
        detalle = `Devolvió laptop a garita a las ${horaRet || 'hoy'} (Custodia: ${item.retornado_por || 'Garita'})`;
      } else if (item.estado === 'RECHAZADO') {
        estadoBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-rose-100 text-rose-800 border border-rose-300">RECHAZADO</span>';
        detalle = item.motivo_rechazo || 'Rechazado por Sistemas TI';
      } else {
        estadoBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-black uppercase ${getBadgeClass(item.estado)}">${item.estado}</span>`;
        detalle = item.observaciones || '--';
      }

      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-3 font-bold text-slate-800">${item.nombres}</td>
          <td class="p-3 font-mono text-xs">${item.cedula}</td>
          <td class="p-3 text-xs">${item.area}</td>
          <td class="p-3 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
          <td class="p-3 font-bold text-xs">${item.modelo || 'DELL'}</td>
          <td class="p-3 text-center">
            ${estadoBadge}
          </td>
          <td class="p-3 text-xs font-semibold text-slate-600">${detalle}</td>
        </tr>
      `;
    }).join('');
    lucide.createIcons();
  } catch (error) {
    console.error('Error cargando solicitudes líder:', error);
  }
}

// =========================================================================
// SECCIÓN 5: RETORNO DE EQUIPOS (GARITA Y SISTEMAS)
// =========================================================================

async function cargarEquiposFuera() {
  try {
    const res = await fetchAuth('/api/solicitudes?estado=SALIO');
    const json = await res.json();

    equiposFueraCache = (json.ok && Array.isArray(json.data)) ? json.data : [];

    const badge = document.getElementById('badgeConteoPendientesRetorno');
    if (badge) {
      badge.textContent = `${equiposFueraCache.length} en teletrabajo`;
    }

    actualizarComboFiltroLideresRetornos(equiposFueraCache);
    filtrarEquiposFueraPorLider();
  } catch (error) {
    showToast('Error al cargar equipos fuera: ' + error.message, 'error');
  }
}

function actualizarComboFiltroLideresRetornos(items) {
  const select = document.getElementById('filtroRetornosLider');
  if (!select) return;

  const currentVal = select.value || 'TODOS';
  const conteoPorLider = {};
  items.forEach(it => {
    const l = (it.lider_nombre || 'Sin Líder').trim();
    conteoPorLider[l] = (conteoPorLider[l] || 0) + 1;
  });

  let options = `<option value="TODOS">Todos los Líderes (${items.length})</option>`;
  Object.keys(conteoPorLider).sort().forEach(l => {
    options += `<option value="${l}">${l} (${conteoPorLider[l]})</option>`;
  });
  select.innerHTML = options;

  if (conteoPorLider[currentVal] !== undefined || currentVal === 'TODOS') {
    select.value = currentVal;
  } else {
    select.value = 'TODOS';
  }
}

function filtrarEquiposFueraPorLider() {
  const select = document.getElementById('filtroRetornosLider');
  const lider = select ? select.value : 'TODOS';
  const inputSearch = document.getElementById('inputBuscarRetornosPendientes');
  const term = inputSearch ? inputSearch.value.trim().toLowerCase() : '';

  const tbody = document.getElementById('tablaEquiposFuera');
  if (!tbody) return;

  let items = equiposFueraCache;
  if (lider && lider !== 'TODOS') {
    items = items.filter(it => (it.lider_nombre || 'Sin Líder').trim() === lider);
  }
  if (term) {
    items = items.filter(it => 
      (it.nombres && it.nombres.toLowerCase().includes(term)) ||
      (it.cedula && it.cedula.includes(term)) ||
      (it.codigo_maquina && it.codigo_maquina.toLowerCase().includes(term))
    );
  }

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="p-8 text-center text-slate-400 font-medium">
          <i data-lucide="check-circle-2" class="w-8 h-8 mx-auto text-emerald-500 mb-2 opacity-60"></i>
          No hay laptops pendientes de retorno con los filtros actuales.
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  tbody.innerHTML = items.map(item => {
    const horaSalida = item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : item.fecha_salida;
    const safeName = (item.nombres || '').replace(/'/g, "\\'");

    return `
      <tr class="hover:bg-amber-50/50 transition border-b border-slate-100">
        <td class="p-3">
          <div class="font-black text-slate-900">${item.nombres}</div>
          <div class="text-[10px] text-amber-800 font-bold uppercase tracking-wider">🚨 En Teletrabajo</div>
        </td>
        <td class="p-3 font-mono text-xs text-slate-700">${item.cedula}</td>
        <td class="p-3">
          <span class="px-2.5 py-1 bg-purple-50 text-purple-900 rounded-lg text-xs font-bold border border-purple-200">
            ${item.lider_nombre}
          </span>
        </td>
        <td class="p-3 font-mono text-xs font-black text-blue-700 bg-blue-50/60 rounded-lg">${item.codigo_maquina}</td>
        <td class="p-3 font-bold text-xs text-slate-700">${item.modelo || 'DELL'}</td>
        <td class="p-3 text-xs text-slate-600 font-medium">${horaSalida}</td>
        <td class="p-3 text-xs text-slate-600">${item.despachado_por || '--'}</td>
        <td class="p-3 text-center">
          <button onclick="confirmarRetornoEquipo(${item.id}, '${safeName}')" class="touch-btn px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow flex items-center gap-1.5 mx-auto transition">
            <i data-lucide="corner-down-left" class="w-3.5 h-3.5"></i>
            <span>Reingresar</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

async function cargarRetornosHoy() {
  try {
    const today = getFechaLocalEcuador();
    const res = await fetchAuth(`/api/garita/retornos-turno?fecha=${today}`);
    const json = await res.json();

    retornosHoyCache = (json.ok && Array.isArray(json.data)) ? json.data : [];

    const badge = document.getElementById('badgeConteoRetornadosHoy');
    if (badge) {
      badge.textContent = `${retornosHoyCache.length} reingresadas`;
    }

    actualizarComboFiltroRetornadosHoy(retornosHoyCache);
    filtrarRetornadosHoyPorLider();
  } catch (error) {
    console.error('Error cargando retornos del turno:', error);
  }
}

function actualizarComboFiltroRetornadosHoy(items) {
  const select = document.getElementById('filtroRetornadosHoyLider');
  if (!select) return;

  const currentVal = select.value || 'TODOS';
  const conteoPorLider = {};
  items.forEach(it => {
    const l = (it.lider_nombre || 'Sin Líder').trim();
    conteoPorLider[l] = (conteoPorLider[l] || 0) + 1;
  });

  let options = `<option value="TODOS">Todos los Líderes (${items.length})</option>`;
  Object.keys(conteoPorLider).sort().forEach(l => {
    options += `<option value="${l}">${l} (${conteoPorLider[l]})</option>`;
  });
  select.innerHTML = options;

  if (conteoPorLider[currentVal] !== undefined || currentVal === 'TODOS') {
    select.value = currentVal;
  } else {
    select.value = 'TODOS';
  }
}

function filtrarRetornadosHoyPorLider() {
  const select = document.getElementById('filtroRetornadosHoyLider');
  const lider = select ? select.value : 'TODOS';
  const tbody = document.getElementById('tablaRetornosHoy');
  if (!tbody) return;

  let items = retornosHoyCache;
  if (lider && lider !== 'TODOS') {
    items = items.filter(it => (it.lider_nombre || 'Sin Líder').trim() === lider);
  }

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="p-8 text-center text-slate-400 font-medium">
          No hay laptops reingresadas registradas aún en este turno.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const horaRetorno = item.retornado_en ? new Date(item.retornado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';

    return `
      <tr class="hover:bg-slate-50 transition border-b border-slate-100">
        <td class="p-3 font-mono font-bold text-xs text-emerald-800">${horaRetorno}</td>
        <td class="p-3 font-bold text-slate-900">${item.nombres}</td>
        <td class="p-3 font-mono text-xs text-slate-600">${item.cedula}</td>
        <td class="p-3 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
        <td class="p-3 font-bold text-xs text-slate-700">${item.modelo || 'DELL'}</td>
        <td class="p-3 text-xs font-semibold text-slate-800">${item.lider_nombre}</td>
        <td class="p-3 text-xs text-slate-600">${item.retornado_por || 'Garita'}</td>
        <td class="p-3 text-center">
          <span class="px-2.5 py-1 rounded-full text-[11px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300">
            ✓ PRESENCIAL
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

async function ejecutarRetornoPorEscaneo(e) {
  e.preventDefault();
  const input = document.getElementById('inputEscaneoRetorno');
  const term = input.value.trim();
  if (!term) return;

  try {
    const res = await fetchAuth('/api/garita/retornar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codigo_maquina: term,
        cedula: term,
        retornado_por: currentUser ? currentUser.nombre : 'Guardia Garita'
      })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      mostrarConfirmacionRetorno(json.data);
      input.value = '';
      input.focus();
      cargarEquiposFuera();
      cargarRetornosHoy();
      actualizarMetricasGenerales();
    } else if (json.ya_retornado) {
      playTone(440, 'triangle', 0.2);
      mostrarAlertaYaRetornado(json.data);
      input.value = '';
      input.focus();
    } else {
      playErrorSound();
      showToast(json.error || 'No se encontró equipo para reingresar.', 'error');
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function confirmarRetornoEquipo(id, asesorNombre) {
  if (!confirm(`¿Confirmar reingreso físico del equipo del asesor ${asesorNombre}?\n\nAl confirmar, el asesor cambiará a estado PRESENCIAL (Equipo bajo custodia en oficina).`)) return;

  try {
    const res = await fetchAuth('/api/garita/retornar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, retornado_por: currentUser ? currentUser.nombre : 'Guardia Garita' })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      mostrarConfirmacionRetorno(json.data);
      cargarEquiposFuera();
      cargarRetornosHoy();
      actualizarMetricasGenerales();
    } else if (json.ya_retornado) {
      mostrarAlertaYaRetornado(json.data);
    } else {
      showToast(json.error || 'Error al procesar el retorno.', 'error');
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function mostrarConfirmacionRetorno(data) {
  const container = document.getElementById('contenedorResultadoRetorno');
  if (!container) return;

  const horaRet = data.hora_retorno ? new Date(data.hora_retorno).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Recién';

  container.innerHTML = `
    <div class="bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100 border-4 border-emerald-500 text-emerald-950 p-6 sm:p-7 rounded-3xl shadow-xl">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-emerald-200">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center shadow-md font-black shrink-0">
            <i data-lucide="shield-check" class="w-7 h-7"></i>
          </div>
          <div>
            <span class="px-3 py-0.5 bg-emerald-600 text-white text-[11px] font-black uppercase rounded-full tracking-wider shadow-xs">
              ✓ REINGRESO FÍSICO CONFIRMADO
            </span>
            <div class="text-xs font-bold text-emerald-800 mt-1 flex flex-wrap items-center gap-1.5">
              <span>ESTADO ACTUALIZADO:</span>
              <span class="px-2 py-0.5 bg-white border border-emerald-400 text-emerald-900 rounded font-black">
                🏢 ASESOR EN PLANTA / PRESENCIAL
              </span>
            </div>
          </div>
        </div>
        <button onclick="cerrarResultadoRetorno()" class="touch-btn px-4 py-2 bg-emerald-200 hover:bg-emerald-300 text-emerald-950 rounded-xl text-xs font-black self-end sm:self-auto transition">
          ✕ Cerrar / Siguiente
        </button>
      </div>

      <div class="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white/90 backdrop-blur p-4 rounded-2xl border border-emerald-200 shadow-xs">
          <div class="text-[10px] font-black uppercase text-slate-500">Asesor que Reingresa</div>
          <div class="text-base font-black text-slate-900 mt-0.5 leading-tight">${data.nombres}</div>
          <div class="text-xs font-mono text-slate-600 mt-1 font-semibold">Cédula: ${data.cedula}</div>
        </div>

        <div class="bg-white/90 backdrop-blur p-4 rounded-2xl border border-emerald-200 shadow-xs">
          <div class="text-[10px] font-black uppercase text-slate-500">Equipo Devuelto</div>
          <div class="text-base font-mono font-black text-blue-800 mt-0.5">${data.codigo_maquina}</div>
          <div class="text-xs font-bold text-slate-600 mt-1">Modelo: ${data.modelo || 'DELL'}</div>
        </div>

        <div class="bg-white/90 backdrop-blur p-4 rounded-2xl border border-emerald-200 shadow-xs">
          <div class="text-[10px] font-black uppercase text-slate-500">Líder & Área</div>
          <div class="text-base font-black text-slate-800 mt-0.5">${data.lider_nombre}</div>
          <div class="text-xs text-slate-600 font-medium">${data.area || 'Operaciones'}</div>
        </div>

        <div class="bg-white/90 backdrop-blur p-4 rounded-2xl border border-emerald-200 shadow-xs">
          <div class="text-[10px] font-black uppercase text-slate-500">Hora de Recepción</div>
          <div class="text-base font-black text-emerald-700 mt-0.5">${horaRet}</div>
          <div class="text-xs text-slate-600 font-medium">Receptor: ${data.retornado_por || 'Garita'}</div>
        </div>
      </div>

      <div class="mt-4 p-3 bg-white/70 rounded-xl border border-emerald-300 text-xs font-semibold text-emerald-950 flex items-center gap-2">
        <i data-lucide="info" class="w-4 h-4 text-emerald-600 shrink-0"></i>
        <span>El equipo ha reingresado a custodia de la empresa. Si el líder requiere que este asesor vuelva a salir más tarde o en días posteriores, podrá emitir una nueva solicitud normalmente.</span>
      </div>
    </div>
  `;

  container.classList.remove('hidden');
  lucide.createIcons();
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function mostrarAlertaYaRetornado(data) {
  const container = document.getElementById('contenedorResultadoRetorno');
  if (!container) return;

  const horaRet = data.retornado_en ? new Date(data.retornado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Hoy';

  container.innerHTML = `
    <div class="bg-amber-50 border-4 border-amber-400 text-amber-950 p-6 sm:p-7 rounded-3xl shadow-xl">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-amber-200">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center shadow-md font-black shrink-0">
            <i data-lucide="alert-triangle" class="w-7 h-7"></i>
          </div>
          <div>
            <span class="px-3 py-0.5 bg-amber-600 text-white text-[11px] font-black uppercase rounded-full tracking-wider shadow-xs">
              ⚠️ ATENCIÓN: ESTE EQUIPO YA FUE REINGRESADO
            </span>
            <div class="text-xs font-bold text-amber-900 mt-1">
              EL ASESOR YA SE ENCUENTRA EN ESTADO PRESENCIAL / EN PLANTA
            </div>
          </div>
        </div>
        <button onclick="cerrarResultadoRetorno()" class="touch-btn px-4 py-2 bg-amber-200 hover:bg-amber-300 text-amber-950 rounded-xl text-xs font-black self-end sm:self-auto transition">
          ✕ Cerrar
        </button>
      </div>

      <div class="mt-4 p-4 bg-white rounded-2xl border border-amber-200 text-xs text-amber-950 space-y-1">
        <p class="text-base font-black text-slate-900">${data.nombres} (C.I: ${data.cedula})</p>
        <p class="font-medium text-slate-700">Equipo <strong>${data.codigo_maquina} (${data.modelo || 'DELL'})</strong> ya fue recibido en Garita a las <strong>${horaRet}</strong> por <strong>${data.retornado_por || 'Garita'}</strong>.</p>
        <p class="text-amber-800 font-bold mt-2">No es necesario reingresarlo nuevamente. El equipo ya está bajo custodia de la empresa.</p>
      </div>
    </div>
  `;

  container.classList.remove('hidden');
  lucide.createIcons();
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cerrarResultadoRetorno() {
  const container = document.getElementById('contenedorResultadoRetorno');
  if (container) container.classList.add('hidden');
  const input = document.getElementById('inputEscaneoRetorno');
  if (input) {
    input.value = '';
    input.focus();
  }
}

// =========================================================================
// SECCIÓN 6: TRAZABILIDAD & AUDITORÍA
// =========================================================================

async function consultarTrazabilidad(e) {
  e.preventDefault();
  const input = document.getElementById('inputTrazabilidadQuery');
  const term = input.value.trim();
  const container = document.getElementById('resultadoTrazabilidad');

  if (!term) return;

  try {
    const res = await fetchAuth(`/api/trazabilidad?q=${encodeURIComponent(term)}`);
    const json = await res.json();

    container.classList.remove('hidden');

    if (!json.ok || (json.solicitudes.length === 0 && json.logs.length === 0)) {
      container.innerHTML = `<div class="p-6 bg-slate-50 border rounded-xl text-center text-slate-500">No se encontraron movimientos históricos para [${term}].</div>`;
      return;
    }

    container.innerHTML = `
      <div class="space-y-4">
        <h3 class="text-sm font-black uppercase text-slate-800">Historial de Préstamos para: ${json.termino}</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-100 text-slate-700 font-bold">
              <tr>
                <th class="p-2.5">Fecha</th>
                <th class="p-2.5">Asesor</th>
                <th class="p-2.5">Cédula</th>
                <th class="p-2.5">Líder</th>
                <th class="p-2.5">N° Serie</th>
                <th class="p-2.5">Estado</th>
                <th class="p-2.5">Despacho</th>
                <th class="p-2.5">Retorno</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${json.solicitudes.map(s => `
                <tr>
                  <td class="p-2.5">${s.fecha_salida}</td>
                  <td class="p-2.5 font-bold">${s.nombres}</td>
                  <td class="p-2.5 font-mono">${s.cedula}</td>
                  <td class="p-2.5">${s.lider_nombre}</td>
                  <td class="p-2.5 font-mono font-bold text-blue-700">${s.codigo_maquina}</td>
                  <td class="p-2.5"><span class="px-2 py-0.5 rounded-full font-black text-[10px] ${getBadgeClass(s.estado)}">${s.estado}</span></td>
                  <td class="p-2.5 text-[11px]">${s.despachado_en || '--'}</td>
                  <td class="p-2.5 text-[11px]">${s.retornado_en || '--'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (error) {
    showToast('Error consultando trazabilidad: ' + error.message, 'error');
  }
}

async function cargarAuditoria() {
  try {
    const res = await fetchAuth('/api/auditoria');
    const json = await res.json();

    const tbody = document.getElementById('tablaAuditoria');
    if (!tbody) return;

    if (!json.ok || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400">No hay registros de auditoría.</td></tr>`;
      return;
    }

    tbody.innerHTML = json.data.map(log => {
      let colorAccion = 'text-blue-600';
      if (log.accion.includes('FALLO')) colorAccion = 'text-rose-600 font-bold';
      if (log.accion.includes('APROBADA')) colorAccion = 'text-emerald-600 font-bold';
      if (log.accion.includes('SALIDA')) colorAccion = 'text-sky-600 font-bold';
      if (log.accion.includes('CAMBIO')) colorAccion = 'text-purple-600 font-bold';
      if (log.accion.includes('LOGIN')) colorAccion = 'text-emerald-700 font-bold';

      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-3 text-slate-500">${log.timestamp}</td>
          <td class="p-3 ${colorAccion}">${log.accion}</td>
          <td class="p-3 font-semibold text-slate-800">${log.usuario}</td>
          <td class="p-3 text-slate-700">${log.detalles}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando auditoría:', error);
  }
}

async function actualizarMetricasGenerales() {
  try {
    const today = getFechaLocalEcuador();
    const res = await fetchAuth(`/api/stats?fecha=${today}`);
    const json = await res.json();

    if (json.ok) {
      const s = json.stats;

      const elGPendientes = document.getElementById('statGaritaPendientes');
      const elGSalidas = document.getElementById('statGaritaSalidas');
      const elGAfuera = document.getElementById('statGaritaAfuera');
      if (elGPendientes) elGPendientes.textContent = s.aprobadas;
      if (elGSalidas) elGSalidas.textContent = s.salieron;
      if (elGAfuera) elGAfuera.textContent = s.equiposAfueraTotal;

      const elSTotal = document.getElementById('statSistemasTotal');
      const elSPend = document.getElementById('statSistemasPendientes');
      const elSAprob = document.getElementById('statSistemasAprobadas');
      const elSSalio = document.getElementById('statSistemasSalieron');
      const elSRet = document.getElementById('statSistemasRetornadas');
      const elSRech = document.getElementById('statSistemasRechazadas');

      if (elSTotal) elSTotal.textContent = s.totalHoy;
      if (elSPend) elSPend.textContent = s.pendientes;
      if (elSAprob) elSAprob.textContent = s.aprobadas;
      if (elSSalio) elSSalio.textContent = s.salieron;
      if (elSRet) elSRet.textContent = s.retornados;
      if (elSRech) elSRech.textContent = s.rechazados;
      const elSTotalAfuera = document.getElementById('statSistemasTotalAfuera');
      if (elSTotalAfuera) elSTotalAfuera.textContent = s.equiposAfueraTotal;

      const badgeNav = document.getElementById('badgePendientesNav');
      if (badgeNav) {
        if (s.pendientes > 0) {
          badgeNav.textContent = s.pendientes;
          badgeNav.classList.remove('hidden');
        } else {
          badgeNav.classList.add('hidden');
        }
      }
    }
  } catch (error) {
    console.error('Error actualizando métricas:', error);
  }
}

function getBadgeClass(estado) {
  switch (estado) {
    case 'PENDIENTE': return 'badge-pendiente';
    case 'APROBADO': return 'badge-aprobado';
    case 'SALIO': return 'badge-salio';
    case 'RETORNADO': return 'badge-retornado';
    case 'NO_SALIO': return 'badge-no-salio';
    case 'RECHAZADO': return 'badge-rechazado';
    default: return 'bg-slate-100 text-slate-700';
  }
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMessage');
  const toastIcon = document.getElementById('toastIcon');

  toastMsg.textContent = message;
  toast.className = 'fixed bottom-5 right-5 z-50 transition-all duration-300 flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl text-sm font-bold text-white pointer-events-none ';

  if (type === 'success') {
    toast.className += 'bg-emerald-600';
    toastIcon.setAttribute('data-lucide', 'check-circle');
  } else if (type === 'error') {
    toast.className += 'bg-rose-600';
    toastIcon.setAttribute('data-lucide', 'alert-octagon');
  } else {
    toast.className += 'bg-slate-800';
    toastIcon.setAttribute('data-lucide', 'info');
  }

  lucide.createIcons();
  toast.classList.remove('translate-y-24', 'opacity-0');

  setTimeout(() => {
    toast.classList.add('translate-y-24', 'opacity-0');
  }, 3500);
}

// =============================================================
// MODULO: CONTROL Y PASE LIBRE DE LAPTOPS DE LÍDERES
// =============================================================

function renderizarPaseLibreLiderEnGarita(lider) {
  const container = document.getElementById('contenedorResultadoGarita');
  if (!container || !lider) return;

  playLeaderSound();

  const esFuera = (lider.estado_ubicacion === 'FUERA');
  const proximoMovimiento = esFuera ? 'INGRESO' : 'SALIDA';
  const colorBorde = esFuera ? 'border-indigo-500' : 'border-purple-600';
  const colorBg = esFuera ? 'bg-indigo-50' : 'bg-purple-50';
  const btnColor = esFuera ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-purple-600 hover:bg-purple-500';
  const accionTexto = esFuera ? 'REGISTRAR REINGRESO A PLANTA (ENTER)' : 'CONFIRMAR SALIDA LIBRE (ENTER)';
  const accionIcono = esFuera ? 'log-in' : 'log-out';

  const cargoTexto = (lider.cargo || 'Líder de Operaciones').toUpperCase();
  const deptoTexto = lider.area_default || 'Cobranzas';
  const cedulaTexto = lider.cedula ? `<span class="font-mono text-slate-950 bg-white px-2 py-0.5 rounded border border-purple-200">${lider.cedula}</span>` : '<span class="italic text-slate-400">Sin registrar</span>';

  container.innerHTML = `
    <div class="${colorBg} border-4 ${colorBorde} rounded-3xl p-6 sm:p-8 shadow-2xl card-success-pulse">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-purple-200">
        <div class="flex items-center gap-5">
          <div class="w-20 h-20 rounded-2xl bg-purple-700 text-white flex items-center justify-center font-black text-3xl shadow-lg">
            👑
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="px-3 py-1 bg-purple-700 text-white text-xs font-black uppercase rounded-full tracking-wider flex items-center gap-1">
                <span>👑 PASE LIBRE AUTORIZADO - ${cargoTexto}</span>
              </span>
              <span class="text-xs ${esFuera ? 'text-indigo-800' : 'text-purple-800'} font-bold">
                Estado Actual: <strong>${esFuera ? '🔴 FUERA DE PLANTA' : '🟢 EN PLANTA (OFICINA)'}</strong>
              </span>
            </div>
            <h2 class="text-2xl sm:text-4xl font-black text-slate-900 tracking-tight mt-1">${lider.nombre_completo || lider.nombre}</h2>
            <div class="flex flex-wrap items-center gap-3 text-sm text-slate-700 mt-1 font-semibold">
              <span>Cédula: ${cedulaTexto}</span>
              <span>&bull;</span>
              <span>Depto: <strong class="text-purple-900">${deptoTexto}</strong></span>
              <span>&bull;</span>
              <span>Cargo: <strong class="text-slate-900">${lider.cargo || 'Líder'}</strong></span>
              <span>&bull;</span>
              <span>Paso: <strong class="text-emerald-700">Libre sin ticket</strong></span>
            </div>
          </div>
        </div>

        <div class="bg-white px-6 py-4 rounded-2xl border-2 border-purple-400 text-center shadow-md">
          <div class="text-[11px] uppercase font-black text-purple-900 tracking-wider">Laptop Asignada</div>
          <div class="text-3xl font-mono font-black text-purple-700 mt-1 tracking-widest">${lider.codigo_maquina}</div>
          <div class="text-xs font-bold text-slate-600 mt-0.5">${lider.modelo || 'Laptop DELL'}</div>
        </div>
      </div>

      <div class="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/70 p-4 sm:p-5 rounded-2xl border border-purple-300">
        <div class="flex items-center gap-3 text-purple-950">
          <i data-lucide="shield-check" class="w-8 h-8 text-purple-600 flex-shrink-0"></i>
          <div>
            <div class="font-black text-base">Equipo y Funcionario Verificados Correctamente</div>
            <div class="text-xs text-purple-800 font-medium">Cuenta con pase libre institucional. Presione el botón o pulse ENTER para registrar en la bitácora.</div>
          </div>
        </div>

        <div class="flex items-center gap-2 w-full sm:w-auto">
          <button 
            type="button" 
            id="btnConfirmarMovimientoLiderGarita"
            onclick="confirmarMovimientoLider(${lider.id}, '${lider.codigo_maquina}', '${proximoMovimiento}')"
            class="touch-btn w-full sm:w-auto px-8 py-4 ${btnColor} text-white text-base font-black rounded-2xl shadow-xl flex items-center justify-center gap-3 transition-all transform active:scale-95"
            autofocus
          >
            <i data-lucide="${accionIcono}" class="w-6 h-6"></i>
            <span>${accionTexto}</span>
          </button>
          <button onclick="limpiarGarita()" class="px-4 py-4 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-2xl text-xs font-black">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  `;

  lucide.createIcons();

  setTimeout(() => {
    const btn = document.getElementById('btnConfirmarMovimientoLiderGarita');
    if (btn) btn.focus();
  }, 100);
}

async function confirmarMovimientoLider(liderId, codigoMaquina, tipo = 'SALIDA') {
  try {
    const guardia = currentUser ? currentUser.nombre : 'Guardia Garita';
    const res = await fetchAuth('/api/garita/lideres/movimiento', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lider_id: liderId,
        codigo_maquina: codigoMaquina,
        tipo_movimiento: tipo,
        guardia,
        observaciones: `Registro de ${tipo === 'SALIDA' ? 'salida libre' : 'reingreso'} en Garita`
      })
    });

    const json = await res.json();
    if (!json.ok) {
      playErrorSound();
      alert(json.error || 'Error al registrar movimiento del líder.');
      return;
    }

    playSuccessSound();
    showToast(json.message, 'success');

    limpiarGarita();
    cerrarResultadoLider();

    await cargarLideresEquipos();
    await cargarBitacoraMovimientosLideres();
  } catch (error) {
    showToast('Error registrando movimiento: ' + error.message, 'error');
  }
}

async function cargarLideresEquipos() {
  try {
    const res = await fetchAuth('/api/lideres-directorio');
    const json = await res.json();

    if (!json.ok || !json.data) return;

    lideresEquiposCache = json.data;

    const total = lideresEquiposCache.length;
    const enPlanta = lideresEquiposCache.filter(l => l.estado_ubicacion !== 'FUERA').length;
    const fuera = lideresEquiposCache.filter(l => l.estado_ubicacion === 'FUERA').length;

    const elTotal = document.getElementById('statLideresTotal');
    const elEnPlanta = document.getElementById('statLideresEnPlanta');
    const elFuera = document.getElementById('statLideresFuera');

    if (elTotal) elTotal.textContent = total;
    if (elEnPlanta) elEnPlanta.textContent = enPlanta;
    if (elFuera) elFuera.textContent = fuera;

    renderizarTablaLideresEquipos(lideresEquiposCache);
  } catch (error) {
    console.error('Error al cargar nómina de líderes y equipos:', error);
  }
}

function filtrarTablaLideresEquipos() {
  const q = (document.getElementById('filtroLideresEquipos')?.value || '').toLowerCase().trim();
  const deptoFiltro = document.getElementById('filtroDeptoLideresEquipos')?.value || 'TODOS';
  const estadoFiltro = document.getElementById('filtroUbicacionLider')?.value || 'TODOS';

  let filtrados = lideresEquiposCache.filter(l => {
    const matchQ = !q || 
      (l.nombre && l.nombre.toLowerCase().includes(q)) || 
      (l.nombre_completo && l.nombre_completo.toLowerCase().includes(q)) || 
      (l.cedula && l.cedula.toLowerCase().includes(q)) ||
      (l.cargo && l.cargo.toLowerCase().includes(q)) ||
      (l.codigo_maquina && l.codigo_maquina.toLowerCase().includes(q)) ||
      (l.modelo && l.modelo.toLowerCase().includes(q));

    let matchDepto = (deptoFiltro === 'TODOS' || (l.area_default || 'Cobranzas') === deptoFiltro);

    let matchEstado = true;
    if (estadoFiltro === 'EN_PLANTA') {
      matchEstado = (l.estado_ubicacion !== 'FUERA');
    } else if (estadoFiltro === 'FUERA') {
      matchEstado = (l.estado_ubicacion === 'FUERA');
    }

    return matchQ && matchDepto && matchEstado;
  });

  renderizarTablaLideresEquipos(filtrados);
}

function renderizarTablaLideresEquipos(lideres) {
  const tbody = document.getElementById('tablaLideresEquipos');
  if (!tbody) return;

  const esSistemas = (currentUser && currentUser.rol === 'sistemas');
  const thGestionTI = document.getElementById('thGestionTILideres');
  const btnAgregarLider = document.getElementById('btnAgregarNuevoLiderEnEquipos');

  if (esSistemas) {
    if (thGestionTI) thGestionTI.classList.remove('hidden');
    if (btnAgregarLider) btnAgregarLider.classList.remove('hidden');
  } else {
    if (thGestionTI) thGestionTI.classList.add('hidden');
    if (btnAgregarLider) btnAgregarLider.classList.add('hidden');
  }

  const colSpanCount = esSistemas ? 10 : 9;

  if (!lideres || lideres.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${colSpanCount}" class="text-center py-8 text-slate-400 font-bold">
          No se encontraron líderes o personal con los filtros aplicados.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = lideres.map((l, index) => {
    const esFuera = (l.estado_ubicacion === 'FUERA');
    const badgeUbicacion = esFuera
      ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black bg-purple-100 text-purple-800 border border-purple-300">
           <span class="w-2 h-2 rounded-full bg-purple-600 animate-pulse"></span> FUERA CON LAPTOP
         </span>`
      : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 border border-emerald-300">
           <span class="w-2 h-2 rounded-full bg-emerald-600"></span> EN PLANTA (OFICINA)
         </span>`;

    const accionBtn = esFuera
      ? `<button 
           onclick="confirmarMovimientoLider(${l.id}, '${l.codigo_maquina}', 'INGRESO')"
           class="touch-btn px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow flex items-center gap-1 mx-auto transition"
           title="Registrar reingreso a planta"
         >
           <i data-lucide="log-in" class="w-3.5 h-3.5"></i>
           <span>Reingreso</span>
         </button>`
      : `<button 
           onclick="confirmarMovimientoLider(${l.id}, '${l.codigo_maquina}', 'SALIDA')"
           class="touch-btn px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-black shadow flex items-center gap-1 mx-auto transition"
           title="Registrar salida autorizada de la laptop"
         >
           <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
           <span>Salida Libre</span>
         </button>`;

    const ultimoMov = l.ultimo_movimiento_en
      ? `<div class="text-xs text-slate-700 font-semibold">${new Date(l.ultimo_movimiento_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
         <div class="text-[10px] text-slate-400">${l.ultimo_movimiento_tipo === 'SALIDA' ? 'Salida' : 'Entrada'} por ${l.ultimo_guardia || 'Garita'}</div>`
      : `<span class="text-xs text-slate-400 italic">Sin registros hoy</span>`;

    const adminCol = esSistemas ? `
      <td class="py-3 px-4 text-center">
        <div class="flex items-center justify-center gap-1.5">
          <button 
            onclick="abrirModalFormularioPersonal(${l.id})"
            class="touch-btn px-2.5 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white rounded-xl text-xs font-black border border-blue-200 shadow-xs flex items-center gap-1 transition"
            title="Editar serie laptop, cédula o nombres"
          >
            <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
            <span>Editar</span>
          </button>
          <button 
            onclick="eliminarPersonalDirectorio(${l.id}, '${(l.nombre_completo || l.nombre).replace(/'/g, "\\'")}')"
            class="touch-btn px-2 py-1.5 bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white rounded-xl text-xs font-bold border border-rose-200 shadow-xs flex items-center gap-1 transition"
            title="Eliminar líder"
          >
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            <span>Eliminar</span>
          </button>
        </div>
      </td>
    ` : '';

    return `
      <tr class="hover:bg-slate-50 transition border-b border-slate-100">
        <td class="py-3 px-4 font-mono text-xs text-slate-400">${index + 1}</td>
        <td class="py-3 px-4">
          <div class="font-black text-slate-900">${l.nombre_completo || l.nombre}</div>
          <div class="text-[11px] text-purple-700 font-mono">Usuario: ${l.nombre}</div>
        </td>
        <td class="py-3 px-4 font-mono text-xs font-bold text-slate-700">
          ${l.cedula ? `<span class="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">${l.cedula}</span>` : '<span class="text-slate-400 italic font-normal">Sin cédula</span>'}
        </td>
        <td class="py-3 px-4">
          <div class="font-black text-slate-800 text-xs">${l.area_default || 'Cobranzas'}</div>
          <div class="text-[11px] text-slate-500 font-medium">${l.cargo || 'Funcionario'}</div>
        </td>
        <td class="py-3 px-4 font-mono font-black text-blue-700 text-sm tracking-wider">
          ${l.codigo_maquina ? `<span class="bg-blue-50 border border-blue-200 px-2 py-1 rounded-lg">${l.codigo_maquina}</span>` : '<span class="text-rose-400 font-normal">Sin asignar</span>'}
        </td>
        <td class="py-3 px-4 text-xs font-bold text-slate-600">
          ${l.modelo || 'Laptop'}
        </td>
        <td class="py-3 px-4 text-center">
          ${badgeUbicacion}
        </td>
        <td class="py-3 px-4">
          ${ultimoMov}
        </td>
        <td class="py-3 px-4 text-center">
          ${accionBtn}
        </td>
        ${adminCol}
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

async function cargarBitacoraMovimientosLideres() {
  const tbody = document.getElementById('tablaBitacoraLideres');
  if (!tbody) return;

  try {
    const res = await fetchAuth('/api/garita/lideres/movimientos');
    const json = await res.json();

    if (!json.ok || !json.data) return;

    lideresMovimientosCache = json.data;

    if (lideresMovimientosCache.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-6 text-slate-400 font-bold">
            No se han registrado movimientos de laptops de líderes en las últimas 24 horas.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = lideresMovimientosCache.map(m => {
      const esSalida = (m.tipo_movimiento === 'SALIDA');
      const badgeTipo = esSalida
        ? `<span class="px-2.5 py-1 rounded-full font-black text-[11px] bg-purple-100 text-purple-800 border border-purple-200">
             SALIDA LIBRE
           </span>`
        : `<span class="px-2.5 py-1 rounded-full font-black text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-200">
             REINGRESO A PLANTA
           </span>`;

      const fechaHoraFormato = m.fecha_hora 
        ? new Date(m.fecha_hora).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) + ' ' + new Date(m.fecha_hora).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
        : '--';

      return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="py-2.5 px-4 font-mono font-bold text-slate-700">
            ${fechaHoraFormato}
          </td>
          <td class="py-2.5 px-4 font-black text-slate-900">
            ${m.nombre_completo || m.lider_nombre}
          </td>
          <td class="py-2.5 px-4 font-mono font-black text-blue-700">
            ${m.codigo_maquina}
          </td>
          <td class="py-2.5 px-4 text-center">
            ${badgeTipo}
          </td>
          <td class="py-2.5 px-4 font-semibold text-slate-700">
            ${m.guardia || 'Garita'}
          </td>
          <td class="py-2.5 px-4 text-slate-500 italic">
            ${m.observaciones || 'Verificado conforme'}
          </td>
        </tr>
      `;
    }).join('');

    lucide.createIcons();
  } catch (error) {
    console.error('Error al cargar bitácora de líderes:', error);
  }
}

async function verificarLiderPorEscaneo(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('inputEscaneoLider');
  const term = (input ? input.value : '').trim().toUpperCase();
  const container = document.getElementById('contenedorResultadoLider');

  if (!term || !container) return;

  container.classList.remove('hidden');

  let lider = lideresEquiposCache.find(l => 
    (l.codigo_maquina && l.codigo_maquina.toUpperCase() === term) ||
    (l.nombre && l.nombre.toUpperCase() === term) ||
    (l.cedula && l.cedula === term) ||
    (l.nombre_completo && l.nombre_completo.toUpperCase().includes(term))
  );

  if (!lider) {
    try {
      const res = await fetchAuth(`/api/garita/buscar?q=${encodeURIComponent(term)}`);
      const json = await res.json();
      if (json.ok && json.encontrado && json.es_lider && json.lider) {
        lider = json.lider;
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (lider) {
    playLeaderSound();
    const esFuera = (lider.estado_ubicacion === 'FUERA');
    const proximoMovimiento = esFuera ? 'INGRESO' : 'SALIDA';
    const btnTexto = esFuera ? 'REGISTRAR INGRESO A PLANTA (ENTER)' : 'CONFIRMAR SALIDA DE PLANTA (ENTER)';
    const btnColor = esFuera ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-purple-600 hover:bg-purple-500';
    const badgeColor = esFuera ? 'bg-indigo-700' : 'bg-purple-700';
    const cargoTexto = (lider.cargo || 'Líder de Operaciones').toUpperCase();

    container.innerHTML = `
      <div class="bg-gradient-to-r from-purple-50 via-indigo-50 to-purple-50 border-4 border-purple-500 rounded-3xl p-6 sm:p-8 shadow-2xl card-success-pulse">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-purple-200">
          <div class="flex items-center gap-5">
            <div class="w-20 h-20 rounded-2xl bg-purple-700 text-white flex items-center justify-center font-black text-3xl shadow-lg">
              👑
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="px-3 py-1 ${badgeColor} text-white text-xs font-black uppercase rounded-full tracking-wider">
                  👑 PASE LIBRE AUTORIZADO - ${cargoTexto}
                </span>
                <span class="text-xs font-bold text-purple-900">
                  Estado: <strong>${esFuera ? '🔴 FUERA DE PLANTA' : '🟢 EN PLANTA (OFICINA)'}</strong>
                </span>
              </div>
              <h2 class="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight mt-1">
                ${lider.nombre_completo || lider.nombre}
              </h2>
              <div class="flex flex-wrap items-center gap-3 text-sm text-slate-700 mt-1 font-semibold">
                <span>Cédula: <strong class="font-mono text-purple-900 bg-white px-1.5 py-0.5 rounded border border-purple-200">${lider.cedula || 'N/A'}</strong></span>
                <span>&bull;</span>
                <span>Depto: <strong class="text-purple-900">${lider.area_default || 'Cobranzas'}</strong></span>
                <span>&bull;</span>
                <span>Cargo: <strong class="text-slate-900">${lider.cargo || 'Funcionario'}</strong></span>
                <span>&bull;</span>
                <span>Paso: <strong class="text-emerald-700">Libre sin ticket</strong></span>
              </div>
            </div>
          </div>

          <div class="bg-white px-6 py-4 rounded-2xl border-2 border-purple-400 text-center shadow-md">
            <div class="text-[11px] uppercase font-black text-purple-900 tracking-wider">Laptop Oficial Asignada</div>
            <div class="text-3xl font-mono font-black text-purple-700 mt-1 tracking-widest">${lider.codigo_maquina}</div>
            <div class="text-xs font-bold text-slate-600 mt-0.5">${lider.modelo || 'DELL Corporativo'}</div>
          </div>
        </div>

        <div class="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/70 p-4 sm:p-5 rounded-2xl border border-purple-300">
          <div class="flex items-center gap-3 text-purple-950">
            <i data-lucide="shield-check" class="w-8 h-8 text-purple-600 flex-shrink-0"></i>
            <div>
              <div class="font-black text-base">Equipo corresponde al Líder</div>
              <div class="text-xs text-purple-800 font-medium">Presione el botón o ENTER para registrar el movimiento en la bitácora de Garita.</div>
            </div>
          </div>

          <div class="flex items-center gap-2 w-full sm:w-auto">
            <button 
              type="button" 
              id="btnConfirmarMovLiderEscaneo"
              onclick="confirmarMovimientoLider(${lider.id}, '${lider.codigo_maquina}', '${proximoMovimiento}')"
              class="touch-btn w-full sm:w-auto px-8 py-4 ${btnColor} text-white text-base font-black rounded-2xl shadow-xl flex items-center justify-center gap-3 transition-all transform active:scale-95"
              autofocus
            >
              <i data-lucide="${esFuera ? 'log-in' : 'log-out'}" class="w-6 h-6"></i>
              <span>${btnTexto}</span>
            </button>
            <button onclick="cerrarResultadoLider()" class="px-4 py-4 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-2xl text-xs font-black">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    `;

    lucide.createIcons();
    if (input) input.value = '';

    setTimeout(() => {
      const btn = document.getElementById('btnConfirmarMovLiderEscaneo');
      if (btn) btn.focus();
    }, 100);

  } else {
    playErrorSound();
    container.innerHTML = `
      <div class="bg-rose-50 border-4 border-rose-600 text-rose-950 p-6 sm:p-8 rounded-3xl shadow-2xl shake-error">
        <div class="flex items-start gap-4">
          <div class="p-4 bg-rose-200 text-rose-900 rounded-2xl flex-shrink-0">
            <i data-lucide="shield-alert" class="w-10 h-10"></i>
          </div>
          <div class="flex-1">
            <span class="px-3 py-1 bg-rose-600 text-white text-xs font-black uppercase rounded-full tracking-wider">
              🛑 ALERTA DE SEGURIDAD - NO CORRESPONDE A NINGÚN LÍDER
            </span>
            <h2 class="text-2xl sm:text-3xl font-black text-rose-900 mt-2">
              LA SERIE [${term}] NO ESTÁ ASIGNADA A NINGÚN LÍDER
            </h2>
            <div class="mt-2 text-base font-bold text-rose-800">
              "Oiga, esta no es su máquina, no le deben permitir salir"
            </div>
            <div class="mt-3 p-4 bg-white/90 border-2 border-rose-300 rounded-2xl text-xs font-bold text-rose-950 space-y-1">
              <div>⚠️ <strong>Acción requerida del Guardia de Garita:</strong></div>
              <div>1. No permita la salida del equipo físico con pase libre.</div>
              <div>2. Verifique si la persona es un asesor que requiere ticket regular aprobado por Sistemas en la pantalla principal de Garita.</div>
              <div>3. Si es un líder, verifique que lleve su máquina asignada consultando la tabla inferior.</div>
            </div>
          </div>
          <button onclick="cerrarResultadoLider()" class="px-4 py-2 bg-rose-200 hover:bg-rose-300 text-rose-950 rounded-xl text-xs font-black flex-shrink-0">
            Cerrar
          </button>
        </div>
      </div>
    `;

    lucide.createIcons();
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function cerrarResultadoLider() {
  const container = document.getElementById('contenedorResultadoLider');
  if (container) {
    container.classList.add('hidden');
    container.innerHTML = '';
  }
  const input = document.getElementById('inputEscaneoLider');
  if (input) input.focus();
}

