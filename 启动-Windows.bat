@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Geo Positioning Workstation - Windows launcher (ASCII on purpose: cmd mis-parses
rem UTF-8 batch files with CJK, so every message here stays in the OEM-safe range and
rem the Chinese manual is referenced by enumerating the .md file instead of naming it).
rem
rem What it does: find Python -> start the loopback-only bridge (server.py, binds
rem 127.0.0.1 only) -> open the app. No Python? The page still opens; only the
rem network/traceroute panel reports "bridge unavailable". Everything else is local.

set "PORT=8765"
set "PY="

where python >nul 2>nul && call :try python
if not defined PY where py >nul 2>nul && call :try py

if not defined PY goto :nopython

echo [start] launching local bridge with %PY% (127.0.0.1 only; close that window to stop)
start "GeoWorkstation bridge (close to stop)" /min %PY% server.py --port %PORT%

set "READY="
for /l %%i in (1,1,10) do (
  if not defined READY (
    %PY% -c "import urllib.request as u;u.urlopen('http://127.0.0.1:%PORT%/api/health',timeout=1)" >nul 2>nul && set "READY=1"
    if not defined READY ping -n 2 127.0.0.1 >nul
  )
)

if not defined READY goto :nofallback

echo [ready] bridge online at http://127.0.0.1:%PORT%/ - opening the app over http (same origin)
start "" "http://127.0.0.1:%PORT%/index.html"
goto :done

:nofallback
echo [note] bridge did not come up in 10s (port busy? see server.py output). Opening offline page.
echo        Panel 8 will honestly report "bridge unavailable"; every other panel keeps working.
start "" "index.html"
goto :done

:nopython
echo [note] No usable Python found - opening the offline page directly.
echo        Only panel 8 (IP / traceroute) needs Python; all other panels are local.
start "" "index.html"
goto :done

:try
rem actually run the interpreter once: the Microsoft Store python stub passes "where" but not this
%1 -c "import sys" >nul 2>nul && set "PY=%1"
goto :eof

:done
echo.
echo You can close this window; keep the "GeoWorkstation bridge" window if it is running.
echo Manual (Chinese):
for %%f in (*.md) do echo   %%f
echo (this window closes itself in about 15 seconds)
rem ping is used for the delay on purpose: "timeout" is not always the Windows one
rem (Git Bash and some toolchains put a coreutils timeout earlier on PATH), while
rem ping.exe is guaranteed here and already used for the health poll above.
ping -n 16 127.0.0.1 >nul
endlocal
