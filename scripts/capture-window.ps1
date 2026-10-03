# Saves a PNG of the first visible window whose title contains $TitlePart (only that window, via
# PrintWindow, not the whole screen). Used by run-smoke-test.mjs so agents can see the UI.
param([string]$TitlePart = "Extension Development Host", [string]$OutFile)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Capture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
}
"@

$process = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitlePart*" } | Select-Object -First 1
if ($null -eq $process) { Write-Error "No window title contains '$TitlePart'"; exit 1 }
$hwnd = $process.MainWindowHandle
$rect = New-Object Win32Capture+RECT
[void][Win32Capture]::GetWindowRect($hwnd, [ref]$rect)
$bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
[void][Win32Capture]::PrintWindow($hwnd, $hdc, 2)  # 2 = PW_RENDERFULLCONTENT (needed for Chromium)
$graphics.ReleaseHdc($hdc)
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
Write-Output "Saved $OutFile ($($process.MainWindowTitle))"
