@if "%SCM_TRACE_LEVEL%" NEQ "4" @echo off

:: ----------------------
:: Git Deployment Script for Node.js on SmarterASP.NET
:: Version: 2.0.0 - Git Deployment
:: ----------------------

echo.
echo ========================================
echo Git Deployment for Hire Purchase Backend
echo ========================================
echo.

:: Prerequisites
:: -------------
echo [1/6] Checking prerequisites...
where node 2>nul >nul
IF %ERRORLEVEL% NEQ 0 (
  echo ERROR: Missing node.js executable
  echo Please install node.js on the server
  goto error
)
echo Node.js found: OK

:: Setup
:: -----

setlocal enabledelayedexpansion

SET ARTIFACTS=%~dp0%..\artifacts

IF NOT DEFINED DEPLOYMENT_SOURCE (
  SET DEPLOYMENT_SOURCE=%~dp0%.
)

IF NOT DEFINED DEPLOYMENT_TARGET (
  SET DEPLOYMENT_TARGET=%ARTIFACTS%\wwwroot
)

IF NOT DEFINED NEXT_MANIFEST_PATH (
  SET NEXT_MANIFEST_PATH=%ARTIFACTS%\manifest

  IF NOT DEFINED PREVIOUS_MANIFEST_PATH (
    SET PREVIOUS_MANIFEST_PATH=%ARTIFACTS%\manifest
  )
)

IF NOT DEFINED KUDU_SYNC_CMD (
  :: Install kudu sync
  echo [2/6] Installing Kudu Sync...
  call npm install kudusync -g --silent
  IF !ERRORLEVEL! NEQ 0 goto error

  :: Locally just running "kuduSync" would also work
  SET KUDU_SYNC_CMD=%appdata%\npm\kuduSync.cmd
)

::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: Deployment
:: ----------

echo.
echo ========================================
echo Starting Deployment Process
echo ========================================
echo.

:: 1. KuduSync
echo [3/6] Syncing files...
IF /I "%IN_PLACE_DEPLOYMENT%" NEQ "1" (
  call :ExecuteCmd "%KUDU_SYNC_CMD%" -v 50 -f "%DEPLOYMENT_SOURCE%" -t "%DEPLOYMENT_TARGET%" -n "%NEXT_MANIFEST_PATH%" -p "%PREVIOUS_MANIFEST_PATH%" -i ".git;.hg;.deployment;deploy.cmd;node_modules;src;.gitignore;README.md"
  IF !ERRORLEVEL! NEQ 0 goto error
)
echo File sync: OK

:: 2. Select node version
call :SelectNodeVersion

:: 3. Install npm packages
echo.
echo [4/6] Installing npm packages...
IF EXIST "%DEPLOYMENT_TARGET%\package.json" (
  pushd "%DEPLOYMENT_TARGET%"
  call npm install --production
  IF !ERRORLEVEL! NEQ 0 goto error
  popd
)
echo NPM install: OK

:: 4. Build TypeScript
echo.
echo [5/6] Building TypeScript...
IF EXIST "%DEPLOYMENT_TARGET%\package.json" (
  pushd "%DEPLOYMENT_TARGET%"

  :: Install dev dependencies temporarily for build
  call npm install --only=dev
  IF !ERRORLEVEL! NEQ 0 goto error

  :: Build
  call npm run build
  IF !ERRORLEVEL! NEQ 0 goto error

  :: Remove dev dependencies
  call npm prune --production
  IF !ERRORLEVEL! NEQ 0 goto error

  popd
)
echo TypeScript build: OK

:: 5. Generate Prisma Client
echo.
echo [6/6] Generating Prisma Client...
IF EXIST "%DEPLOYMENT_TARGET%\prisma\schema.prisma" (
  pushd "%DEPLOYMENT_TARGET%"
  call npx prisma generate
  IF !ERRORLEVEL! NEQ 0 goto error
  popd
)
echo Prisma Client: OK

::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
goto end

:: Execute command routine that will echo out when error
:ExecuteCmd
setlocal
set _CMD_=%*
call %_CMD_%
if "%ERRORLEVEL%" NEQ "0" echo Failed exitCode=%ERRORLEVEL%, command=%_CMD_%
exit /b %ERRORLEVEL%

:error
endlocal
echo An error has occurred during web site deployment.
call :exitSetErrorLevel
call :exitFromFunction 2>nul

:exitSetErrorLevel
exit /b 1

:exitFromFunction
()

:end
endlocal
echo Finished successfully.
