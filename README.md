# 🛡️ Sistema Integral de Control de Salidas de Equipos (Teletrabajo)

Solución tecnológica para automatizar el ciclo de autorización, validación y despacho físico de computadoras para teletrabajo, conectando a **Líderes de Área**, **Sistemas / TI** y la **Garita de Seguridad**.

---

## 🎯 Problemas Resueltos

1. **Eliminación del caos de formatos:** Sustituye chats, capturas y excels sueltos por un portal único con validación y plantilla oficial.
2. **Aprobación ágil en Sistemas:** Centraliza la lista en una bandeja con aprobación en **1 solo clic** o por lotes masivos.
3. **Cero papel:** Se eliminan las carpetas y hojas impresas diarias que acumulaban los guardias.
4. **Despacho ultra rápido a las 5:00 p.m.:** Búsqueda por cédula o escaneo de código de barras en 1 segundo.
5. **Blindaje de seguridad física:** El guardia debe contrastar e ingresar obligatoriamente los **últimos dígitos de la serie física** de la máquina para desbloquear la salida, impidiendo errores o fugas de activos.
6. **Control de Retorno (Check-in):** Registra el reingreso del equipo al terminar el teletrabajo para mantener el inventario al día.

---

## 🚀 Puesta en Marcha Rápida

### Opción 1: Doble Clic en Windows
Simplemente ejecute el archivo:
```bash
iniciar_sistema.bat
```
Esto abrirá automáticamente su navegador en `http://localhost:3000`.

### Opción 2: Desde la Terminal
```bash
# Instalar dependencias (ya instaladas)
npm install

# Iniciar servidor
node server.js
```

---

## 🏢 Módulos Incluidos

### 1. 🛡️ Garita (Control Rápido de Salida)
- **Buscador rápido:** Compatible con digitación o lector de código de barras USB/cámara.
- **Validación visual instantánea:** Muestra si el asesor está Aprobado, Pendiente, Ya Despachado o Denegado.
- **Mecanismo de Desafío:** Exige el ingreso de los últimos dígitos del código de la máquina física.
- **Efectos auditivos:** Sonidos de confirmación y alerta de seguridad sintetizados vía Web Audio.

### 2. 💻 Sistemas (Panel Central)
- Métricas en tiempo real: Solicitudes del día, pendientes, aprobadas, equipos afuera y retornados.
- Filtros por fecha, campaña/área, estado y buscador de texto.
- Botón **"Aprobar Todo lo Pendiente"** en 1 clic.
- Botón **"Exportar a Excel"** con reporte detallado para auditorías.
- Rechazo con registro de motivo formal.

### 3. 📋 Portal Líderes
- **Formulario Individual:** Cédula, Nombres, Área, Código de Máquina, Accesorios, Fechas.
- **Carga Masiva Excel:** Botón para descargar la plantilla oficial `.xlsx` y botón para subir listas de 10, 20 o 50 personas en segundos.
- Consulta de estatus en vivo de sus solicitudes enviadas.

### 4. 🔄 Retorno de Equipos (Check-in)
- Listado de todos los equipos que se encuentran actualmente en la calle / teletrabajo.
- Botón de confirmación de reingreso físico con timestamp y nombre del operador.

### 5. 📊 Auditoría & Logs
- Bitácora inmutable con cada acción realizada (creación, aprobación, intento fallido de serie, salida confirmada y retornos).

---

## 🛠️ Tecnologías Utilizadas
- **Backend:** Node.js + Express
- **Base de Datos:** SQLite de alto rendimiento (`better-sqlite3` con WAL mode)
- **Procesamiento de Archivos:** `xlsx` y `multer`
- **Frontend:** HTML5, Tailwind CSS, Lucide Icons y Web Audio API
