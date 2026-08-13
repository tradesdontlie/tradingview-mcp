' Double-clickable launcher for TradingView Desktop with the CDP debug port enabled.
'
' This used to set ELECTRON_EXTRA_LAUNCH_ARGS in its own process environment and then
' launch via "explorer.exe shell:AppsFolder\...". That never worked: the request is
' handed off to the already-running shell process, which never saw the variable, so
' TradingView started with a clean environment and no debug port — while this script
' still reported success. Promoting the variable to user scope does not help either.
'
' All the real work now lives in launch_tv_debug.ps1, which COM-activates the MSIX
' package with the flag and verifies the port actually bound before reporting success.

Option Explicit

Dim oShell, oFS, sDir, sPs1, sCmd

Set oShell = CreateObject("WScript.Shell")
Set oFS = CreateObject("Scripting.FileSystemObject")

sDir = oFS.GetParentFolderName(WScript.ScriptFullName)
sPs1 = oFS.BuildPath(sDir, "launch_tv_debug.ps1")

If Not oFS.FileExists(sPs1) Then
    WScript.Echo "Missing: " & sPs1
    WScript.Quit 1
End If

' -NoExit keeps the window open so the CDP-ready output (or the failure reason) can
' actually be read instead of flashing past. That means the process never exits on its
' own, so do NOT wait on it (bWaitOnReturn = False) — waiting would hang this script
' until the user closed the window, and the exit code of a -NoExit shell says nothing
' about whether the launch worked anyway.
sCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File """ & sPs1 & """"
oShell.Run sCmd, 1, False
