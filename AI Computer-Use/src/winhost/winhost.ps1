# WinAgent host: persistent JSONL RPC worker for Windows desktop automation.
# Protocol: one JSON object per line on stdin -> one JSON response per line on stdout.
# Request : {"id":"1","method":"screenshot","params":{...}}
# Response: {"id":"1","ok":true,"result":{...}} | {"id":"1","ok":false,"error":{"code":"...","message":"..."}}
#
# Designed for Windows PowerShell 5.1. All coordinates are physical pixels
# (process is Per-Monitor-V2 DPI aware).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$script:Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $script:Root -or -not (Test-Path (Join-Path $script:Root 'src'))) { $script:Root = (Get-Location).Path }
$script:NativeSrc = Join-Path $script:Root 'src\winhost\native.cs'
$script:ScreenshotDir = if ($env:AGENT_SCREENSHOT_DIR) { $env:AGENT_SCREENSHOT_DIR } else { Join-Path $script:Root '.agent\screenshots' }
$script:ErrCode = 'INTERNAL'
$script:SnapshotSeq = 0
$script:Elements = @{}
$script:MaskRects = @()

New-Item -ItemType Directory -Force -Path $script:ScreenshotDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Path $script:NativeSrc
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
[WinAgent.Native]::EnableDpiAwareness() | Out-Null

$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await-WinRt($op, $type) {
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($type)
  $t = $asTask.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

# ---------- helpers ----------
function New-Error([string]$code, [string]$message) {
  $script:ErrCode = $code
  throw $message
}

function Get-P($obj, [string]$name, $default = $null) {
  if ($null -eq $obj) { return $default }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p -or $null -eq $p.Value) { return $default }
  return $p.Value
}

function Get-Scale([IntPtr]$hwnd) {
  try {
    if ($hwnd -ne [IntPtr]::Zero) { return [math]::Round(([WinAgent.Native]::GetDpiForWindow($hwnd) / 96.0), 3) }
  } catch { }
  return 1.0
}

function Get-WindowInfo([IntPtr]$h) {
  $pid_ = 0
  [void][WinAgent.Native]::GetWindowThreadProcessId($h, [ref]$pid_)
  $procName = ''
  try { $procName = (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch { }
  $r = [WinAgent.Native]::WindowRect($h)
  return [ordered]@{
    handle      = $h.ToInt64()
    title       = [WinAgent.Native]::Title($h)
    class       = [WinAgent.Native]::ClassName($h)
    pid         = [int]$pid_
    process     = $procName
    bounds      = [ordered]@{ x = $r[0]; y = $r[1]; width = $r[2]; height = $r[3] }
    minimized   = [WinAgent.Native]::IsIconic($h)
    maximized   = [WinAgent.Native]::IsZoomed($h)
    foreground  = ([WinAgent.Native]::GetForegroundWindow() -eq $h)
    dpi_scale   = (Get-Scale $h)
  }
}

function Get-VirtualScreen {
  $vs = [WinAgent.Native]::VirtualScreen()
  return [ordered]@{ x = $vs[0]; y = $vs[1]; width = $vs[2]; height = $vs[3] }
}

function Get-Screens {
  $list = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $list += [ordered]@{
      device     = $s.DeviceName
      primary    = $s.Primary
      bounds     = [ordered]@{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
      working    = [ordered]@{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
    }
  }
  return ,$list
}

function Compute-AHash([System.Drawing.Bitmap]$bmp) {
  $small = New-Object System.Drawing.Bitmap 8, 8
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
  $g.DrawImage($bmp, 0, 0, 8, 8)
  $vals = New-Object 'double[]' 64
  $sum = 0.0
  for ($y = 0; $y -lt 8; $y++) {
    for ($x = 0; $x -lt 8; $x++) {
      $c = $small.GetPixel($x, $y)
      $v = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      $vals[$y * 8 + $x] = $v
      $sum += $v
    }
  }
  $avg = $sum / 64.0
  $hex = ''
  for ($i = 0; $i -lt 64; $i += 4) {
    $nib = 0
    for ($b = 0; $b -lt 4; $b++) { if ($vals[$i + $b] -ge $avg) { $nib = $nib -bor (1 -shl (3 - $b)) } }
    $hex += ('{0:x}' -f $nib)
  }
  $g.Dispose(); $small.Dispose()
  return $hex
}

function Test-BitmapBlank([System.Drawing.Bitmap]$bmp) {
  $stepX = [Math]::Max(1, [int]($bmp.Width / 16))
  $stepY = [Math]::Max(1, [int]($bmp.Height / 16))
  $min = 255.0
  $max = 0.0
  for ($y = 0; $y -lt $bmp.Height; $y += $stepY) {
    for ($x = 0; $x -lt $bmp.Width; $x += $stepX) {
      $c = $bmp.GetPixel($x, $y)
      $v = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($v -lt $min) { $min = $v }
      if ($v -gt $max) { $max = $v }
    }
  }
  return (($max - $min) -lt 6.0)
}

function Save-Shot([System.Drawing.Bitmap]$bmp, $origin, $target, $extra) {
  $stamp = Get-Date
  $name = 'shot_{0}_{1}.png' -f $stamp.ToString('yyyyMMdd_HHmmss_fff'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
  $path = Join-Path $script:ScreenshotDir $name
  $masked = @()
  if ($script:MaskRects.Count -gt 0) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)
    foreach ($m in $script:MaskRects) {
      $rx = [int]$m.x - [int]$origin.x
      $ry = [int]$m.y - [int]$origin.y
      $g.FillRectangle($brush, $rx, $ry, [int]$m.width, [int]$m.height)
      $masked += $m
    }
    $g.Dispose(); $brush.Dispose()
  }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $sha = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
  $ah = Compute-AHash $bmp
  $c = [System.Windows.Forms.Cursor]::Position
  $r = [ordered]@{
    ref            = $path
    filename       = $name
    sha256         = $sha
    ahash          = $ah
    width          = $bmp.Width
    height         = $bmp.Height
    origin         = [ordered]@{ x = [int]$origin.x; y = [int]$origin.y }
    target         = $target
    captured_at    = $stamp.ToUniversalTime().ToString('o')
    dpi_scale      = (Get-Scale ([WinAgent.Native]::GetForegroundWindow()))
    cursor         = [ordered]@{ x = $c.X; y = $c.Y }
    masked_regions = @($masked)
  }
  foreach ($k in $extra.Keys) { $r[$k] = $extra[$k] }
  return $r
}

function Get-PasswordRects([IntPtr]$hwnd) {
  $rects = @()
  try {
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) { return $rects }
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::IsPasswordProperty, $true)
    $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $found.Count; $i++) {
      $b = $found.Item($i).Current.BoundingRectangle
      if ($b.Width -gt 0 -and $b.Height -gt 0) {
        $rects += [ordered]@{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }
      }
    }
  } catch { }
  return ,$rects
}

