@echo off
REM build.bat — Build Mirabilis AI Setup.exe on Windows
REM Run from:  Mirabilis\desktop\
REM Output:    Mirabilis\desktop\dist\

setlocal

set SCRIPT_DIR=%~dp0
set MIRABILIS=%SCRIPT_DIR%..

if not exist "%MIRABILIS%\frontend" (
    echo ERROR: Run this from inside the Mirabilis\desktop\ folder.
    pause
    exit /b 1
)

echo =^> Installing backend dependencies...
cd /d "%MIRABILIS%\backend"
call npm install --silent
if errorlevel 1 goto error

echo =^> Installing frontend dependencies...
cd /d "%MIRABILIS%\frontend"
call npm install --silent
if errorlevel 1 goto error

echo =^> Building Next.js frontend (standalone)...
cd /d "%MIRABILIS%\frontend"
call npm run build
if errorlevel 1 goto error

set BUILD_DIR=%TEMP%\mirabilis-build-%RANDOM%
mkdir "%BUILD_DIR%"

echo =^> Staging build in %BUILD_DIR%

copy "%SCRIPT_DIR%main.js"     "%BUILD_DIR%\main.js" >nul
copy "%SCRIPT_DIR%preload.js"  "%BUILD_DIR%\preload.js" >nul
xcopy "%SCRIPT_DIR%icons"      "%BUILD_DIR%\icons" /E /I /Q >nul
copy "%SCRIPT_DIR%package.json" "%BUILD_DIR%\package.json" >nul

echo =^> Syncing backend into staging...
robocopy "%MIRABILIS%\backend" "%BUILD_DIR%\backend" /E /XD node_modules .git /NFL /NDL /NJH /NJS >nul

echo =^> Installing backend production deps...
cd /d "%BUILD_DIR%\backend"
call npm install --omit=dev --silent
if errorlevel 1 goto cleanup_error

echo =^> Syncing standalone frontend...
robocopy "%MIRABILIS%\frontend\.next\standalone" "%BUILD_DIR%\frontend\.next\standalone" /E /NFL /NDL /NJH /NJS >nul

echo =^> Copying static assets...
robocopy "%MIRABILIS%\frontend\.next\static" "%BUILD_DIR%\frontend\.next\standalone\frontend\.next\static" /E /NFL /NDL /NJH /NJS >nul

if exist "%MIRABILIS%\frontend\public" (
    robocopy "%MIRABILIS%\frontend\public" "%BUILD_DIR%\frontend\.next\standalone\frontend\public" /E /NFL /NDL /NJH /NJS >nul
)

echo =^> Installing Electron build tools...
cd /d "%BUILD_DIR%"
call npm install --silent
if errorlevel 1 goto cleanup_error

echo =^> Pre-extracting winCodeSign (avoids symlink error on Windows)...
set CODESIGN_CACHE=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign
set SEVENZIP=%BUILD_DIR%\node_modules\7zip-bin\win\x64\7za.exe
if not exist "%CODESIGN_CACHE%" mkdir "%CODESIGN_CACHE%"
for /f "delims=" %%F in ('dir /b "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-*.7z" 2^>nul') do (
    set ARCHIVE=%LOCALAPPDATA%\electron-builder\Cache\%%F
    set DEST=%CODESIGN_CACHE%\%%~nF
    if not exist "%CODESIGN_CACHE%\%%~nF" (
        echo    Extracting %%F...
        "%SEVENZIP%" x "%LOCALAPPDATA%\electron-builder\Cache\%%F" -o"%CODESIGN_CACHE%\%%~nF" -y >nul 2>&1
    )
)

echo =^> Running electron-builder...
call npx electron-builder --win --projectDir "%BUILD_DIR%"
if errorlevel 1 goto cleanup_error

echo =^> Copying output to dist\...
if exist "%SCRIPT_DIR%dist" rmdir /s /q "%SCRIPT_DIR%dist"
xcopy "%BUILD_DIR%\dist" "%SCRIPT_DIR%dist" /E /I /Q /Y >nul

echo =^> Cleaning up temp files...
rmdir /s /q "%BUILD_DIR%"

echo.
echo Build complete! Installer is in the dist\ folder.
explorer "%SCRIPT_DIR%dist"
goto end

:cleanup_error
echo =^> Cleaning up temp files...
rmdir /s /q "%BUILD_DIR%" 2>nul
:error
echo.
echo BUILD FAILED. See error above.
pause
exit /b 1

:end
exit /b 0
