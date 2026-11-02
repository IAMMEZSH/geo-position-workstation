@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Geo Positioning Workstation - Windows launcher (ASCII on purpose: cmd mis-parses
rem UTF-8 batch files with CJK, so every message here stays in the OEM-safe range and
rem the Chinese manual is referenced by enumerating the .md file instead of naming it).
rem
rem Two bridge implementations share one /api contract, so the page cannot tell them
rem apart and either one lights up panel 8:
rem   server.py              - needs Python (only tried when a real interpreter exists)
rem   bridge-powershell.ps1  - needs nothing; PowerShell 5.1 ships with Windows
rem Order: Python bridge -> PowerShell bridge -> plain file:// page. A missing Python
rem is NOT a failure any more, and if both bridges fail the page still opens; only
rem panel 8 reports "bridge unavailable". Both bind 127.0.0.1 only.
rem
rem Flow below uses labels and gotos instead of parenthesized if-blocks on purpose:
rem an unescaped ")" inside "if ( ... )" ends the block there, which silently ate the
rem tail of the "[ready]" message during testing.

set "PORT=8765"
set "PY="
set "READY="

where python >nul 2>nul && call :try python
if not defined PY where py >nul 2>nul && call :try py
if not defined PY goto :psbridge

echo [start] bridge via %PY% server.py - 127.0.0.1 only, close that window to stop
start "GeoWorkstation bridge - close to stop" /min %PY% server.py --port %PORT%
call :poll
if defined READY goto :ready

:psbridge
if defined READY goto :ready
echo [start] bridge via bridge-powershell.ps1 - no Python needed, 127.0.0.1 only
start "GeoWorkstation PS bridge - close to stop" /min powershell -NoProfile -ExecutionPolicy Bypass -File bridge-powershell.ps1 -Port %PORT%
call :poll
if defined READY goto :ready

echo [note] Neither bridge answered /api/health within ~20s. Opening the offline page.
echo        Port %PORT% may already be busy. To see why, run the bridge by hand:
echo          powershell -NoProfile -ExecutionPolicy Bypass -File bridge-powershell.ps1
echo        Self-check without binding a port:
echo          powershell -NoProfile -ExecutionPolicy Bypass -File bridge-powershell.ps1 -SelfTest
echo        Panel 8 will honestly report "bridge unavailable"; every other panel keeps working.
start "" "index.html"
goto :done

:ready
echo [ready] bridge online at http://127.0.0.1:%PORT%/ - same origin, panel 8 unlocked
start "" "http://127.0.0.1:%PORT%/index.html"
goto :done

:try
rem actually run the interpreter once: the Microsoft Store python stub passes "where" but not this
%1 -c "import sys" >nul 2>nul && set "PY=%1"
goto :eof

:poll
rem Up to 10 probes, ~1s apart. PowerShell does the probe (not %PY%) so the same code
rem path can verify either bridge, and it is present even when Python is not.
for /l %%i in (1,1,10) do (
  if not defined READY (
    powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 1|Out-Null;exit 0}catch{exit 1}" >nul 2>nul && set "READY=1"
    if not defined READY ping -n 2 127.0.0.1 >nul
  )
)
goto :eof

:done
echo.
echo You can close this window; keep the "GeoWorkstation ... bridge" window if it is running.
echo Manual, Chinese file names listed because cmd cannot type them safely here:
for %%f in (*.md) do echo   %%f
echo this window closes itself in about 15 seconds
rem ping is used for the delay on purpose: "timeout" is not always the Windows one
rem (Git Bash and some toolchains put a coreutils timeout earlier on PATH), while
rem ping.exe is guaranteed here and already used for the health poll above.
ping -n 16 127.0.0.1 >nul
endlocal
