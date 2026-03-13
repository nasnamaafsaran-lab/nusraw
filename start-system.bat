@echo off
:: start-system.bat
:: Automated setup and startup script for Officer Document System
:: Node.js + PostgreSQL
:: Created by AI Assistant

title Officer System - Auto Starter
color 0F
cls

echo ======================================================
echo    OFFICER DOCUMENT SYSTEM - INITIALIZATION
echo    Node.js + PostgreSQL Automation
echo ======================================================
echo.

:: --------------------------------------------------------
:: 1. Check Node.js Installation
:: --------------------------------------------------------
echo [1/5] Checking Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [ERROR] Node.js is NOT installed!
    echo Please download and install Node.js from: https://nodejs.org/
    echo.
    pause
    exit
)
echo [OK] Node.js is installed.

:: --------------------------------------------------------
:: 2. Check PostgreSQL Service
:: --------------------------------------------------------
echo [2/5] Checking PostgreSQL Service...
:: We assume 'psql' is in the System PATH.
:: If not, we warn the user but try to proceed.

psql --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0E
    echo [WARNING] 'psql' command not found in PATH.
    echo Cannot verify database automatically.
    echo Please ensure PostgreSQL is running.
    echo.
) else (
    echo [OK] PostgreSQL tools found.
)

:: --------------------------------------------------------
:: 3. Check/Create Database (officer_system)
:: --------------------------------------------------------
echo [3/5] Checking Database 'officer_system'...

:: Set password for the session (as per request: 1234)
set PGPASSWORD=1234

:: Check if database exists
psql -U postgres -h localhost -lqt | findstr "officer_system" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Database not found. Creating 'officer_system'...
    createdb -U postgres -h localhost officer_system
    if %errorlevel% neq 0 (
        color 0C
        echo.
        echo [ERROR] Failed to create database.
        echo Reasons could be:
        echo  - PostgreSQL service is stopped
        echo  - Password '1234' is incorrect for user 'postgres'
        echo.
        pause
        exit
    )
    echo [OK] Database created successfully.
) else (
    echo [OK] Database 'officer_system' already exists.
)

:: --------------------------------------------------------
:: 4. Install Dependencies & Build Frontend
:: --------------------------------------------------------
echo [4/5] Installing Dependencies & Building...
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
) else (
    echo [OK] node_modules found.
)

echo [INFO] Building frontend (ensuring latest version)...
call npm run build
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Build failed!
    pause
    exit
)
echo [OK] Frontend built successfully.

:: --------------------------------------------------------
:: 5. Start Backend Server
:: --------------------------------------------------------
echo [5/5] Starting Server...
echo.
echo ======================================================
echo    SERVER IS RUNNING
echo    Do not close this window.
echo ======================================================
echo.

if exist "index.js" (
    node index.js
) else (
    color 0E
    echo [WARNING] 'index.js' not found!
    echo Please ensure index.js is in this folder: %CD%
    echo.
    pause
)

pause
