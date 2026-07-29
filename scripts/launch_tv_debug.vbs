Set oShell = CreateObject("WScript.Shell")

Set oExec = oShell.Exec("powershell -NoProfile -Command ""$pkg = Get-AppxPackage | Where-Object { $_.Name -like '*TradingView*' -or $_.PackageFullName -like '*TradingView*' } | Select-Object -First 1; if ($pkg) { $manifest = [xml](Get-Content (Join-Path $pkg.InstallLocation 'AppxManifest.xml')); $pkg.PackageFamilyName + '!' + $manifest.Package.Applications.Application.Id }""")
appId = Trim(oExec.StdOut.ReadAll)

If appId = "" Then
  WScript.Echo "TradingView AppX package not found"
  WScript.Quit 1
End If

oShell.Run "powershell -NoProfile -Command ""Start-Process -FilePath 'shell:AppsFolder\" & appId & "' -ArgumentList '--remote-debugging-port=9222'""", 1, False
WScript.Sleep 1000
WScript.Echo "Launched " & appId
