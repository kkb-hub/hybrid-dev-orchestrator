@echo off
rem Windows launcher wrapper for the TypeScript/Node.js HDO PoC (Issue #18, AC-05).
rem %~dp0 resolves to this .cmd file's own directory (with a trailing backslash),
rem quoted throughout so it stays robust to paths containing spaces.
setlocal
node "%~dp0..\..\src\cli\main.ts" %*
exit /b %ERRORLEVEL%
