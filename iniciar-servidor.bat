@echo off
title EscuchaMapa - Servidor local
cd /d "%~dp0"
echo.
echo EscuchaMapa se ejecutara en:
echo http://localhost:5500
echo.
echo Deja esta ventana abierta mientras uses la app.
echo Para cerrar el servidor, presiona CTRL+C.
echo.
start "" http://localhost:5500
python -m http.server 5500
pause
