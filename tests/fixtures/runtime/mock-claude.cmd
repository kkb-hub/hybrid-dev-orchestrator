@echo off
rem Stands in for the Claude CLI in adapter tests: ignores its arguments, drains
rem stdin to EOF (as the real claude CLI does when it reads the prompt), and prints
rem a fixed --output-format json result envelope on stdout. Draining matters: every
rem caller (tests/run-tests.ps1's Claude adapter and
rem src/runners/agentStep.integration.test.ts's NodeProcessRunner path) always
rem writes the prompt to this process's stdin and then closes it, so `more` always
rem sees EOF and returns immediately - it cannot block waiting on a keyboard. Without
rem this drain, this script used to exit as soon as `type` finished, so the parent's
rem stdin write could race this process's exit and fail with a broken pipe (EPIPE /
rem "Failed to write process input", surfaced as exit code 126) - an intermittent
rem failure of this fixture, not of the adapter under test.
more >nul
type "%~dp0claude-envelope.json"
