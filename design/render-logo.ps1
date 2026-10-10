# agent-sync logo 光栅化：1024 主图 + 多级缩放（GDI+，无外部依赖）
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 背景：碳黑
$g.Clear([System.Drawing.Color]::FromArgb(255, 0x0b, 0x0c, 0x0e))

# 辉光：径向近似（同心圆叠加，琥珀低透明度）
for ($i = 36; $i -ge 1; $i--) {
    $r = $i * 16
    $alpha = [int](1 + 16 * (1 - $i / 36))
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 0xff, 0xb2, 0x24))
    $g.FillEllipse($brush, 320 - $r, 512 - $r, 2 * $r, 2 * $r)
    $brush.Dispose()
}

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$rad) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $rad
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$amber = [System.Drawing.Color]::FromArgb(255, 0xff, 0xb2, 0x24)
$green = [System.Drawing.Color]::FromArgb(255, 0x3d, 0xdc, 0x97)
$cream = [System.Drawing.Color]::FromArgb(255, 0xe9, 0xe4, 0xd8)

# 源节点：圆角方框描边 + 内核
$scale = 2
$pen = New-Object System.Drawing.Pen($amber, 28 * $scale / 2)
$path = New-RoundedRectPath (84 * $scale) (188 * $scale) (136 * $scale) (136 * $scale) (30 * $scale / 2)
$g.DrawPath($pen, $path)
$pen.Dispose(); $path.Dispose()
$brush = New-Object System.Drawing.SolidBrush($amber)
$g.FillEllipse($brush, (128 + 12) * $scale, (232 + 12) * $scale, 24 * $scale, 24 * $scale)
$brush.Dispose()

# 辐射连线（贝塞尔）
$pen2 = New-Object System.Drawing.Pen($amber, 24 * $scale / 2)
$pen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen2.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($pen2, 232 * $scale, 256 * $scale, 296 * $scale, 256 * $scale, 316 * $scale, 128 * $scale, 392 * $scale, 128 * $scale)
$g.DrawBezier($pen2, 232 * $scale, 256 * $scale, 296 * $scale, 256 * $scale, 316 * $scale, 256 * $scale, 392 * $scale, 256 * $scale)
$pen3 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(204, 0xff, 0xb2, 0x24), 24 * $scale / 2)
$pen3.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen3.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($pen3, 232 * $scale, 256 * $scale, 296 * $scale, 256 * $scale, 316 * $scale, 384 * $scale, 392 * $scale, 384 * $scale)
$pen2.Dispose(); $pen3.Dispose()

# 端点
foreach ($dot in @(@($amber, 128), @($green, 256), @($cream, 384))) {
    $b = New-Object System.Drawing.SolidBrush($dot[0])
    $g.FillEllipse($b, (416 - 26) * $scale, ($dot[1] - 26) * $scale, 52 * $scale, 52 * $scale)
    $b.Dispose()
}

$g.Dispose()

# 保存主图 + 多级缩放
$out = 'D:\ai-agent-backup\design'
$bmp.Save("$out\logo-1024.png", [System.Drawing.Imaging.ImageFormat]::Png)
foreach ($s in @(512, 256, 128, 64, 32, 16)) {
    $small = New-Object System.Drawing.Bitmap($s, $s)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g2.DrawImage($bmp, 0, 0, $s, $s)
    $g2.Dispose()
    $small.Save("$out\logo-$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $small.Dispose()
}
$bmp.Dispose()
Write-Host "logo 渲染完成: logo-1024/512/256/128/64/32/16.png"
