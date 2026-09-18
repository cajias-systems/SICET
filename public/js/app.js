// =========================================================================
// SISTEMA DE CONTROL DE SALIDAS DE EQUIPOS - CLIENTE RBAC & ROLES
// =========================================================================

let currentUser = null; // { id, username, nombre, rol, area }
let selectedSolicitudesSistemas = new Set();
let debounceTimer = null;
let ultimosDespachosCache = [];

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

// Wrapper para llamadas HTTP incluyendo rol en cabecera
async function fetchAuth(url, options = {}) {
  const headers = options.headers || {};
  if (currentUser && currentUser.rol) {
    headers['x-user-role'] = currentUser.rol;
  }
  return fetch(url, { ...options, headers });
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
        select.innerHTML = json.data.map(l => `<option value="${l.nombre}">${l.nombre}</option>`).join('');
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

  const today = new Date().toISOString().slice(0, 10);
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
  const navAuditoria = document.getElementById('nav-auditoria');

  // Restablecer visibilidad
  [navGarita, navSistemas, navReporte, navLideres, navRetornos, navAuditoria].forEach(el => {
    if (el) el.classList.remove('hidden');
  });

  if (rol === 'garita') {
    // El guardia solo ve Garita y Retornos
    if (navSistemas) navSistemas.classList.add('hidden');
    if (navReporte) navReporte.classList.add('hidden');
    if (navLideres) navLideres.classList.add('hidden');
    if (navAuditoria) navAuditoria.classList.add('hidden');
  } else if (rol === 'lider') {
    // El líder solo ve el portal de registro de líderes
    if (navGarita) navGarita.classList.add('hidden');
    if (navSistemas) navSistemas.classList.add('hidden');
    if (navReporte) navReporte.classList.add('hidden');
    if (navRetornos) navRetornos.classList.add('hidden');
    if (navAuditoria) navAuditoria.classList.add('hidden');
  } else if (rol === 'sistemas') {
    // Sistemas ve absolutamente todo
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
  const modulos = ['garita', 'sistemas', 'reporte-lideres', 'lideres', 'retornos', 'auditoria'];
  modulos.forEach(m => {
    const el = document.getElementById(`modulo-${m}`);
    const nav = document.getElementById(`nav-${m}`);
    if (el) el.classList.add('hidden');
    if (nav) {
      nav.classList.remove('bg-emerald-600', 'bg-blue-600', 'text-white', 'shadow-sm');
      nav.classList.add('text-slate-300', 'hover:text-white', 'hover:bg-slate-800');
    }
  });

  const activo = document.getElementById(`modulo-${moduloId}`);
  const navActivo = document.getElementById(`nav-${moduloId}`);
  if (activo) activo.classList.remove('hidden');
  if (navActivo) {
    const activeColor = moduloId === 'garita' ? 'bg-emerald-600' : 'bg-blue-600';
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
    const inputRet = document.getElementById('inputEscaneoRetorno');
    if (inputRet) inputRet.focus();
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
        selectLider.innerHTML = '<option value="">-- Seleccione Área / Campaña --</option>';
        json.data.forEach(a => {
          selectLider.innerHTML += `<option value="${a.nombre}">${a.nombre}</option>`;
        });
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

    const item = json.data[0];
    renderizarResultadoGarita(item);
  } catch (error) {
    showToast('Error en garita: ' + error.message, 'error');
  }
}

function renderizarResultadoGarita(item) {
  const container = document.getElementById('contenedorResultadoGarita');
  if (!container || !item) return;

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
            <p class="text-sm text-slate-800 mt-1">El equipo <strong>${item.codigo_maquina} (${item.modelo})</strong> ya registra salida previa a las <strong>${item.despachado_en || 'Hoy'}</strong> despachado por <strong>${item.despachado_por || 'Garita'}</strong>.</p>
          </div>
          <button onclick="limpiarGarita()" class="px-4 py-2 bg-blue-200 text-blue-950 rounded-xl text-xs font-black">Cerrar</button>
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
async function cargarPendientesDespachoGarita() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetchAuth(`/api/garita/pendientes-despacho?fecha=${today}`);
    const json = await res.json();

    const tbody = document.getElementById('tablaPendientesDespachoGarita');
    const badge = document.getElementById('badgeConteoPendientesGarita');
    const stat = document.getElementById('statGaritaPendientes');

    if (!json.ok || !json.data || json.data.length === 0) {
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

    const items = json.data;
    if (badge) {
      badge.textContent = `${items.length} ${items.length === 1 ? 'pendiente' : 'pendientes'}`;
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-600 text-white shadow-sm';
    }
    if (stat) stat.textContent = items.length;

    if (tbody) {
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
              <div class="text-xs font-bold text-slate-900">${item.lider_nombre || 'N/A'}</div>
              <div class="text-[11px] font-semibold text-emerald-800">${item.area}</div>
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
  } catch (error) {
    console.error('Error cargando pendientes en garita:', error);
  }
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
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetchAuth(`/api/solicitudes?fecha=${today}`);
    const json = await res.json();

    const tbody = document.getElementById('tablaDespachosHoy');
    if (!tbody) return;

    if (!json.ok || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400">No hay salidas registradas en el turno de hoy.</td></tr>`;
      ultimosDespachosCache = [];
      return;
    }

    // FILTRAR EXCLUSIVAMENTE SALIDAS EFECTUADAS (SALIO o RETORNADO) PARA NO CONFUNDIR AL GUARDIA
    const salidasReales = json.data.filter(item => item.estado === 'SALIO' || item.estado === 'RETORNADO');

    if (salidasReales.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400">Aún no ha salido ningún asesor por la garita hoy.</td></tr>`;
      ultimosDespachosCache = [];
      return;
    }

    ultimosDespachosCache = salidasReales;

    tbody.innerHTML = salidasReales.map(item => {
      const hora = item.despachado_en ? new Date(item.despachado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '--:--';
      const badgeClass = getBadgeClass(item.estado);

      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-mono text-xs font-bold">${hora}</td>
          <td class="py-3 px-4 font-black text-slate-900">${item.nombres}</td>
          <td class="py-3 px-4 font-mono text-xs text-slate-600">${item.cedula}</td>
          <td class="py-3 px-4 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
          <td class="py-3 px-4 font-bold text-xs text-slate-700">${item.modelo || 'DELL'}</td>
          <td class="py-3 px-4 text-xs font-semibold">${item.lider_nombre || item.area}</td>
          <td class="py-3 px-4 text-xs text-slate-600">${item.despachado_por || '--'}</td>
          <td class="py-3 px-4 text-center">
            <span class="px-2.5 py-1 rounded-full text-xs font-black uppercase ${badgeClass}">
              ${item.estado}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando despachos recientes:', error);
  }
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
  const fecha = document.getElementById('filtroSistemasFecha')?.value || new Date().toISOString().slice(0, 10);

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
  const fecha = document.getElementById('filtroSistemasFecha')?.value || new Date().toISOString().slice(0, 10);
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
  cargarListaDirectorioModal();
}

function cerrarModalDirectorioLideres() {
  const modal = document.getElementById('modalDirectorioLideres');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function cargarListaDirectorioModal() {
  const cont = document.getElementById('listaLideresDirectorioModal');
  if (!cont) return;
  try {
    const res = await fetch('/api/lideres-directorio');
    const json = await res.json();
    if (json.ok && json.data) {
      cont.innerHTML = json.data.map(l => `
        <div class="flex items-center justify-between py-2 px-1 text-xs">
          <span class="font-bold text-slate-800">${l.nombre}</span>
          <span class="text-slate-400 font-semibold">${l.piso ? 'Piso ' + l.piso : 'Rotativo'}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    cont.innerHTML = '<div class="p-3 text-rose-500">Error al cargar directorio.</div>';
  }
}

async function agregarLiderDirectorio(e) {
  e.preventDefault();
  const inp = document.getElementById('nuevoLiderNombre');
  const nombre = inp ? inp.value.trim() : '';
  if (!nombre) return;

  try {
    const res = await fetchAuth('/api/lideres-directorio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre })
    });
    const json = await res.json();
    if (json.ok) {
      showToast('Líder agregado al directorio oficial.', 'success');
      if (inp) inp.value = '';
      cargarListaDirectorioModal();
      cargarComboLideresLogin();
      cargarLideresSelectores();
    } else {
      alert(json.error || 'Error al agregar líder.');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
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
              
              <a href="/api/hoja-control?lider=${encodeURIComponent(grupo.lider)}&fecha=${desde || new Date().toISOString().slice(0, 10)}" target="_blank" class="touch-btn px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm">
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
                          <button onclick="confirmarRetornoEquipo(${item.id}, '${item.nombres}')" class="touch-btn px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold shadow flex items-center gap-1 ml-auto">
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
    const today = new Date().toISOString().slice(0, 10);
    const resSol = await fetchAuth(`/api/solicitudes?fecha=${today}&lider=${encodeURIComponent(liderNombre)}`);
    const jsonSol = await resSol.json();
    const solicitudesHoy = jsonSol.ok ? jsonSol.data : [];

    tbody.innerHTML = json.data.map(asesor => {
      const sol = solicitudesHoy.find(s => s.cedula === asesor.cedula || s.codigo_maquina === asesor.codigo_maquina);
      let estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">No enviado hoy</span>';
      let isChecked = false;
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
        } else if (sol.estado === 'RECHAZADO') {
          estadoBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-300">Rechazado</span>';
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
  const fechaSalida = new Date().toISOString().slice(0, 10);

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
  const area = currentUser ? (currentUser.area || 'Operaciones') : 'Operaciones';

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
    const today = new Date().toISOString().slice(0, 10);
    let url = `/api/solicitudes?fecha=${today}`;
    if (currentUser && currentUser.rol === 'lider') {
      url += `&lider=${encodeURIComponent(currentUser.nombre)}`;
    }

    const res = await fetchAuth(url);
    const json = await res.json();

    const tbody = document.getElementById('tablaLiderHoy');
    if (!tbody) return;

    if (!json.ok || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400">No hay solicitudes registradas para hoy.</td></tr>`;
      return;
    }

    tbody.innerHTML = json.data.map(item => {
      const badgeClass = getBadgeClass(item.estado);
      const detalle = item.estado === 'RECHAZADO' ? item.motivo_rechazo : (item.observaciones || '--');

      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-3 font-bold text-slate-800">${item.nombres}</td>
          <td class="p-3 font-mono text-xs">${item.cedula}</td>
          <td class="p-3 text-xs">${item.area}</td>
          <td class="p-3 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
          <td class="p-3 font-bold text-xs">${item.modelo || 'DELL'}</td>
          <td class="p-3">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-black uppercase ${badgeClass}">
              ${item.estado}
            </span>
          </td>
          <td class="p-3 text-xs text-slate-500">${detalle}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando solicitudes líder:', error);
  }
}

// =========================================================================
// SECCIÓN 5: RETORNO DE EQUIPOS
// =========================================================================

async function cargarEquiposFuera() {
  try {
    const res = await fetchAuth(`/api/solicitudes?estado=SALIO`);
    const json = await res.json();

    const tbody = document.getElementById('tablaEquiposFuera');
    if (!tbody) return;

    if (!json.ok || json.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400 font-medium">No hay equipos pendientes de retorno en este momento.</td></tr>`;
      return;
    }

    tbody.innerHTML = json.data.map(item => {
      const horaSalida = item.despachado_en ? new Date(item.despachado_en).toLocaleString('es-ES') : item.fecha_salida;

      return `
        <tr class="hover:bg-slate-50 transition">
          <td class="p-3 font-bold text-slate-800">${item.nombres}</td>
          <td class="p-3 font-mono text-xs">${item.cedula}</td>
          <td class="p-3 text-xs font-semibold">${item.lider_nombre}</td>
          <td class="p-3 font-mono text-xs font-bold text-blue-700">${item.codigo_maquina}</td>
          <td class="p-3 font-bold text-xs">${item.modelo || 'DELL'}</td>
          <td class="p-3 text-xs text-slate-600">${horaSalida}</td>
          <td class="p-3 text-xs text-slate-600">${item.despachado_por || '--'}</td>
          <td class="p-3 text-right">
            <button onclick="confirmarRetornoEquipo(${item.id}, '${item.nombres}')" class="touch-btn px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold shadow flex items-center gap-1.5 ml-auto">
              <i data-lucide="corner-down-left" class="w-3.5 h-3.5 text-emerald-400"></i>
              <span>Reingresar</span>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    lucide.createIcons();
  } catch (error) {
    showToast('Error al cargar equipos fuera: ' + error.message, 'error');
  }
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
        retornado_por: currentUser ? currentUser.nombre : 'Garita'
      })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast(json.message, 'success');
      input.value = '';
      input.focus();
      cargarEquiposFuera();
      actualizarMetricasGenerales();
    } else {
      playErrorSound();
      alert(json.error || 'No se encontró equipo para reingresar.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

async function confirmarRetornoEquipo(id, asesorNombre) {
  if (!confirm(`¿Confirmar reingreso físico del equipo del asesor ${asesorNombre}?`)) return;

  try {
    const res = await fetchAuth('/api/garita/retornar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, retornado_por: currentUser ? currentUser.nombre : 'Garita' })
    });
    const json = await res.json();

    if (json.ok) {
      playSuccessSound();
      showToast('Equipo retornado a oficina con éxito', 'success');
      cargarEquiposFuera();
      actualizarMetricasGenerales();
    } else {
      alert(json.error || 'Error al procesar el retorno.');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
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
    const today = new Date().toISOString().slice(0, 10);
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