function Resolve-TargetWindow($p) {
  $h = [IntPtr](Get-P $p 'window_handle' 0)
  if ($h -ne [IntPtr]::Zero) {
    if (-not [WinAgent.Native]::IsWindow($h)) { New-Error 'WINDOW_NOT_FOUND' "Window handle $($h.ToInt64()) does not exist" }
    return $h
  }
  $fg = [WinAgent.Native]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { New-Error 'WINDOW_NOT_FOUND' 'No foreground window' }
  return $fg
}

function Find-WindowByTitle([string]$title, $pidFilter) {
  foreach ($h in [WinAgent.Native]::TopLevelWindows()) {
    if ($pidFilter) {
      $wpid = 0
      [void][WinAgent.Native]::GetWindowThreadProcessId($h, [ref]$wpid)
      if ([int]$wpid -ne [int]$pidFilter) { continue }
    }
    if ([WinAgent.Native]::Title($h) -like "*$title*") { return $h }
  }
  return [IntPtr]::Zero
}

# ---------- UIA ----------
function Get-ControlTypeName($el) {
  try { return ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { return 'Unknown' }
}

function Get-ElementRect($el) {
  try {
    $b = $el.Current.BoundingRectangle
    if ($b.IsEmpty) { return $null }
    return [ordered]@{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }
  } catch { return $null }
}

function Get-ElementPatterns($el) {
  $names = @()
  $checks = [ordered]@{
    Invoke = [Windows.Automation.InvokePattern]::Pattern
    Value = [Windows.Automation.ValuePattern]::Pattern
    Toggle = [Windows.Automation.TogglePattern]::Pattern
    SelectionItem = [Windows.Automation.SelectionItemPattern]::Pattern
    ExpandCollapse = [Windows.Automation.ExpandCollapsePattern]::Pattern
    Scroll = [Windows.Automation.ScrollPattern]::Pattern
    Text = [Windows.Automation.TextPattern]::Pattern
    RangeValue = [Windows.Automation.RangeValuePattern]::Pattern
  }
  foreach ($k in $checks.Keys) {
    $obj = $null
    try { if ($el.TryGetCurrentPattern($checks[$k], [ref]$obj)) { $names += $k } } catch { }
  }
  return ,$names
}

function New-ElementRecord($el, [IntPtr]$window) {
  $script:ElCounter++
  $id = 's{0}-e{1}' -f $script:SnapshotSeq, $script:ElCounter
  $script:Elements[$id] = @{ Element = $el; Seq = $script:SnapshotSeq; Window = $window.ToInt64() }
  return $id
}

function Get-ElementSummary($el, [IntPtr]$window) {
  $c = $el.Current
  $id = New-ElementRecord $el $window
  return [ordered]@{
    id             = $id
    role           = (Get-ControlTypeName $el)
    name           = $c.Name
    automation_id  = $c.AutomationId
    class          = $c.ClassName
    bounds         = (Get-ElementRect $el)
    enabled        = $c.IsEnabled
    offscreen      = $c.IsOffscreen
    password       = $c.IsPassword
    patterns       = (Get-ElementPatterns $el)
    depth          = 0
    children_count = 0
  }
}

function Get-UiTree($p) {
  $maxDepth = [int](Get-P $p 'depth' 4)
  $maxNodes = [int](Get-P $p 'max_nodes' 400)
  $includeOffscreen = [bool](Get-P $p 'include_offscreen' $false)
  $scope = [string](Get-P $p 'scope' 'active_window')
  $hwnd = [IntPtr]::Zero
  if ($scope -ne 'desktop') { $hwnd = Resolve-TargetWindow $p } else { $hwnd = [WinAgent.Native]::GetForegroundWindow() }
  $root = $null
  if ($scope -eq 'desktop') { $root = [Windows.Automation.AutomationElement]::RootElement }
  else { $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd) }
  if ($null -eq $root) { New-Error 'NOT_FOUND' 'Could not obtain UI Automation root for the requested scope' }

  $script:SnapshotSeq++
  $script:ElCounter = 0
  $script:Elements = @{}
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = New-Object System.Collections.ArrayList
  $truncated = $false
  $stack = New-Object System.Collections.Stack
  $rootSummary = Get-ElementSummary $root $hwnd
  $rootSummary.depth = 0
  [void]$nodes.Add($rootSummary)
  $stack.Push(@($root, 0))

  while ($stack.Count -gt 0) {
    if ($nodes.Count -ge ($maxNodes + 1)) { $truncated = $true; break }
    $item = $stack.Pop()
    $el = $item[0]; $d = [int]$item[1]
    if ($d -ge $maxDepth) { continue }
    $children = @()
    try {
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) { $children += $child; $child = $walker.GetNextSibling($child) }
    } catch { }
    foreach ($child in $children) {
      if ($nodes.Count -ge ($maxNodes + 1)) { $truncated = $true; break }
      $c = $null
      try { $c = $child.Current } catch { continue }
      if (-not $includeOffscreen -and $c.IsOffscreen) { continue }
      $hasIdentity = ($c.Name -ne '') -or ($c.AutomationId -ne '')
      $interesting = $c.ControlType.ProgrammaticName -match 'Button|Edit|CheckBox|RadioButton|ComboBox|ListItem|MenuItem|TabItem|Hyperlink|Slider|Spinner|TreeItem|DataItem|Document|Window|Pane|Text'
      if (-not ($hasIdentity -or $interesting)) { continue }
      $sum = Get-ElementSummary $child $hwnd
      $sum.depth = $d + 1
      [void]$nodes.Add($sum)
      $stack.Push(@($child, ($d + 1)))
    }
  }
  $win = Get-WindowInfo $hwnd
  return [ordered]@{
    window         = $win
    scope          = $scope
    snapshot       = "s$($script:SnapshotSeq)"
    node_count     = $nodes.Count
    truncated      = $truncated
    depth_limit    = $maxDepth
    nodes          = @($nodes)
  }
}

