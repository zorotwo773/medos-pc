Dim fso, sh, script, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
script  = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "START.ps1")
If Not fso.FileExists(script) Then
  MsgBox "MedOS cannot start: START.ps1 is missing." & vbCrLf & vbCrLf & script, 16, "MedOS"
  WScript.Quit 1
End If
exitCode = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, True)
If exitCode <> 0 Then
  MsgBox "MedOS could not start. Run START.bat to see the detailed error.", 16, "MedOS"
End If
Set sh  = Nothing
Set fso = Nothing
