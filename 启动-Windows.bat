@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Geo Positioning Workstation - Windows launcher (ASCII on purpose: cmd mis-parses
rem UTF-8 batch files with CJK, so every message here stays in the OEM-safe range and
rem the Chinese manual is referenced by enumerating the .md file instead of naming it).
rem
rem The console skin, and why this one looks nothing like the other four:
rem   cmd.exe talks to conhost, not necessarily to a VT terminal, and whether escape
rem   bytes are honoured depends on the console host plus an improved-mode flag this
rem   script cannot set without touching the registry. So the HUD here is built from
rem   the two things every cmd.exe has always had: the built-in "color" command (one
rem   palette for the whole window) and ASCII frames. The palette is used as a STATE
rem   readout - amber while probing, green when a bridge answered /api/health, red
rem   when it did not - so the window colour alone tells you which path was taken.
rem   The Unix launchers do use truecolor SGR and block frames, on purpose: five
rem   platforms, five faces, one /api contract behind them. See MANUAL.md, section
rem   2.10.
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

title Geo Position Workstation
color 0E >nul 2>nul

echo  =========================================================================
echo    G E O   P O S I T I O N   W O R K S T A T I O N
echo    w i n d o w s   c o n s o l e   H U D      ascii frame + palette state
echo  =========================================================================
echo     [SYS] bridge  : server.py   /   bridge-powershell.ps1
echo     [SYS] bind    : 127.0.0.1 only. non-loopback is refused at start-up
echo     [SYS] upload  : none. a coordinate parameter is rejected, not ignored
echo     [LEG] amber = probing   green = bridge online   red = no bridge
echo  -------------------------------------------------------------------------
echo     [ENV] probing python ...

where python >nul 2>nul && call :try python
if not defined PY where py >nul 2>nul && call :try py
if not defined PY goto :psbridge

echo     [PY ] interpreter       : %PY%
echo     [BRG] start             : %PY% server.py  -  loopback only
echo           close the minimized bridge window to stop the service
start "GeoWorkstation bridge - close to stop" /min %PY% server.py --port %PORT%
call :poll
if defined READY goto :ready

:psbridge
if defined READY goto :ready
echo     [PS ] no usable python  : using the PowerShell 5.1 bridge instead
echo     [BRG] start             : bridge-powershell.ps1  -  no Python needed
start "GeoWorkstation PS bridge - close to stop" /min powershell -NoProfile -ExecutionPolicy Bypass -File bridge-powershell.ps1 -Port %PORT%
call :poll
if defined READY goto :ready

color 0C >nul 2>nul
echo     [!! ] no bridge answered /api/health in about 20s  -  offline page
echo         Port %PORT% may be busy. To see why, run the bridge by hand:
echo           powershell -File bridge-powershell.ps1
echo         If PowerShell blocks an unsigned script, add:
echo           -ExecutionPolicy Bypass
echo         Offline self-check, binds no port at all:
echo           powershell -File bridge-powershell.ps1 -SelfTest
echo         Panel 8 reports "bridge unavailable"; every other panel is live.
start "" "index.html"
goto :done

:ready
color 0A >nul 2>nul
echo     [OK ] bridge online     : http://127.0.0.1:%PORT%/  -  same origin
echo     [OK ] panel 8 unlocked  : dns, ping, traceroute, interfaces, all local
echo  -------------------------------------------------------------------------
start "" "http://127.0.0.1:%PORT%/index.html"
goto :done

:try
rem actually run the interpreter once: the Microsoft Store python stub passes "where" but not this
%1 -c "import sys" >nul 2>nul && set "PY=%1"
goto :eof

:poll
rem Up to 10 probes, ~1s apart. PowerShell does the probe (not %PY%) so the same code
rem path can verify either bridge, and it is present even when Python is not.
rem One subroutine call per attempt instead of a parenthesized loop body: the frame
rem stays readable and no ")" can close a block early.
for /l %%i in (1,1,10) do call :probe %%i
goto :eof

:probe
if defined READY goto :eof
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 1|Out-Null;exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto :bridge_up
echo     [POLL] /api/health attempt %1 of 10 ...
ping -n 2 127.0.0.1 >nul
goto :eof

:bridge_up
set "READY=1"
goto :eof

:done
echo.
echo  =========================================================================
echo     Close this window any time; keep the "GeoWorkstation ... bridge" one.
echo     Manual - Chinese file names are listed at run time, cmd cannot type them:
for %%f in (*.md) do echo      %%f
echo     this window closes itself in about 15 seconds
endlocal

rem ping is used for the delay on purpose: "timeout" is not always the Windows one
rem (Git Bash and some toolchains put a coreutils timeout earlier on PATH), while
rem ping.exe is guaranteed here and already used for the health poll above.
ping -n 16 127.0.0.1 >nul