function Get-CachedElement([string]$id) {
  $entry = $script:Elements[$id]
  if ($null -eq $entry) { New-Error 'ELEMENT_STALE' "Element id '$id' is unknown. Take a new snapshot with computer.get_ui_tree or computer.locate_element." }
  if ($entry.Seq -ne $script:SnapshotSeq) { New-Error 'ELEMENT_STALE' "Element id '$id' belongs to snapshot s$($entry.Seq); current snapshot is s$($script:SnapshotSeq). Re-observe before acting." }
  return $entry
}

function Get-LocateResults($p) {
  $hwnd = Resolve-TargetWindow $p
  $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { New-Error 'NOT_FOUND' 'UI Automation root unavailable' }
  $conds = @()
  $name = Get-P $p 'name' $null
  $automationId = Get-P $p 'automation_id' $null
  $role = Get-P $p 'role' $null
  if ($name) { $conds += (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)) }
  if ($automationId) { $conds += (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId)) }
  if ($role) {
    $ctProp = [Windows.Automation.ControlType].GetProperty($role)
    if ($null -eq $ctProp) { New-Error 'INVALID_ARGUMENT' "Unknown UIA role '$role'" }
    $ct = $ctProp.GetValue($null)
    $conds += (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $ct))
  }
  if ($conds.Count -eq 0) { New-Error 'INVALID_ARGUMENT' 'locate_element requires at least one of name, automation_id, or role' }
  $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object Windows.Automation.AndCondition($conds) }
  $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
  $contains = Get-P $p 'name_contains' $null
  $regex = Get-P $p 'regex' $null
  $limit = [int](Get-P $p 'limit' 10)
  $script:SnapshotSeq++
  $script:ElCounter = 0
  $script:Elements = @{}
  $out = @()
  for ($i = 0; $i -lt $found.Count -and $out.Count -lt $limit; $i++) {
    $el = $found.Item($i)
    try { $n = $el.Current.Name } catch { continue }
    if ($contains -and ($n -notlike "*$contains*")) { continue }
    if ($regex -and ($n -notmatch $regex)) { continue }
    $sum = Get-ElementSummary $el $hwnd
    $out += $sum
  }
  return [ordered]@{
    window     = (Get-WindowInfo $hwnd)
    snapshot   = "s$($script:SnapshotSeq)"
    count      = $out.Count
    matches    = @($out)
  }
}

