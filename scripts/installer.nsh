; dsh-desktop custom NSIS include (electron-builder nsis.include).
;
; electron-builder's default app-running check matches ANY process whose
; executable path starts with $INSTDIR — including the installer/uninstaller
; itself when it is launched from inside the install directory. An installer
; placed in the install dir then sees itself as "the running app" and loops
; forever on "please close the app". These macros re-implement the check while
; excluding the current process ($pid). Both the installer and the uninstaller
; call CHECK_APP_RUNNING, which prefers customCheckAppRunning when defined.

!ifndef DSH_INSTALLER_NSH
!define DSH_INSTALLER_NSH

!include "getProcessInfo.nsh"
Var /GLOBAL pid
; IsPowerShellAvailable is declared by the IS_POWERSHELL_AVAILABLE macro
; itself — declaring it here would collide when that macro expands.

; Note: CmdPath / PowerShellPath are declared and assigned by the
; CHECK_APP_RUNNING macro before customCheckAppRunning is expanded.

; FIND_PROCESS with the current (installer/uninstaller) PID excluded.
!macro FIND_PROCESS_SKIP_SELF _FILE _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.ProcessId -ne $pid -and $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    !ifdef INSTALL_MODE_PER_ALL_USERS
      # exact match via findstr anchored to the start of each CSV line
      nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
      Pop ${_RETURN}
    !else
      # find process owned by current user — anchored exact match
      nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
      Pop ${_RETURN}
    !endif
  ${endIf}
!macroend

; KILL_PROCESS with the current PID excluded (the taskkill branch already
; excludes it via /FI "PID ne $pid"; the PowerShell branch did not).
!macro KILL_PROCESS_SKIP_SELF _FILE _FORCE
  Push $0
  ${if} ${_FORCE} == 1
    ${if} $IsPowerShellAvailable == 0
      StrCpy $0 "-Force"
    ${else}
      StrCpy $0 "/F"
    ${endIf}
  ${else}
    StrCpy $0 ""
  ${endIf}
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.ProcessId -ne $pid -and $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId $0 }"`
  ${else}
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `taskkill /IM "${_FILE}" /FI "PID ne $pid"`
    !else
      nsExec::Exec `"$CmdPath" /C taskkill $0 /IM "${_FILE}" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"`
    !endif
  ${endIf}
  Pop $0
!macroend

; Same flow as electron-builder's _CHECK_APP_RUNNING, but the find/kill
; helpers above never match the installer/uninstaller process itself.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      # allow app to exit without explicit kill
      Sleep 300
    ${endIf}

    !insertmacro FIND_PROCESS_SKIP_SELF "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        Sleep 1000
        Goto doStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:

      DetailPrint "$(appClosing)"

      !insertmacro KILL_PROCESS_SKIP_SELF "${APP_EXECUTABLE_FILENAME}" 0
      Sleep 300

      StrCpy $R1 0

      loop:
        IntOp $R1 $R1 + 1

        !insertmacro FIND_PROCESS_SKIP_SELF "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro KILL_PROCESS_SKIP_SELF "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro FIND_PROCESS_SKIP_SELF "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${endIf}
!macroend

; Default install location: C:\Program Files\<APP_FILENAME> when no previous
; install was remembered and no /D= override was given. The default MUST end
; with ${APP_FILENAME} (the product name): assistedInstaller.nsh's instFilesPre
; appends a "${APP_FILENAME}" sub-folder to any $INSTDIR that does not contain
; it, so a custom name like "DeepSeekHarnessDesktop" (no spaces) would end up
; as C:\Program Files\DeepSeekHarnessDesktop\DeepSeek Harness Desktop.
; initMultiUser already restored a remembered location (HKLM per-machine /
; HKCU per-user), so only fill in the default when neither registry key has one.
!macro customInit
  !insertmacro GetDParameter $R2
  ${if} $R2 == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R0 == ""
    ${andif} $R1 == ""
      StrCpy $INSTDIR "$PROGRAMFILES64\${APP_FILENAME}"
    ${endif}
  ${endif}
!macroend

!endif ; DSH_INSTALLER_NSH
