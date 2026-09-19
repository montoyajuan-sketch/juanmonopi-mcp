@echo off
REM iniciar.bat — arranca el servidor con el Node portable (node-embed\node.exe),
REM sin depender de que el Node este instalado ni en el PATH de esta PC.
cd /d "%~dp0"
".\node-embed\node.exe" index.js
pause
