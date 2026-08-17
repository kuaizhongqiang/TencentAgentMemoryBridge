' dsh-memory-autostore-hidden.vbs
' Run scripts/dsh-memory-autostore.mjs once with a HIDDEN window.
'
' Why: the Windows scheduled task ("dsh-memory-autostore", every N minutes)
' runs node.exe directly, and node is a console application - so every run
' flashed a cmd window on the interactive desktop. wscript.exe has no console
' subsystem and the child is spawned with SW_HIDE (style 0), so nothing ever
' shows; stdout/stderr are appended to the run log beside this file.
'
' Usage:  wscript.exe dsh-memory-autostore-hidden.vbs
' (used by the scheduled task; can also be run manually for a silent once-run)

Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

nodePath = "C:\Program Files\nodejs\node.exe"
scriptPath = base & "\dsh-memory-autostore.mjs"
logPath = base & "\dsh-memory-autostore-run.log"

' cmd /c ""<node>" "<script>" --once >> "<log>" 2>&1"  (window style 0 = hidden)
cmdLine = "cmd /c """"" & nodePath & """ """ & scriptPath & """ --once >> """ & logPath & """ 2>&1"""
shell.Run cmdLine, 0, False
