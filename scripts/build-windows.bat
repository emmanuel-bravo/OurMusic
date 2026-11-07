@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."
if not exist "bin" mkdir "bin"

where gcc >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OurMusic] Compilando motor de audio C11 para Windows ^(MinGW-w64 + WASAPI Exclusive/Shared^)...
    gcc -O2 -std=c11 ^
      native\main_engine.c ^
      native\engine_core.c ^
      native\dsp_eq.c ^
      native\dec_dispatch.c ^
      native\dec_wav.c ^
      native\dec_flac.c ^
      native\dec_alac.c ^
      native\dec_mp3.c ^
      native\dec_dsd.c ^
      native\hal_wasapi.c ^
      native\hal_wavsink.c ^
      -lole32 -lavrt -lksuser -lwinmm -luuid ^
      -o bin\ourmusic-engine.exe
    if %ERRORLEVEL% NEQ 0 (
        echo [OurMusic] Error al compilar con MinGW-w64 gcc.
        exit /b 1
    )
    echo [OurMusic] Compilado correctamente en bin\ourmusic-engine.exe
    exit /b 0
)

where cl >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OurMusic] Compilando motor de audio C11 para Windows ^(MSVC + WASAPI Exclusive/Shared^)...
    cl /nologo /O2 /std:c11 /D_CRT_SECURE_NO_WARNINGS ^
      native\main_engine.c ^
      native\engine_core.c ^
      native\dsp_eq.c ^
      native\dec_dispatch.c ^
      native\dec_wav.c ^
      native\dec_flac.c ^
      native\dec_alac.c ^
      native\dec_mp3.c ^
      native\dec_dsd.c ^
      native\hal_wasapi.c ^
      native\hal_wavsink.c ^
      ole32.lib avrt.lib ksuser.lib winmm.lib uuid.lib ^
      /Fe:bin\ourmusic-engine.exe
    if %ERRORLEVEL% NEQ 0 (
        echo [OurMusic] Error al compilar con MSVC cl.exe.
        exit /b 1
    )
    del *.obj >nul 2>nul
    echo [OurMusic] Compilado correctamente en bin\ourmusic-engine.exe
    exit /b 0
)

echo [OurMusic] No se encontro compilador C11 ^(MinGW-w64 gcc o MSVC cl.exe^) en PATH.
exit /b 1