# ---------- Methods ----------
function Invoke-Method([string]$method, $p) {
  switch ($method) {
    'ping' { return [ordered]@{ ready = $true; pid = $PID; host = $env:COMPUTERNAME; ps = $PSVersionTable.PSVersion.ToString() } }

    'screen_info' {
      $vs = Get-VirtualScreen
      $fg = [WinAgent.Native]::GetForegroundWindow()
      $langs = @()
      try { $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) } catch { }
      return [ordered]@{
        virtual_screen   = $vs
        monitors         = Get-Screens
        cursor           = [ordered]@{ x = [System.Windows.Forms.Cursor]::Position.X; y = [System.Windows.Forms.Cursor]::Position.Y }
        foreground       = $(if ($fg -ne [IntPtr]::Zero) { Get-WindowInfo $fg } else { $null })
        dpi_scale        = (Get-Scale $fg)
        ocr_languages    = $langs
        screenshot_dir   = $script:ScreenshotDir
        timestamp        = (Get-Date).ToUniversalTime().ToString('o')
      }
    }

    'screenshot' {
      $target = [string](Get-P $p 'target' 'full')
      $script:MaskRects = @()
      $maskPasswords = [bool](Get-P $p 'mask_password_fields' $true)
      $extra = [ordered]@{ monitors = Get-Screens }

      if ($target -eq 'region') {
        $reg = Get-P $p 'region' $null
        if ($null -eq $reg) { New-Error 'INVALID_ARGUMENT' 'screenshot target=region requires region {x,y,width,height}' }
        $x = [int](Get-P $reg 'x' 0); $y = [int](Get-P $reg 'y' 0)
        $w = [int](Get-P $reg 'width' 0); $h = [int](Get-P $reg 'height' 0)
        if ($w -le 0 -or $h -le 0) { New-Error 'INVALID_ARGUMENT' 'region width/height must be positive' }
        $vs = Get-VirtualScreen
        if ($x -lt $vs.x -or $y -lt $vs.y -or ($x + $w) -gt ($vs.x + $vs.width) -or ($y + $h) -gt ($vs.y + $vs.height)) {
          New-Error 'OUT_OF_BOUNDS' "region ($x,$y,${w}x${h}) is outside the virtual screen"
        }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
        $g.Dispose()
        $res = Save-Shot $bmp ([ordered]@{ x = $x; y = $y }) 'region' $extra
        $bmp.Dispose()
        return $res
      }

      if ($target -eq 'monitor') {
        $idx = [int](Get-P $p 'monitor' 0)
        $screens = [System.Windows.Forms.Screen]::AllScreens
        if ($idx -lt 0 -or $idx -ge $screens.Count) { New-Error 'INVALID_ARGUMENT' "monitor index $idx out of range (0..$($screens.Count - 1))" }
        $b = $screens[$idx].Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $res = Save-Shot $bmp ([ordered]@{ x = $b.X; y = $b.Y }) "monitor:$idx" $extra
        $bmp.Dispose()
        return $res
      }

      if ($target -eq 'active_window' -or $target -eq 'window') {
        $hwnd = Resolve-TargetWindow $p
        $win = Get-WindowInfo $hwnd
        if ($win.bounds.width -le 0 -or $win.bounds.height -le 0) { New-Error 'INVALID_ARGUMENT' 'Target window has no drawable area (minimized?)' }
        if ($maskPasswords) { $script:MaskRects = Get-PasswordRects $hwnd }
        $bmp = New-Object System.Drawing.Bitmap $win.bounds.width, $win.bounds.height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = $false
        try { $ok = [WinAgent.Native]::PrintWindow($hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
        $g.Dispose()
        $method = 'PrintWindow'
        $degraded = $false
        # Composited (UWP/DirectComposition) windows can return success with an
        # entirely black bitmap. A blank capture is useless to the agent, so fall
        # back to screen copy when the window is actually in the foreground.
        $isForeground = ([WinAgent.Native]::GetForegroundWindow() -eq $hwnd)
        if ((-not $ok -or (Test-BitmapBlank $bmp)) -and $isForeground) {
          $bmp.Dispose()
          $bmp = New-Object System.Drawing.Bitmap $win.bounds.width, $win.bounds.height
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($win.bounds.x, $win.bounds.y, 0, 0, $bmp.Size)
          $g.Dispose()
          $method = 'CopyFromScreen'
          $degraded = -not $ok
        } elseif (-not $ok) {
          $method = 'PrintWindowFailed'
          $degraded = $true
        }
        $extra['window'] = $win
        $extra['capture_method'] = $method
        $extra['capture_degraded'] = $degraded
        $res = Save-Shot $bmp ([ordered]@{ x = $win.bounds.x; y = $win.bounds.y }) $target $extra
        $bmp.Dispose()
        return $res
      }

      if ($target -eq 'full') {
        $vs = Get-VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $vs.width, $vs.height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($vs.x, $vs.y, 0, 0, $bmp.Size)
        $g.Dispose()
        $extra['foreground'] = (Get-WindowInfo ([WinAgent.Native]::GetForegroundWindow()))
        $res = Save-Shot $bmp ([ordered]@{ x = $vs.x; y = $vs.y }) 'full' $extra
        $bmp.Dispose()
        return $res
      }
      New-Error 'INVALID_ARGUMENT' "Unknown screenshot target '$target' (use full, active_window, window, region, monitor)"
    }

    'list_windows' {
      $filter = [string](Get-P $p 'filter' '')
      $includeMinimized = [bool](Get-P $p 'include_minimized' $true)
      $out = @()
      foreach ($h in [WinAgent.Native]::TopLevelWindows()) {
        $info = Get-WindowInfo $h
        if (-not $includeMinimized -and $info.minimized) { continue }
        if ($filter -and ($info.title -notlike "*$filter*") -and ($info.process -notlike "*$filter*")) { continue }
        $out += $info
      }
      return [ordered]@{ count = $out.Count; windows = @($out) }
    }

    'active_window' {
      $h = [WinAgent.Native]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { New-Error 'WINDOW_NOT_FOUND' 'No foreground window' }
      return (Get-WindowInfo $h)
    }

    'focus_window' {
      $title = [string](Get-P $p 'title' '')
      $pidFilter = Get-P $p 'pid' $null
      $h = [IntPtr](Get-P $p 'handle' 0)
      if ($h -eq [IntPtr]::Zero) {
        if (-not $title -and -not $pidFilter) { New-Error 'INVALID_ARGUMENT' 'focus_window requires handle, pid, or title' }
        if ($title) { $h = Find-WindowByTitle $title $pidFilter }
        elseif ($pidFilter) { $h = Find-WindowByTitle '' $pidFilter }
      }
      if ($h -eq [IntPtr]::Zero -or -not [WinAgent.Native]::IsWindow($h)) { New-Error 'WINDOW_NOT_FOUND' 'No matching window found' }
      $before = [WinAgent.Native]::GetForegroundWindow()
      $ok = [WinAgent.Native]::Focus($h)
      Start-Sleep -Milliseconds 120
      $after = [WinAgent.Native]::GetForegroundWindow()
      $info = Get-WindowInfo $h
      $info['focus_ok'] = ($after -eq $h)
      $info['previous_foreground'] = $before.ToInt64()
      $info['foreground_after'] = $after.ToInt64()
      return $info
    }

    'close_window' {
      $h = [IntPtr](Get-P $p 'handle' 0)
      if ($h -eq [IntPtr]::Zero) { New-Error 'INVALID_ARGUMENT' 'close_window requires handle' }
      if (-not [WinAgent.Native]::IsWindow($h)) { New-Error 'WINDOW_NOT_FOUND' 'Window does not exist' }
      $force = [bool](Get-P $p 'force' $false)
      if ($force) {
        $wpid = 0
        [void][WinAgent.Native]::GetWindowThreadProcessId($h, [ref]$wpid)
        $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
          try { $proc.CloseMainWindow() | Out-Null } catch { }
        }
      } else {
        [void][WinAgent.Native]::Close($h)
      }
      Start-Sleep -Milliseconds 300
      return [ordered]@{ handle = $h.ToInt64(); still_open = [WinAgent.Native]::IsWindow($h) }
    }

    'ui_tree' { return (Get-UiTree $p) }

    'locate_element' { return (Get-LocateResults $p) }

    'inspect_element' {
      $id = [string](Get-P $p 'element_id' '')
      $entry = Get-CachedElement $id
      $el = $entry.Element
      $c = $el.Current
      $patterns = Get-ElementPatterns $el
      $value = $null
      if ($patterns -contains 'Value') {
        try { $vp = $el.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern); $value = $vp.Current.Value } catch { }
      }
      $toggle = $null
      if ($patterns -contains 'Toggle') {
        try { $tp = $el.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern); $toggle = $tp.Current.ToggleState.ToString() } catch { }
      }
      $sel = $null
      if ($patterns -contains 'SelectionItem') {
        try { $sp = $el.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern); $sel = $sp.Current.IsSelected } catch { }
      }
      return [ordered]@{
        id            = $id
        snapshot      = "s$($entry.Seq)"
        role          = (Get-ControlTypeName $el)
        name          = $c.Name
        automation_id = $c.AutomationId
        class         = $c.ClassName
        bounds        = (Get-ElementRect $el)
        enabled       = $c.IsEnabled
        offscreen     = $c.IsOffscreen
        password      = $c.IsPassword
        focused       = $c.HasKeyboardFocus
        patterns      = $patterns
        value         = $value
        toggle_state  = $toggle
        selected      = $sel
        help_text     = $c.HelpText
        accelerator   = $c.AcceleratorKey
      }
    }

    'element_rect' {
      $id = [string](Get-P $p 'element_id' '')
      $entry = Get-CachedElement $id
      return [ordered]@{ id = $id; bounds = (Get-ElementRect $entry.Element) }
    }

    'invoke_element' {
      $id = [string](Get-P $p 'element_id' '')
      $entry = Get-CachedElement $id
      $el = $entry.Element
      $patterns = Get-ElementPatterns $el
      $method = $null
      if ($patterns -contains 'Invoke') {
        $el.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        $method = 'InvokePattern'
      } elseif ($patterns -contains 'Toggle') {
        $el.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()
        $method = 'TogglePattern'
      } elseif ($patterns -contains 'SelectionItem') {
        $el.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
        $method = 'SelectionItemPattern'
      } elseif ($patterns -contains 'ExpandCollapse') {
        $el.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        $method = 'ExpandCollapsePattern'
      } else {
        $rect = Get-ElementRect $el
        if ($null -eq $rect) { New-Error 'UNSUPPORTED_PATTERN' 'Element supports no action pattern and has no bounding rectangle' }
        $cx = $rect.x + [int]($rect.width / 2); $cy = $rect.y + [int]($rect.height / 2)
        [WinAgent.Native]::MoveAbsolute($cx, $cy)
        Start-Sleep -Milliseconds 40
        [void][WinAgent.Native]::MouseButton('left', $true)
        Start-Sleep -Milliseconds 30
        [void][WinAgent.Native]::MouseButton('left', $false)
        $method = 'mouse_click_fallback'
      }
      Start-Sleep -Milliseconds 120
      return [ordered]@{ element_id = $id; method = $method; invoked = $true }
    }

    'set_element_value' {
      $id = [string](Get-P $p 'element_id' '')
      $text = [string](Get-P $p 'text' '')
      $entry = Get-CachedElement $id
      $el = $entry.Element
      $patterns = Get-ElementPatterns $el
      $method = $null
      if ($patterns -contains 'Value') {
        $vp = $el.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if ($vp.Current.IsReadOnly) { New-Error 'UNSUPPORTED_PATTERN' 'Element value is read-only' }
        $vp.SetValue($text)
        $method = 'ValuePattern'
      } else {
        try { $el.SetFocus() } catch { }
        Start-Sleep -Milliseconds 60
        [void][WinAgent.Native]::Key(0x11, $false) # Ctrl
        [void][WinAgent.Native]::Key(0x41, $false) # A
        [void][WinAgent.Native]::Key(0x41, $true)
        [void][WinAgent.Native]::Key(0x11, $true)
        Start-Sleep -Milliseconds 40
        [void][WinAgent.Native]::TypeUnicode($text)
        $method = 'keyboard_fallback'
      }
      Start-Sleep -Milliseconds 100
      return [ordered]@{ element_id = $id; method = $method; length = $text.Length }
    }

    'move_mouse' {
      $x = [int](Get-P $p 'x' -1); $y = [int](Get-P $p 'y' -1)
      $vs = Get-VirtualScreen
      if ($x -lt $vs.x -or $y -lt $vs.y -or $x -ge ($vs.x + $vs.width) -or $y -ge ($vs.y + $vs.height)) {
        New-Error 'OUT_OF_BOUNDS' "($x,$y) is outside the virtual screen"
      }
      [WinAgent.Native]::MoveAbsolute($x, $y)
      Start-Sleep -Milliseconds 30
      $c = New-Object WinAgent.Native+POINT
      [void][WinAgent.Native]::GetCursorPos([ref]$c)
      return [ordered]@{ requested = @{ x = $x; y = $y }; actual = @{ x = $c.X; y = $c.Y } }
    }

    'click' {
      $x = Get-P $p 'x' $null; $y = Get-P $p 'y' $null
      $button = [string](Get-P $p 'button' 'left')
      $count = [int](Get-P $p 'count' 1)
      if ($null -eq $x -or $null -eq $y) { New-Error 'INVALID_ARGUMENT' 'click requires x and y (use invoke_element for element-based clicks)' }
      $x = [int]$x; $y = [int]$y
      $vs = Get-VirtualScreen
      if ($x -lt $vs.x -or $y -lt $vs.y -or $x -ge ($vs.x + $vs.width) -or $y -ge ($vs.y + $vs.height)) {
        New-Error 'OUT_OF_BOUNDS' "($x,$y) is outside the virtual screen"
      }
      if ($count -lt 1 -or $count -gt 3) { New-Error 'INVALID_ARGUMENT' 'count must be 1..3' }
      [WinAgent.Native]::MoveAbsolute($x, $y)
      Start-Sleep -Milliseconds 40
      for ($i = 0; $i -lt $count; $i++) {
        [void][WinAgent.Native]::MouseButton($button, $true)
        Start-Sleep -Milliseconds 25
        [void][WinAgent.Native]::MouseButton($button, $false)
        if ($i -lt ($count - 1)) { Start-Sleep -Milliseconds 90 }
      }
      return [ordered]@{ x = $x; y = $y; button = $button; count = $count }
    }

    'drag' {
      $from = Get-P $p 'from' $null; $to = Get-P $p 'to' $null
      if ($null -eq $from -or $null -eq $to) { New-Error 'INVALID_ARGUMENT' 'drag requires from {x,y} and to {x,y}' }
      $duration = [int](Get-P $p 'duration_ms' 500)
      $button = [string](Get-P $p 'button' 'left')
      $vs = Get-VirtualScreen
      foreach ($pt in @($from, $to)) {
        $px = [int]$pt.x; $py = [int]$pt.y
        if ($px -lt $vs.x -or $py -lt $vs.y -or $px -ge ($vs.x + $vs.width) -or $py -ge ($vs.y + $vs.height)) {
          New-Error 'OUT_OF_BOUNDS' "($px,$py) is outside the virtual screen"
        }
      }
      [WinAgent.Native]::MoveAbsolute([int]$from.x, [int]$from.y)
      Start-Sleep -Milliseconds 60
      [void][WinAgent.Native]::MouseButton($button, $true)
      $steps = [Math]::Max(4, [Math]::Min(40, [int]($duration / 20)))
      for ($i = 1; $i -le $steps; $i++) {
        $nx = [int]([int]$from.x + (([int]$to.x - [int]$from.x) * $i / $steps))
        $ny = [int]([int]$from.y + (([int]$to.y - [int]$from.y) * $i / $steps))
        [WinAgent.Native]::MoveAbsolute($nx, $ny)
        Start-Sleep -Milliseconds ([Math]::Max(10, [int]($duration / $steps)))
      }
      [void][WinAgent.Native]::MouseButton($button, $false)
      return [ordered]@{ from = $from; to = $to; duration_ms = $duration }
    }

    'scroll' {
      $x = Get-P $p 'x' $null; $y = Get-P $p 'y' $null
      if ($null -ne $x -and $null -ne $y) {
        [WinAgent.Native]::MoveAbsolute([int]$x, [int]$y)
        Start-Sleep -Milliseconds 40
      }
      $direction = [string](Get-P $p 'direction' 'down')
      $clicks = [int](Get-P $p 'clicks' 3)
      if ($clicks -lt 1 -or $clicks -gt 50) { New-Error 'INVALID_ARGUMENT' 'clicks must be 1..50' }
      $delta = 120 * $clicks
      switch ($direction) {
        'up' { [void][WinAgent.Native]::Wheel($delta, $false) }
        'down' { [void][WinAgent.Native]::Wheel(-$delta, $false) }
        'right' { [void][WinAgent.Native]::Wheel($delta, $true) }
        'left' { [void][WinAgent.Native]::Wheel(-$delta, $true) }
        default { New-Error 'INVALID_ARGUMENT' "Unknown scroll direction '$direction'" }
      }
      return [ordered]@{ direction = $direction; clicks = $clicks }
    }

    'type_text' {
      $text = [string](Get-P $p 'text' '')
      $elementId = Get-P $p 'element_id' $null
      if ($elementId) {
        $entry = Get-CachedElement $elementId
        try { $entry.Element.SetFocus() } catch { }
        Start-Sleep -Milliseconds 80
      }
      $chunk = 64
      for ($i = 0; $i -lt $text.Length; $i += $chunk) {
        $part = $text.Substring($i, [Math]::Min($chunk, $text.Length - $i))
        [void][WinAgent.Native]::TypeUnicode($part)
        Start-Sleep -Milliseconds 15
      }
      return [ordered]@{ length = $text.Length; method = 'unicode_sendinput'; element_id = $elementId }
    }

    'press_key' {
      $key = [string](Get-P $p 'key' '')
      $times = [int](Get-P $p 'times' 1)
      if ($times -lt 1 -or $times -gt 50) { New-Error 'INVALID_ARGUMENT' 'times must be 1..50' }
      $vk = Get-Vk $key
      for ($i = 0; $i -lt $times; $i++) {
        [void][WinAgent.Native]::Key($vk, $false)
        Start-Sleep -Milliseconds 30
        [void][WinAgent.Native]::Key($vk, $true)
        Start-Sleep -Milliseconds 30
      }
      return [ordered]@{ key = $key; vk = $vk; times = $times }
    }

    'hotkey' {
      $spec = Get-P $p 'keys' $null
      if ($null -eq $spec) { $spec = Get-P $p 'key' '' }
      if ($spec -is [string]) { $spec = $spec -split '\+' }
      $keys = @($spec | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
      if ($keys.Count -eq 0) { New-Error 'INVALID_ARGUMENT' 'hotkey requires keys' }
      $vks = @($keys | ForEach-Object { Get-Vk $_ })
      foreach ($vk in $vks) { [void][WinAgent.Native]::Key($vk, $false); Start-Sleep -Milliseconds 20 }
      for ($i = $vks.Count - 1; $i -ge 0; $i--) { [void][WinAgent.Native]::Key($vks[$i], $true); Start-Sleep -Milliseconds 20 }
      return [ordered]@{ keys = $keys; vks = $vks }
    }

    'cursor_position' {
      $c = New-Object WinAgent.Native+POINT
      [void][WinAgent.Native]::GetCursorPos([ref]$c)
      $h = [WinAgent.Native]::GetForegroundWindow()
      return [ordered]@{ x = $c.X; y = $c.Y; foreground = (Get-WindowInfo $h) }
    }

    'ocr' {
      $region = Get-P $p 'region' $null
      $ref = Get-P $p 'screenshot_ref' $null
      $lang = [string](Get-P $p 'language' '')
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $tmp = $null
      if (-not $ref) {
        $vs = Get-VirtualScreen
        if ($null -eq $region) { $region = [ordered]@{ x = $vs.x; y = $vs.y; width = $vs.width; height = $vs.height } }
        $w = [int]$region.width; $h = [int]$region.height
        if ($w -le 0 -or $h -le 0) { New-Error 'INVALID_ARGUMENT' 'OCR region must have positive size' }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$region.x, [int]$region.y, 0, 0, $bmp.Size)
        $g.Dispose()
        $tmp = Join-Path $script:ScreenshotDir ('ocr_{0}.png' -f [guid]::NewGuid().ToString('N'))
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $ref = $tmp
      }
      if (-not (Test-Path $ref)) { New-Error 'NOT_FOUND' "Screenshot file not found: $ref" }

      $engine = $null
      if ($lang) {
        try {
          $language = New-Object Windows.Globalization.Language $lang
          $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        } catch { }
      }
      if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
      if ($null -eq $engine) { New-Error 'UNSUPPORTED' 'No Windows OCR engine is available for the requested language' }

      $asTaskGeneric = $script:AsTaskGeneric
      function Await($op, $type) {
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $t = $asTask.Invoke($null, @($op))
        $t.Wait(-1) | Out-Null
        return $t.Result
      }
      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ref)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $ocr.Lines) {
        $words = @()
        $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
        foreach ($w in $line.Words) {
          $r = $w.BoundingRect
          if ($r.X -lt $minX) { $minX = $r.X }
          if ($r.Y -lt $minY) { $minY = $r.Y }
          if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
          if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
          $words += [ordered]@{ text = $w.Text; x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
        }
        $origin = if ($region) { @{ x = [int]$region.x; y = [int]$region.y } } else { @{ x = 0; y = 0 } }
        $lines += [ordered]@{
          text   = $line.Text
          bounds = [ordered]@{
            x      = [int]($minX + $origin.x)
            y      = [int]($minY + $origin.y)
            width  = [int]($maxX - $minX)
            height = [int]($maxY - $minY)
          }
          words  = $words
        }
      }
      $stream.Dispose()
      if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
      return [ordered]@{
        language    = $engine.RecognizerLanguage.LanguageTag
        text        = $ocr.Text
        lines       = @($lines)
        latency_ms  = $sw.ElapsedMilliseconds
        screenshot  = $ref
        region      = $region
      }
    }

    'image_hash' {
      $ref = [string](Get-P $p 'path' '')
      if (-not $ref -or -not (Test-Path $ref)) { New-Error 'NOT_FOUND' "Image not found: $ref" }
      $sha = (Get-FileHash -Path $ref -Algorithm SHA256).Hash.ToLower()
      $bmp = [System.Drawing.Image]::FromFile($ref)
      $ah = Compute-AHash ([System.Drawing.Bitmap]$bmp)
      $w = $bmp.Width; $h = $bmp.Height
      $bmp.Dispose()
      return [ordered]@{ ref = $ref; sha256 = $sha; ahash = $ah; width = $w; height = $h }
    }

    'clipboard_read' {
      $text = ''
      try { $text = [System.Windows.Forms.Clipboard]::GetText() } catch { }
      return [ordered]@{ text = $text; length = $text.Length; format = 'text' }
    }

    'clipboard_write' {
      $text = [string](Get-P $p 'text' '')
      try { [System.Windows.Forms.Clipboard]::SetText($text) } catch { New-Error 'CLIPBOARD' 'Could not write to the Windows clipboard' }
      return [ordered]@{ written = $text.Length }
    }

    'element_text' {
      $id = [string](Get-P $p 'element_id' '')
      $allowClipboard = [bool](Get-P $p 'allow_clipboard' $false)
      $entry = Get-CachedElement $id
      $el = $entry.Element
      $patterns = Get-ElementPatterns $el
      $text = $null; $method = $null
      if ($patterns -contains 'Value') {
        try { $text = $el.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value; $method = 'ValuePattern' } catch { }
      }
      if (($null -eq $text) -and ($patterns -contains 'Text')) {
        try { $text = $el.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1); $method = 'TextPattern' } catch { }
      }
      if (($null -eq $text) -and $allowClipboard) {
        $previous = ''
        try { $previous = [System.Windows.Forms.Clipboard]::GetText() } catch { }
        try { $el.SetFocus() } catch { }
        Start-Sleep -Milliseconds 60
        [void][WinAgent.Native]::Key(0x11, $false); [void][WinAgent.Native]::Key(0x41, $false); [void][WinAgent.Native]::Key(0x41, $true); [void][WinAgent.Native]::Key(0x11, $true)
        Start-Sleep -Milliseconds 60
        [void][WinAgent.Native]::Key(0x11, $false); [void][WinAgent.Native]::Key(0x43, $false); [void][WinAgent.Native]::Key(0x43, $true); [void][WinAgent.Native]::Key(0x11, $true)
        Start-Sleep -Milliseconds 120
        try { $text = [System.Windows.Forms.Clipboard]::GetText(); $method = 'clipboard' } catch { }
        try { if ($previous) { [System.Windows.Forms.Clipboard]::SetText($previous) } } catch { }
      }
      if ($null -eq $text) { $text = $el.Current.Name; $method = 'name' }
      return [ordered]@{ element_id = $id; text = $text; method = $method; patterns = ,$patterns }
    }

    'wait' {
      $ms = [int](Get-P $p 'ms' 250)
      if ($ms -lt 0 -or $ms -gt 60000) { New-Error 'INVALID_ARGUMENT' 'ms must be 0..60000' }
      Start-Sleep -Milliseconds $ms
      return [ordered]@{ waited_ms = $ms }
    }

    default { New-Error 'UNKNOWN_METHOD' "Unknown method '$method'" }
  }
}

