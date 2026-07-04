Set oShell = CreateObject("WScript.Shell")
Set oEnv = oShell.Environment("Process")
oEnv("ELECTRON_EXTRA_LAUNCH_ARGS") = "--remote-debugging-port=9223"
oShell.Run "explorer.exe shell:AppsFolder\TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop", 1, False
WScript.Sleep 1000
WScript.Echo "Launched"
