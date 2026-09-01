Add-Type -AssemblyName System.Drawing

$projectPath = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $projectPath "icons"
New-Item -ItemType Directory -Path $iconPath -Force | Out-Null

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Write-ExtensionIcon([int]$size, [bool]$enabled) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $margin = [Math]::Max(1, $size * 0.03125)
  $background = if ($enabled) { [System.Drawing.ColorTranslator]::FromHtml("#ff5a36") } else { [System.Drawing.ColorTranslator]::FromHtml("#aeb7b3") }
  $foreground = if ($enabled) { [System.Drawing.Color]::White } else { [System.Drawing.ColorTranslator]::FromHtml("#f3f5f4") }
  $playColor = if ($enabled) { $background } else { [System.Drawing.ColorTranslator]::FromHtml("#7b8781") }

  $rounded = New-RoundedRectanglePath $margin $margin ($size - 2 * $margin) ($size - 2 * $margin) ($size * 0.22)
  $backgroundBrush = [System.Drawing.SolidBrush]::new($background)
  $graphics.FillPath($backgroundBrush, $rounded)

  $circleBrush = [System.Drawing.SolidBrush]::new($foreground)
  $circleSize = $size * 0.59
  $circleOffset = ($size - $circleSize) / 2
  $graphics.FillEllipse($circleBrush, $circleOffset, $circleOffset, $circleSize, $circleSize)

  $triangle = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($size * 0.43, $size * 0.34),
    [System.Drawing.PointF]::new($size * 0.43, $size * 0.66),
    [System.Drawing.PointF]::new($size * 0.68, $size * 0.50)
  )
  $playBrush = [System.Drawing.SolidBrush]::new($playColor)
  $graphics.FillPolygon($playBrush, $triangle)

  $suffix = if ($enabled) { "" } else { "-off" }
  $outputPath = Join-Path $iconPath "icon$suffix$size.png"
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $playBrush.Dispose()
  $circleBrush.Dispose()
  $backgroundBrush.Dispose()
  $rounded.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  Write-ExtensionIcon $size $true
  Write-ExtensionIcon $size $false
}
