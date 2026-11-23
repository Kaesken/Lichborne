; DaMaps Editor — the Windows installer to share.
; Built by `node tools/damaps-editor/build.mjs --pack --installer`, which packs
; the program folder (release/win-unpacked) and runs makensis on this file with
; -DSRC=<that folder> -DOUT=<setup exe> -DVERSION=<x.y.z> -DFILES=<list .nsh>.
; Hand-written rather than electron-builder's NSIS target, which needs Wine.
;
; Installs for the current user (no admin): %LOCALAPPDATA%\Programs\DaMaps Editor
; by default, folder can be changed. Start menu shortcut, optional desktop
; shortcut, an entry in Settings → Apps for uninstalling. Maps are kept in
; Documents\DaMaps by the editor itself, never in the program folder, so
; updating or uninstalling never touches them. The uninstaller removes only
; the files it installed (FILES), so a folder chosen by mistake isn't emptied.

Unicode true
!include "MUI2.nsh"

!define APP "DaMaps Editor"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DaMapsEditor"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\DaMaps Editor"
InstallDirRegKey HKCU "Software\DaMaps Editor" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "DaMaps Editor ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Lichborne contributors"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${APP} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "${APP} makes and changes maps for Lichborne's Da'Maps.$\r$\n$\r$\nYour maps are kept in Documents\DaMaps. Use $\"Latest maps$\" in the editor to download the official ones.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\DaMaps Editor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP} now"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Put a shortcut on the desktop"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function DesktopShortcut
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\DaMaps Editor.exe"
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; an update: clear out the old program's folders first (only ours)
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall DaMaps Editor.exe"
  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\DaMaps Editor.exe"
  WriteRegStr HKCU "Software\DaMaps Editor" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "Lichborne contributors"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\DaMaps Editor.exe"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall DaMaps Editor.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" 365000
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  !include "${FILES}"
  Delete "$INSTDIR\Uninstall DaMaps Editor.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\DaMaps Editor"
SectionEnd
