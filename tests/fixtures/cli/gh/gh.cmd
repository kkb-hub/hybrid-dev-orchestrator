@echo off
if "%1"=="auth" exit /b 0
if "%1"=="api" if "%2"=="graphql" (type "%~dp0graphql-last-edited.json"& exit /b 0)
if "%1"=="api" if "%2"=="--paginate" (echo %6 | findstr /c:"/events" >nul && (type "%~dp0issue-events.json") || (type "%~dp0issue-comments.json")& exit /b 0)
if "%1"=="issue" if "%2"=="view" (type "%~dp0issue-view.json"& exit /b 0)
if "%1"=="issue" if "%2"=="list" (type "%~dp0issue-list.json"& exit /b 0)
if "%1"=="label" if "%2"=="list" (type "%~dp0label-list.json"& exit /b 0)
echo mock gh: unhandled arguments 1>&2
echo %1 %2 %3 %4 %5 %6 1>&2
exit /b 9