# ---------- key mapping ----------
function Get-Vk([string]$key) {
  if (-not $key) { New-Error 'INVALID_ARGUMENT' 'key is required' }
  $k = $key.Trim()
  $map = @{
    'enter' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B; 'space' = 0x20; 'backspace' = 0x08
    'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'ins' = 0x2D; 'home' = 0x24; 'end' = 0x23
    'pageup' = 0x21; 'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'windows' = 0x5B
    'apps' = 0x5D; 'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91; 'printscreen' = 0x2C
    'pause' = 0x13; 'semicolon' = 0xBA; 'equals' = 0xBB; 'comma' = 0xBC; 'minus' = 0xBD
    'period' = 0xBE; 'slash' = 0xBF; 'backtick' = 0xC0; 'lbracket' = 0xDB; 'backslash' = 0xDC
    'rbracket' = 0xDD; 'quote' = 0xDE
  }
  $lower = $k.ToLowerInvariant()
  if ($map.ContainsKey($lower)) { return [int]$map[$lower] }
  if ($lower -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0x6F + [int]$matches[1] }
  if ($k.Length -eq 1) {
    $ch = $k.ToUpperInvariant()[0]
    if ([char]::IsLetterOrDigit($ch)) { return [int][char]$ch }
    $punct = @{ ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF; '`' = 0xC0; '[' = 0xDB; '\' = 0xDC; ']' = 0xDD; "'" = 0xDE; ' ' = 0x20 }
    if ($punct.ContainsKey($k)) { return [int]$punct[$k] }
  }
  New-Error 'INVALID_ARGUMENT' "Unknown key name '$key'"
}

# ---------- main loop ----------
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $reqId = $null
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    $script:ErrCode = 'INTERNAL'
    $result = Invoke-Method ([string]$req.method) $req.params
    $resp = [ordered]@{ id = $reqId; ok = $true; result = $result }
  } catch {
    $resp = [ordered]@{
      id    = $reqId
      ok    = $false
      error = [ordered]@{ code = $script:ErrCode; message = ($_.Exception.Message -replace '\s+', ' ').Trim() }
    }
  }
  try {
    $json = $resp | ConvertTo-Json -Depth 16 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    $fallback = '{"id":' + (ConvertTo-Json $reqId) + ',"ok":false,"error":{"code":"SERIALIZATION","message":"Failed to serialize response"}}'
    [Console]::Out.WriteLine($fallback)
    [Console]::Out.Flush()
  }
}

