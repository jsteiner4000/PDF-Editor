; Ergänzungen für den NSIS-Installer (electron-builder, nsis.include).
;
; Optionale Dateizuordnung für .pdf: Eine eigene Seite im Installer fragt, ob der PDF-Editor
; im Menü „Öffnen mit“ für PDF-Dateien angeboten werden soll (Standard: ja). Registriert wird
; benutzerbezogen (HKCU, keine Adminrechte): ProgID, OpenWithProgids, Applications-Eintrag und
; RegisteredApplications/Capabilities, damit die App auch unter „Standard-Apps“ erscheint.
; Windows erlaubt Programmen nicht, sich selbst zum Standard zu machen – das entscheidet der
; Nutzer („Öffnen mit“ > „Immer“). Der Uninstaller entfernt alle Einträge wieder.

!define PDFE_PROGID "PDFEditor.Dokument"
!define PDFE_CAPS "Software\PDF-Editor\Capabilities"

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var PdfeAssocCheckbox
  Var PdfeAssocState

  !macro customInit
    StrCpy $PdfeAssocState ${BST_CHECKED}
  !macroend

  ; Seite nach der Ordnerwahl (assistierter Installer; MUI2 ist hier bereits geladen)
  !macro customPageAfterChangeDir
    Page custom PdfeAssocPageCreate PdfeAssocPageLeave

    Function PdfeAssocPageCreate
      !insertmacro MUI_HEADER_TEXT "PDF-Dateien" "PDF-Editor im Menü „Öffnen mit“ anbieten"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 40u "Wenn diese Option gewählt ist, erscheint der PDF-Editor beim Rechtsklick auf eine PDF-Datei unter „Öffnen mit“. Als Standardprogramm für PDF-Dateien legen Sie ihn dort mit „Immer diese App verwenden“ fest."
      Pop $0
      ${NSD_CreateCheckbox} 0 48u 100% 12u "PDF-Editor für PDF-Dateien anbieten"
      Pop $PdfeAssocCheckbox
      ${NSD_SetState} $PdfeAssocCheckbox $PdfeAssocState
      nsDialogs::Show
    FunctionEnd

    Function PdfeAssocPageLeave
      ${NSD_GetState} $PdfeAssocCheckbox $PdfeAssocState
    FunctionEnd
  !macroend

  !macro customInstall
    ${If} $PdfeAssocState == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}" "" "PDF-Dokument"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}" "FriendlyTypeName" "PDF-Dokument"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\shell\open" "FriendlyAppName" "PDF-Editor"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${PDFE_PROGID}" ""
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "PDF-Editor"
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      WriteRegStr HKCU "${PDFE_CAPS}" "ApplicationName" "PDF-Editor"
      WriteRegStr HKCU "${PDFE_CAPS}" "ApplicationDescription" "PDF-Dateien bearbeiten: Texte, Bilder und Seiten."
      WriteRegStr HKCU "${PDFE_CAPS}\FileAssociations" ".pdf" "${PDFE_PROGID}"
      WriteRegStr HKCU "Software\RegisteredApplications" "PDF-Editor" "${PDFE_CAPS}"
      ; Explorer über die geänderte Zuordnung informieren (SHCNE_ASSOCCHANGED)
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\${PDFE_PROGID}"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${PDFE_PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "PDF-Editor"
  DeleteRegKey HKCU "Software\PDF-Editor"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
