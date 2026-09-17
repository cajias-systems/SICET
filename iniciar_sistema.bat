@echo off
title Sistema de Control de Salidas de Equipos - Teletrabajo
cd /d "%~dp0"
echo ================================================================
echo    SISTEMA DE CONTROL DE SALIDAS DE EQUIPOS - TELETRABAJO
echo ================================================================
echo.
echo Iniciando servidor local...
echo.
start "" http://localhost:3000
node server.js
pause
