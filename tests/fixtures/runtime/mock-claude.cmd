@echo off
rem Stands in for the Claude CLI in adapter tests: ignores its arguments and stdin
rem and prints a fixed --output-format json result envelope on stdout.
type "%~dp0claude-envelope.json"
