@echo off
rem Stands in for a failing Claude CLI: stdout contains the authoritative result
rem envelope while stderr contains a misleading model warning.
type "%~dp0claude-failure-envelope.json"
echo [claude-code:unrecognized_model] local-model 1>&2
exit /b 1
