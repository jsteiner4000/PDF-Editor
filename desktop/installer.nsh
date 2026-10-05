; Ergänzungen für den NSIS-Installer (electron-builder, nsis.include).
;
; Standardprogramm für .pdf: Eine eigene Seite im Installer fragt, ob PDFix das
; Standardprogramm für PDF-Dateien werden soll (Standard: ja). Registriert wird benutzerbezogen
; (HKCU, keine Adminrechte): ProgID, OpenWithProgids, Applications-Eintrag und
; RegisteredApplications/Capabilities, damit die App unter „Standard-Apps“ erscheint.
; Windows erlaubt Programmen nicht, sich selbst zum Standard zu machen – das bestätigt der
; Nutzer. Deshalb öffnet der Installer am Ende die Windows-Einstellung „Standard-Apps“ direkt
; bei PDFix (nicht bei stiller Installation). Der Uninstaller entfernt alle Einträge
; wieder; bei einem Update bleibt die frühere Wahl erhalten.

!define PDFE_PROGID "PDFix.Dokument"
!define PDFE_CAPS "Software\PDFix\Capabilities"

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var PdfeAssocCheckbox
  Var PdfeAssocState

  ; Voreinstellung der Auswahl: neue Installation = angeboten; bei einem Update die frühere
  ; Wahl beibehalten (war die Zuordnung abgewählt, bleibt sie es). Gelesen wird vor dem
  ; Entfernen der alten Version, deren Uninstaller die Einträge löscht.
  !macro customInit
    StrCpy $PdfeAssocState ${BST_CHECKED}
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $0 != ""
      ReadRegStr $1 HKCU "Software\Classes\${PDFE_PROGID}\shell\open\command" ""
      ${If} $1 == ""
        StrCpy $PdfeAssocState ${BST_UNCHECKED}
      ${EndIf}
    ${EndIf}
  !macroend

  ; Seite nach der Ordnerwahl (assistierter Installer; MUI2 ist hier bereits geladen)
  !macro customPageAfterChangeDir
    Page custom PdfeAssocPageCreate PdfeAssocPageLeave

    Function PdfeAssocPageCreate
      !insertmacro MUI_HEADER_TEXT "Standardprogramm für PDF-Dateien" "PDFix zum Standard-PDF-Programm machen"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 52u "Mit dieser Option wird PDFix Ihr Standardprogramm für PDF-Dateien: Ein Doppelklick auf eine PDF öffnet sie direkt in PDFix.$\r$\n$\r$\nWindows lässt Programme nicht selbst zum Standard werden. Nach der Installation öffnet sich deshalb die Windows-Einstellung „Standard-Apps“ – dort bestätigen Sie PDFix mit einem Klick."
      Pop $0
      ${NSD_CreateCheckbox} 0 62u 100% 12u "PDFix zum Standardprogramm für PDF-Dateien machen"
      Pop $PdfeAssocCheckbox
      ${NSD_SetState} $PdfeAssocCheckbox $PdfeAssocState
      nsDialogs::Show
    FunctionEnd

    Function PdfeAssocPageLeave
      ${NSD_GetState} $PdfeAssocCheckbox $PdfeAssocState
    FunctionEnd
  !macroend

  !macro customInstall
    DeleteRegKey HKCU "Software\Classes\PDFEditor.Dokument"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDFEditor.Dokument"
    DeleteRegValue HKCU "Software\RegisteredApplications" "PDF-Editor"
    DeleteRegKey HKCU "Software\PDF-Editor"
    ${If} $PdfeAssocState == ${BST_CHECKED}
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}" "" "PDF-Dokument"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}" "FriendlyTypeName" "PDF-Dokument"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\shell\open" "FriendlyAppName" "PDFix"
      WriteRegStr HKCU "Software\Classes\${PDFE_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${PDFE_PROGID}" ""
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "PDFix"
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
      WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      WriteRegStr HKCU "${PDFE_CAPS}" "ApplicationName" "PDFix"
      WriteRegStr HKCU "${PDFE_CAPS}" "ApplicationDescription" "PDF-Dateien bearbeiten: Texte, Bilder und Seiten."
      WriteRegStr HKCU "${PDFE_CAPS}\FileAssociations" ".pdf" "${PDFE_PROGID}"
      WriteRegStr HKCU "Software\RegisteredApplications" "PDFix" "${PDFE_CAPS}"
      ; Explorer über die geänderte Zuordnung informieren (SHCNE_ASSOCCHANGED)
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
      ; Windows-Einstellung „Standard-Apps“ bei PDFix öffnen: dort bestätigt der Nutzer
      ; die Wahl (Windows 11 springt direkt zu PDFix, Windows 10 zeigt die Liste)
      ${IfNot} ${Silent}
        ExecShell "open" "ms-settings:defaultapps?registeredAppUser=PDFix"
      ${EndIf}
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\${PDFE_PROGID}"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${PDFE_PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "PDFix"
  DeleteRegKey HKCU "Software\PDFix"
  ; Einträge aus der Zeit vor der Umbenennung (PDF-Editor)
  DeleteRegKey HKCU "Software\Classes\PDFEditor.Dokument"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDFEditor.Dokument"
  DeleteRegValue HKCU "Software\RegisteredApplications" "PDF-Editor"
  DeleteRegKey HKCU "Software\PDF-Editor"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
