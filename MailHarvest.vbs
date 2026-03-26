Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & Replace(WScript.ScriptFullName, WScript.ScriptName, "") & """ && start.bat", 0, False
WScript.Sleep 3000
WshShell.Run "http://localhost:3000", 0, False
