# ============================================================================
# 经纬度定位工作站 · 本机桥接（PowerShell 版）
# ----------------------------------------------------------------------------
# 这份文件是 server.py 的等价实现，只用 Windows 自带的 PowerShell 5.1 + .NET：
# 不装 Python 也能让 ⑧ 面板（路由追踪 / ping / DNS / GeoIP 代理）全功能，
# 顺带把整个目录当静态站提供，于是页面走同源 http://127.0.0.1:8765/，
# 连跨域和「私有网络访问」那两道浏览器策略都不用碰。
#
# 与 server.py 的分工：两者提供**同一套 /api 契约**（字段名逐一对齐），
# 页面不知道自己连上的是哪一个，所以哪个在线都行。红线也完全一样：
#   · 只服务回环：绑定参数只接受回环（非回环在启动阶段直接拒绝，不是警告后继续跑），
#     并且逐请求校验 RemoteEndPoint——HttpListener 的前缀按 Host 头分派、http.sys 把端口
#     开在所有网卡上，所以「localhost 前缀」本身不等于「只有本机连得上」，来源地址才是准
#   · 端口已被占用就拒绝再起一个（两个服务并存时请求会被随机分走）
#   · 只读 GET/HEAD/OPTIONS-on-/api；POST/PUT/DELETE 一律 405
#   · 外部输入先过白名单 [A-Za-z0-9._:-] + 结构校验，再以独立参数交给系统命令
#   · 绝不经过 shell：不做「把字符串当命令求值」那类动作，也不启动命令解释器
#   · 拒收一切坐标类参数（lat/lon/accuracy/heading…），隐私红线由结构保证
#   · 内网目标**允许并标注**：响应里的 target_scope 说明这一跳出去了没有
#   · 解析不出跳数就返回 0 跳 + 原因，绝不编造（fabricated_hops 恒为 false）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File bridge-powershell.ps1
#   参数：-Port 8765  -BindHost 127.0.0.1  -Root <静态根>  -Workers 4
#         -AllowOrigin https://内网镜像域名（可重复，跨站读权限白名单）
#         -SelfTest（离线闸门，不联网不起进程） -Quiet（不写日志）
#   关掉这个窗口就是停止桥接。
# ============================================================================

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$BindHost = '127.0.0.1',
    [string]$Root = '',
    [int]$Workers = 4,
    [string[]]$AllowOrigin = @(),
    [switch]$SelfTest,
    [switch]$Quiet,
    # 内部用：工作线程 dot-source 本文件时只取函数定义，不启动服务器
    [switch]$WorkerMode,
    [string]$LogFile = ''
)

# ---------------------------------------------------------------- 0. 常量
$script:Version = '1.0.0'
$script:ServerName = 'geonet-bridge'
$script:RuntimeName = 'PowerShell ' + [string]$PSVersionTable.PSVersion
# 与 server.py 的 sys.platform 对齐的那个字段。这里不能写死 'win32'：这份桥在装了 pwsh 的
# macOS/Linux 上也起得来，写死就等于对着页面谎报平台（tests/bridge-parity.py 会当场比出来）。
$script:PlatformName = if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { 'win32' } else { 'posix' }

$script:MaxHostLen = 253
$script:MaxLabelLen = 63
$script:MaxHopsLimit = 30
$script:MaxPingCount = 10
$script:OutputCapChars = 1000000
$script:WallClockCapS = 180.0
$script:StaticMaxBytes = 67108864   # 64 MiB

# 位置类参数：一律 400。大小写归一后再比，`LON=121` 也拦得住。
$script:PositionParams = @(
    'accuracy', 'alt', 'altitude', 'bearing', 'heading', 'lat', 'latitude',
    'loc', 'lon', 'lng', 'longitude', 'position', 'speed'
)

# 跨站来源白名单（与 server.py 的 CORS_ALLOWED_ORIGINS 同一张名单、同一套判定）。
# 这条边以前是 `Access-Control-Allow-Origin: *`，等于「你浏览器里开着的任何网页都能借这台
# 机器的桥接发包、并把响应读走」。桥接里从来没有你的坐标（位置类参数一律 400），但它能替你
# 跑 tracert/ping，也能被拿来探测本机服务，所以这条边收成一张写死的名单：
#   null                        → file:// 双击打开的页面（浏览器给的是不透明来源）
#   https://iammezsh.github.io  → 官方托管页（跨协议打本机回环，见 MANUAL §2.5）
#   回环 origin                 → 本机自己提供的同源页面（端口跟着页面走，换端口不必改名单）
#   压根没有 Origin 头           → 非浏览器客户端（启动器探测 /api/health、curl），照常放行
# 其余任何来源一律 403 origin_not_allowed。自建域名或内网镜像用 -AllowOrigin 追加
# （server.py 那份桥是 --allow-origin）：名单只能变长，默认值不会变短。
$script:CorsBuiltInOrigins = @('null', 'https://iammezsh.github.io')
$script:CorsExtraOrigins = @()          # 启动时由 -AllowOrigin 追加，运行期不再变化
$script:CorsOriginErrors = @()          # 写法不对的 -AllowOrigin 值；启动段据此 exit 2

# 静态目录里一旦有人误放了凭据，不该被「只是想看 index.html」的服务顺手带出来。
$script:SecretExts = @('.key', '.pem', '.p12', '.pfx', '.jks', '.id_rsa', '.sqlite', '.db', '.env', '.kdbx', '.log')

# 静态资源的 Content-Type 表。值里直接写全（该带 charset 的带上，图片与 svg 不带），
# 发送时不再按前缀临时追加：上一版这里给 image/svg+xml 补了 charset（'xml' 撞上了正则），
# 而 server.py 没补，同一张图在两份桥下的响应头不一样。两份表必须逐键逐值相同，
# 由 tests/check-package.py 对着 server.py 的 TEXT_TYPES 比字面量。
$script:TextTypes = @{
    '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
    '.mjs' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
    '.map' = 'application/json; charset=utf-8'; '.geojson' = 'application/geo+json; charset=utf-8'
    '.svg' = 'image/svg+xml'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
    '.csv' = 'text/csv; charset=utf-8'; '.wkt' = 'text/plain; charset=utf-8'
    '.py' = 'text/plain; charset=utf-8'
    '.gpx' = 'application/gpx+xml'; '.kml' = 'application/vnd.google-earth.kml+xml'
    '.xml' = 'application/xml'; '.ico' = 'image/x-icon'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif'; '.webp' = 'image/webp'
}

# 回环写法：只有这几种允许出现在 -BindHost 里
$script:LoopbackNames = @('127.0.0.1', '::1', 'localhost', '127.0.0.53')

# GeoIP 上游表：与 server.py 的 GEOIP_SOURCES 逐条对齐。
# status_key/lat_keys 这几组字段名是给 Get-NormalizedGeoIp 用的（server.py 的 parse_geoip_json
# 用的是同一套），这样两份实现对同一份上游 JSON 归一出同一个形状，页面拿到哪个都一样。
$script:GeoIpSources = @{
    ipapi_com = @{ name = 'ip-api.com'; self = 'http://ip-api.com/json/?fields=status,message,query,lat,lon,city,country,countryCode'; query = 'http://ip-api.com/json/{ip}?fields=status,message,query,lat,lon,city,country,countryCode'; note = '免费版走明文 HTTP；字段名按公开文档，未逐字段核对'
                   status_key = 'status'; status_ok = 'success'
                   ip_keys = @('query', 'ip'); lat_keys = @('lat', 'latitude'); lon_keys = @('lon', 'longitude')
                   acc_keys = @(); city_keys = @('city'); country_keys = @('country', 'countryName') }
    ipinfo_io = @{ name = 'ipinfo.io'; self = 'https://ipinfo.io/json'; query = 'https://ipinfo.io/{ip}/json'; note = 'loc 是「纬度,经度」的单个逗号字符串；按公开文档，未逐字段核对'
                   ip_keys = @('ip'); lat_keys = @('loc'); lon_keys = @('loc'); split_loc = $true
                   acc_keys = @(); city_keys = @('city'); country_keys = @('country') }
    ipapi_co = @{ name = 'ipapi.co'; self = 'https://ipapi.co/json/'; query = 'https://ipapi.co/{ip}/json/'; note = '精度字段叫 accuracy_radius（公里）；按公开文档，未逐字段核对'
                  ip_keys = @('ip'); lat_keys = @('latitude'); lon_keys = @('longitude')
                  acc_keys = @('accuracy_radius'); city_keys = @('city'); country_keys = @('country_name', 'country_code') }
    ipwho_is = @{ name = 'ipwho.is'; self = 'https://ipwho.is/'; query = 'https://ipwho.is/{ip}'; note = '成功标志字段叫 success；按公开文档，未逐字段核对'
                  status_key = 'success'; status_ok = $true
                  ip_keys = @('ip'); lat_keys = @('latitude'); lon_keys = @('longitude')
                  acc_keys = @(); city_keys = @('city'); country_keys = @('country', 'country_code') }
    freeipapi = @{ name = 'freeipapi.com'; self = 'https://freeipapi.com/api/json'; query = 'https://freeipapi.com/api/json/{ip}'; note = '字段是驼峰；无精度字段；按公开文档，未逐字段核对'
                   ip_keys = @('ipAddress'); lat_keys = @('latitude'); lon_keys = @('longitude')
                   acc_keys = @(); city_keys = @('cityName'); country_keys = @('countryName', 'countryCode') }
}

# 两份桥共同的响应契约（成功响应的键）。server.py 里有一份同名同值的 BRIDGE_CONTRACT，
# tests/check-package.py 逐端点比较两份字面量；本文件的自检再用它核对自己的 health/iface。
$script:BridgeContract = @{
    '/api/health' = @('active_children', 'bind', 'capabilities', 'cors_policy', 'endpoints', 'geoip_sources',
                      'limits', 'note', 'ok', 'platform', 'privacy', 'python', 'runtime',
                      'server', 'status', 'tools', 'version')
    '/api/iface' = @('bind_address', 'bind_check_reason', 'bind_is_loopback', 'error', 'error_kind',
                     'interface_count', 'ipv4_loopback_present', 'note', 'ok', 'port', 'redacted_fields')
    '/api/dns' = @('Answer', 'Status', 'addresses', 'error', 'error_kind', 'family', 'host',
                   'kind', 'note', 'ok')
    '/api/ping' = @('argv', 'command', 'count', 'elapsed_ms', 'error', 'error_kind', 'exit_code',
                    'fabricated_stats', 'host', 'note', 'ok', 'shell', 'stats', 'stderr',
                    'target_ip', 'target_scope', 'target_scope_note', 'timed_out')
    '/api/traceroute' = @('argv', 'command', 'elapsed_ms', 'error', 'error_kind', 'exit_code',
                          'fabricated_hops', 'hop_count', 'hops', 'host', 'host_kind', 'max_hops',
                          'note', 'ok', 'per_hop_timeout_s', 'reached', 'shell', 'stderr',
                          'target_ip', 'target_scope', 'target_scope_note', 'timed_out',
                          'unparsed_lines', 'wall_clock_s')
    '/api/geoip' = @('elapsed_ms', 'error', 'error_kind', 'fields_note', 'http_status',
                     'normalized', 'note', 'ok', 'source', 'upstream', 'url')
}

# ---------------------------------------------------------------- 1. 小工具
function Cut {
    param($Text, [int]$Cap)
    if ($null -eq $Text) { return $null }
    $s = [string]$Text
    if ($s.Length -eq 0) { return $s }
    if ($s.Length -le $Cap) { return $s }
    return $s.Substring(0, $Cap)
}

function One-Line {
    param($Text, [int]$Cap = 200)
    if ($null -eq $Text) { return '' }
    $s = ([string]$Text) -replace '[\r\n\t]+', ' '
    return (Cut $s $Cap)
}

function Parse-Num {
    param([string]$Text)
    # 一律按不变文化解析：中文 Windows 的小数点是「,」，让 1,5 变成 1.5 才是我们要的
    $d = 0.0
    if ([double]::TryParse(($Text -replace ',', '.'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
    return $null
}

function To-Json {
    param($Object)
    # 深度 12：根对象 → hops 数组 → 单跳对象 → rtts 数组，实际用到 4 层，留足余量。
    return (ConvertTo-Json -InputObject $Object -Depth 12 -Compress)
}

function Write-BridgeLog {
    param([string]$Message)
    if ($script:Quiet) { return }
    # 工作线程的 runspace 没有人接收 Write-Host 的信息流，所以只有主线程往控制台打；
    # 日志文件两边都写，否则「谁在跑什么」只能从唯一一个可见的窗口里看。
    try {
        $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + (One-Line $Message 400)
        if ($script:ToConsole) { Write-Host $line }
        if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
    } catch { }
}

# ---------------------------------------------------------------- 2. 输入校验
function Test-LoopbackBind {
    param($Host2)
    # 返回 @{ok=..; reason=..}：非回环绑定直接拒绝启动，不给「先跑起来再说」的机会。
    $h = ("" + $Host2).Trim()
    if ($h.Length -eq 0) { return @{ ok = $false; reason = '绑定地址为空' } }
    if ($script:LoopbackNames -contains $h.ToLowerInvariant()) { return @{ ok = $true; reason = $null } }
    if ($h -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return @{ ok = $true; reason = $null } }
    return @{ ok = $false; reason = ('只允许回环地址（127.x.x.x / ::1 / localhost），收到的是 ' + (Cut $h 64) + '。一个能代跑 tracert/ping 的 HTTP 服务暴露到局域网，等于给同网段任何人开了个命令口子。') }
}

function Test-LegalHost {
    param($Raw)
    # 白名单式主机名校验。为什么不是「黑名单去掉危险字符」：黑名单永远列不全
    # （反引号、$()、换行、NUL、全角同形字…），而合法主机名的字符集是闭集。
    $out = @{ ok = $false; host = $null; kind = $null; reason = $null }
    if ($null -eq $Raw) { $out.reason = '主机名必须是字符串'; return $out }
    $s = ([string]$Raw).Trim()
    if ($s.Length -eq 0) { $out.reason = '主机名为空'; return $out }
    # 注意这里必须是 -gt：PowerShell 的 if ( … ) 括号里 `>` 是「重定向到文件」，
    # `if ($s.Length > 253)` 条件恒为假，还会在当前目录写出一个叫 253 的文件。
    if ($s.Length -gt $script:MaxHostLen) { $out.reason = ('主机名过长（' + $s.Length + ' > ' + $script:MaxHostLen + '）'); return $out }
    if ($s -notmatch '^[A-Za-z0-9._:\-]+$') { $out.reason = '含白名单 [A-Za-z0-9._:-] 之外的字符（空格/引号/分号/反引号/$()/换行等一律拒绝）'; return $out }
    $bad = @()
    foreach ($c in @(' ', "`t", "`r", "`n", [char]11, [char]12, '<', '>', '`', '|', ';', '&', '$', '(', ')', "'", '"', '\')) {
        if ($s.IndexOf($c) -ge 0) { $bad += $c }
    }
    if ($bad.Count -gt 0) { $out.reason = ('含 shell 元字符：' + (($bad | ForEach-Object { "'" + $_ + "'" }) -join ' ')); return $out }
    if ($s.IndexOf([char]0) -ge 0) { $out.reason = '含 NUL 字符'; return $out }
    if ($s.Contains('..')) { $out.reason = '含连续点（非法域名）'; return $out }
    # 首字符 '-' 会被当成命令选项（-h 覆盖跳数、-6 改协议族）；尾部 '-'/'.'/':' 是非法标签或截断写法。
    if ($s.StartsWith('-')) { $out.reason = '以 - 开头（会被当作命令选项注入）'; return $out }
    if ($s.EndsWith('-')) { $out.reason = '以 - 结尾（非法域名标签）'; return $out }
    if ($s.StartsWith('.') -or $s.EndsWith('.')) { $out.reason = '以点开头/结尾（非法域名）'; return $out }
    if ($s.StartsWith(':') -and -not $s.StartsWith('::')) { $out.reason = '单个前导冒号不是合法 IPv6'; return $out }
    if ($s.EndsWith(':')) { $out.reason = '以冒号结尾（截断的 IPv6）'; return $out }

    $m4 = [regex]::Match($s, '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$')
    if ($m4.Success) {
        for ($i = 1; $i -le 4; $i++) {
            $part = $m4.Groups[$i].Value
            if ($part.Length -gt 1 -and $part.StartsWith('0')) {
                $out.kind = 'ipv4'; $out.reason = ('IPv4 段含前导零（' + $part + '），按八进制歧义拒绝'); return $out
            }
            $n = [int]$part
            if ($n -lt 0 -or $n -gt 255) { $out.kind = 'ipv4'; $out.reason = ('IPv4 段越界（' + $part + '）'); return $out }
        }
        return @{ ok = $true; host = $s; kind = 'ipv4'; reason = $null }
    }

    if ($s.Contains(':')) {
        $out.kind = 'ipv6'
        if ($s -notmatch '^[0-9A-Fa-f:.]+$') { $out.reason = 'IPv6 含非十六进制字符'; return $out }
        $first = $s.IndexOf('::'); $last = $s.LastIndexOf('::')
        if ($first -ge 0 -and $first -ne $last) { $out.reason = 'IPv6 压缩符 :: 出现多次'; return $out }
        if ($s.Contains(':::')) { $out.reason = 'IPv6 出现连续三个及以上冒号'; return $out }
        $groups = @($s.Replace('::', ':').Split(':') | Where-Object { $_ -ne '' })
        foreach ($g in $groups) {
            $head = ($g.Split('.'))[0]
            $isV4g = [regex]::IsMatch($g, '^\d{1,3}(\.\d{1,3}){3}$')
            if (($head -notmatch '^[0-9A-Fa-f]+$') -and (-not $isV4g)) { $out.reason = ('IPv6 分组含非法字符（' + $g + '）'); return $out }
            if ($head.Length -gt 4 -and (-not $isV4g)) { $out.reason = ('IPv6 分组超长（' + $g + '）'); return $out }
        }
        if ($groups.Count -gt 8) { $out.reason = 'IPv6 分组超过 8 段'; return $out }
        if ($s.Contains('.') -and -not [regex]::IsMatch(($s.Split(':'))[-1], '^\d{1,3}(\.\d{1,3}){3}$')) { $out.reason = 'IPv6 内嵌 IPv4 部分非法'; return $out }
        return @{ ok = $true; host = $s; kind = 'ipv6'; reason = $null }
    }

    $out.kind = 'domain'
    foreach ($lab in $s.Split('.')) {
        if ($lab -notmatch '^[A-Za-z0-9\-]+$') { $out.reason = ('域名标签含非法字符（' + $lab + '）'); return $out }
        if ($lab.Length -gt $script:MaxLabelLen) { $out.reason = ('域名标签超过 ' + $script:MaxLabelLen + ' 字符'); return $out }
        if ($lab.StartsWith('-') -or $lab.EndsWith('-')) { $out.reason = ('标签以连字符开头/结尾（' + $lab + '）'); return $out }
    }
    if ($s -notmatch '[A-Za-z0-9]') { $out.reason = '域名无字母数字'; return $out }
    $tail = ($s.Split('.'))[-1]
    if ($tail -match '^\d+$') { $out.reason = '末段为纯数字（疑似写错的 IPv4 字面量），拒绝'; return $out }
    return @{ ok = $true; host = $s; kind = 'domain'; reason = $null }
}

function Get-PositionParamHits {
    param($Names)
    # 统一转小写：HTTP 参数名大小写敏感，但 LON=121 显然也该拦——按语义拦而不是按字面拦。
    $hits = New-Object System.Collections.Generic.HashSet[string]
    foreach ($n in $Names) {
        if ($null -eq $n) { continue }
        $k = ([string]$n).Trim().ToLowerInvariant()
        if ($script:PositionParams -contains $k) { [void]$hits.Add($k) }
    }
    $arr = @($hits); [Array]::Sort($arr)
    return ,$arr
}

function Convert-SafeInt {
    param($Raw, [int]$Default, [int]$Low, [int]$High)
    # 非数字一律回到默认值，绝不抛异常；然后夹到 [Low, High]。
    $n = 0
    $s = ("" + $Raw).Trim()
    if (-not [int]::TryParse($s, [ref]$n)) { $n = $Default }
    if ($n -lt $Low) { $n = $Low }
    if ($n -gt $High) { $n = $High }
    return $n
}

# ---------------------------------------------------------------- 3. 目标归属（只标注，不拦截）
function Test-PrivateTarget {
    param($Value)
    # 这个函数**只用于标注**，不用于拦截：追踪自家路由器 192.168.1.1 正是 ⑧ 的本职。
    $s = ("" + $Value).Trim()
    $r = @{ private = $false; reason = $null }
    if ($s.Length -eq 0) { return $r }
    $m4 = [regex]::Match($s, '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$')
    if ($m4.Success) {
        $a = @([int]$m4.Groups[1].Value, [int]$m4.Groups[2].Value, [int]$m4.Groups[3].Value, [int]$m4.Groups[4].Value)
        $o0 = $a[0]; $o1 = $a[1]
        if ($o0 -eq 127) { $r.private = $true; $r.reason = ('回环地址 ' + $s) }
        elseif ($o0 -eq 10) { $r.private = $true; $r.reason = ('私有网段 10/8：' + $s) }
        elseif ($o0 -eq 192 -and $o1 -eq 168) { $r.private = $true; $r.reason = ('私有网段 192.168/16：' + $s) }
        elseif ($o0 -eq 172 -and $o1 -ge 16 -and $o1 -le 31) { $r.private = $true; $r.reason = ('私有网段 172.16/12：' + $s) }
        elseif ($o0 -eq 169 -and $o1 -eq 254) { $r.private = $true; $r.reason = ('链路本地（无 DHCP 时的自寻地址）：' + $s) }
        elseif ($o0 -eq 0) { $r.private = $true; $r.reason = ('「本网络」地址 0/8，Windows 上等于本机：' + $s) }
        elseif ($o0 -eq 100 -and $o1 -ge 64 -and $o1 -le 127) { $r.private = $true; $r.reason = ('运营商级 NAT（CGNAT，RFC 6598）：' + $s) }
        elseif ($o0 -eq 198 -and ($o1 -eq 18 -or $o1 -eq 19)) { $r.private = $true; $r.reason = ('基准测试段 198.18/15：' + $s) }
        elseif ($o0 -eq 192 -and $o1 -eq 0 -and $a[2] -eq 0) { $r.private = $true; $r.reason = ('协议保留段 192.0.0/24：' + $s) }
        elseif ($o0 -eq 192 -and $o1 -eq 0 -and $a[2] -eq 2) { $r.private = $true; $r.reason = ('文档示例段 TEST-NET-1：' + $s) }
        elseif ($o0 -eq 198 -and $o1 -eq 51 -and $a[2] -eq 100) { $r.private = $true; $r.reason = ('文档示例段 TEST-NET-2：' + $s) }
        elseif ($o0 -eq 203 -and $o1 -eq 0 -and $a[2] -eq 113) { $r.private = $true; $r.reason = ('文档示例段 TEST-NET-3：' + $s) }
        elseif ($o0 -ge 224 -and $o0 -le 239) { $r.private = $true; $r.reason = ('组播段：' + $s) }
        elseif ($o0 -ge 240) { $r.private = $true; $r.reason = ('保留/未来使用段：' + $s) }
        return $r
    }
    if ($s.Contains(':')) {
        $low = $s.ToLowerInvariant()
        if ($low -eq '::1' -or $low -eq '::') { $r.private = $true; $r.reason = ('IPv6 回环/未指定：' + $s) }
        elseif ($low.StartsWith('fe80')) { $r.private = $true; $r.reason = ('IPv6 链路本地：' + $s) }
        elseif ($low.StartsWith('fc') -or $low.StartsWith('fd')) { $r.private = $true; $r.reason = ('IPv6 唯一本地地址（ULA）：' + $s) }
        elseif ($low.StartsWith('ff')) { $r.private = $true; $r.reason = ('IPv6 组播：' + $s) }
        return $r
    }
    return $r   # 域名：由解析结果再判一次（见 Get-TargetScope）
}

function Get-TargetScope {
    param([string]$HostName2, $Resolved)
    # 返回 scope = 'lan' / 'public'。**只标注，不拦截。**
    $p = Test-PrivateTarget $HostName2
    if ($p.private) { return @{ scope = 'lan'; note = $p.reason } }
    foreach ($addr in @($Resolved)) {
        if ($null -eq $addr -or $addr.ToString().Length -eq 0) { continue }
        $p2 = Test-PrivateTarget $addr
        if ($p2.private) { return @{ scope = 'lan'; note = ('域名 ' + $HostName2 + ' 解析到内网地址：' + $p2.reason) } }
    }
    return @{ scope = 'public'; note = $null }
}

# ---------------------------------------------------------------- 4. 系统命令（argv 拼接，永不经 shell）
function Get-ToolPath {
    param([string]$Kind)
    # 只认 Windows 自带的那两个；找不到就返回 $null，让上层如实报「命令缺失」而不是编结果。
    $names = @{ traceroute = @('tracert.exe', 'tracert'); ping = @('ping.exe', 'ping') }
    $list = $names[$Kind]
    if ($null -eq $list) { return $null }
    foreach ($n in $list) {
        $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c -and $c.Source) { return $c.Source }
    }
    # PATH 被改坏时的兜底：System32 里这两个文件在每台 Windows 上都存在
    $sys = Join-Path $env:SystemRoot 'System32'
    if ($Kind -eq 'traceroute') { $f = Join-Path $sys 'tracert.exe' } else { $f = Join-Path $sys 'ping.exe' }
    if (Test-Path -LiteralPath $f) { return $f }
    return $null
}

function Clamp-TraceBudget {
    param([int]$Hops, [int]$TimeoutS)
    # 夹取规则只写这一处：实际执行的参数串和响应里的 argv 都从这里取值，不会出现两份各夹各的。
    $h = $Hops; if ($h -lt 1) { $h = 1 }; if ($h -gt $script:MaxHopsLimit) { $h = $script:MaxHopsLimit }
    $w = $TimeoutS; if ($w -lt 1) { $w = 1 }; if ($w -gt 30) { $w = 30 }
    return @{ h = $h; w = $w }
}

function Clamp-PingBudget {
    param([int]$Count, [int]$TimeoutS)
    $n = $Count; if ($n -lt 1) { $n = 1 }; if ($n -gt $script:MaxPingCount) { $n = $script:MaxPingCount }
    $w = $TimeoutS; if ($w -lt 1) { $w = 1 }; if ($w -gt 30) { $w = 30 }
    return @{ n = $n; w = $w }
}

function Build-TracerouteArgs {
    param([string]$HostPart, [int]$Hops, [int]$TimeoutS)
    # 参数串在这里成形，host 永远是最后一段且不含任何空白（Test-LegalHost 已保证）。
    # 为什么不用 ProcessStartInfo.ArgumentList：本机 PowerShell 5.1 / .NET 4.x 上没有这个属性，
    # 拼引号是唯一的替代路径——能安全地这么干，前提是输入已经过白名单校验。
    # -d 禁止把 IP 反解成主机名（反解会把「查 DNS」混进本服务，慢且多一步隐私外发）
    # -h 最大跳数；-w 每跳等待（毫秒）
    $c = Clamp-TraceBudget $Hops $TimeoutS
    return ('-d -h ' + $c.h + ' -w ' + ($c.w * 1000) + ' ' + ('"' + $HostPart + '"'))
}

function Build-TracerouteArgv {
    param([string]$Exe, [string]$HostPart, [int]$Hops, [int]$TimeoutS)
    # 响应里的 argv 是**数组**，与 server.py 的同一个字段同名同形（元素顺序 = 实际执行顺序，host 在最后）。
    # 页面与自检都按数组读，所以两份桥的响应可以逐字段对齐，不需要看连上的哪一个。
    $c = Clamp-TraceBudget $Hops $TimeoutS
    return @($Exe, '-d', '-h', ('' + $c.h), '-w', ('' + ($c.w * 1000)), $HostPart)
}

function Build-PingArgs {
    param([string]$HostPart, [int]$Count, [int]$TimeoutS)
    $c = Clamp-PingBudget $Count $TimeoutS
    return ('-n ' + $c.n + ' -w ' + ($c.w * 1000) + ' -l 32 ' + ('"' + $HostPart + '"'))
}

function Build-PingArgv {
    param([string]$Exe, [string]$HostPart, [int]$Count, [int]$TimeoutS)
    $c = Clamp-PingBudget $Count $TimeoutS
    return @($Exe, '-n', ('' + $c.n), '-w', ('' + ($c.w * 1000)), '-l', '32', $HostPart)
}

function Start-CapturedProcess {
    param([string]$Exe, [string]$Arguments, [int]$WallMs)
    # 用 .NET Process + UseShellExecute=false：命令解释器从头到尾没有被启动的机会。
    $res = @{ ok = $false; stdout = ''; stderr = ''; code = $null; timed_out = $false; elapsed_ms = $null; error = $null; error_kind = $null }
    $started = Get-Date
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        $psi.Arguments = $Arguments
        $psi.UseShellExecute = $false     # 不设这一项就无法重定向输出，也就无法绕开 shell
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        # 不强制 UTF-8：中文系统的控制台代码页是 cp936，tracert 的「请求超时。」正是写在那套编码里。
        # .NET 默认按 [Console]::OutputEncoding 解码重定向流，这里刻意沿用默认值。
        $p = [System.Diagnostics.Process]::Start($psi)
        try {
            $outTask = $p.StandardOutput.ReadToEndAsync()
            $errTask = $p.StandardError.ReadToEndAsync()
            $exited = $p.WaitForExit($WallMs)
            if (-not $exited) {
                $res.timed_out = $true
                try { $p.Kill() } catch { }
                try { $p.WaitForExit() } catch { }
            }
            $res.stdout = Cut $outTask.Result $script:OutputCapChars
            $res.stderr = Cut $errTask.Result $script:OutputCapChars
            try { $res.code = $p.ExitCode } catch { $res.code = $null }
            $res.ok = (-not $res.timed_out)
            if ($res.timed_out) {
                $res.error = ('命令 ' + (Split-Path -Leaf $Exe) + ' 超过 ' + [math]::Round($WallMs / 1000.0, 1) + ' 秒墙钟上限，已终止（已拿到的部分输出仍会解析）')
                $res.error_kind = 'timeout'
            }
        } finally {
            foreach ($d in @($p.StandardOutput, $p.StandardError, $p)) { if ($d) { try { $d.Dispose() } catch { } } }
        }
    } catch [System.ComponentModel.Win32Exception] {
        $res.error = ('无法启动 ' + (Split-Path -Leaf $Exe) + '：' + $_.Exception.Message)
        $res.error_kind = 'os_error'
    } catch {
        $res.error = ('执行外部命令时异常（已捕获，服务继续运行）：' + $_.Exception.Message)
        $res.error_kind = 'os_error'
    }
    $res.elapsed_ms = [math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
    return $res
}

# ---------------------------------------------------------------- 5. 文本解析（结构优先于措辞）
$script:HopLeadRe = [regex]'^\s*(\d{1,3})\s+(.*)$'
$script:MsRe = [regex]'(?i)(<)?(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)'
$script:V4FindRe = [regex]'\b\d{1,3}(?:\.\d{1,3}){3}\b'
$script:V6FindRe = [regex]'(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}'
$script:BracketedIpRe = [regex]'[\[(]\s*(\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}|::1)\s*[\])]'
$script:TimeoutHints = @('超时', 'timed out', 'request timed out', '无响应', '* * *')
$script:ErrorHints = @('无法访问', '找不到', 'Request could not find', 'cannot resolve', 'Unknown host', '没有与这些网络')

function Convert-TracerouteText {
    param([string]$Text)
    # 只认「结构」：行首是跳号 + 行内含 IP 与 N 个 ms。各系统/语言的提示语不同
    # （中文「请求超时。」、英文 "Request timed out."、BSD 的 * * *），结构是共通的。
    # 解析不出来的行原样进 unparsed 供人核对，不做二次加工，更不补跳数。
    $hops = New-Object System.Collections.ArrayList
    $unparsed = New-Object System.Collections.ArrayList
    $targetIp = $null
    if ($null -eq $Text) { $Text = '' }
    foreach ($line in ($Text -split '\r?\n')) {
        $raw = $line.TrimEnd([char]13)
        if ($raw.Trim().Length -eq 0) { continue }
        if ($null -eq $targetIp) {
            $mh = $script:BracketedIpRe.Match($raw)
            if ($mh.Success -and -not $script:HopLeadRe.IsMatch($raw)) { $targetIp = $mh.Groups[1].Value; continue }
        }
        $m = $script:HopLeadRe.Match($raw)
        if (-not $m.Success) {
            foreach ($k in $script:ErrorHints) {
                if ($raw.Contains($k)) { [void]$unparsed.Add((Cut $raw.Trim() 200)); break }
            }
            continue
        }
        $hopNo = [int]$m.Groups[1].Value
        $rest = $m.Groups[2].Value
        $v4 = @($script:V4FindRe.Matches($rest) | ForEach-Object { $_.Value })
        $v6 = @($script:V6FindRe.Matches($rest) | ForEach-Object { $_.Value } | Where-Object { $v4 -notcontains $_ })
        $ips = @($v4) + @($v6)
        $times = New-Object System.Collections.ArrayList
        $bounds = New-Object System.Collections.ArrayList
        foreach ($mm in $script:MsRe.Matches($rest)) {
            $val = Parse-Num $mm.Groups[2].Value
            if ($null -eq $val) { continue }
            if ($mm.Groups[1].Success) {
                # 「<1 毫秒」是上界而不是测量值：取中点或写 0 都是编数，所以原样留在 rtt_bounds。
                [void]$bounds.Add('<' + $val.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture))
            } else {
                [void]$times.Add([math]::Round($val, 3))
            }
        }
        $starCount = ([regex]::Matches($rest, '\*')).Count
        $low = $rest.ToLowerInvariant()
        $timedOut = ($times.Count -eq 0 -and $bounds.Count -eq 0 -and $ips.Count -eq 0)
        if (-not $timedOut) {
            foreach ($h in $script:TimeoutHints) { if ($low.Contains($h)) { $timedOut = $true; break } }
        }
        $residue = $rest
        foreach ($a in $ips) { $residue = [regex]::Replace($residue, [regex]::Escape($a), ' ', 1) }
        $residue = $script:MsRe.Replace($residue, ' ')
        $residue = $residue.Replace('*', ' ')
        $words = @()
        foreach ($w in ($residue -split '[\s,]+')) {
            if ($w -and $w -match '^[A-Za-z0-9._\-]+$' -and $w -notmatch '^\d+$') { $words += $w }
        }
        $hostname = $null
        if ($words.Count -gt 0) { $hostname = Cut $words[0] 128 }
        $status = 'unknown'
        if ($timedOut) { $status = 'timeout' }
        elseif ($times.Count -gt 0 -or $bounds.Count -gt 0 -or $ips.Count -gt 0) { $status = 'ok' }
        [void]$hops.Add(@{
            hop = $hopNo
            ip = $(if ($ips.Count -gt 0) { $ips[0] } else { $null })
            hostname = $hostname
            rtts_ms = @($times)
            rtt_bounds = @($bounds)
            star_count = $starCount
            timed_out = [bool]$timedOut
            status = $status
            alt_ips = @($ips | Select-Object -Skip 1)
            raw = (Cut $raw.Trim() 240)
        })
    }
    $sorted = @($hops | Sort-Object { $_['hop'] })
    $up = @($unparsed | Select-Object -First 12)
    return @{ hops = $sorted; target_ip = $targetIp; unparsed = $up }
}

function Convert-PingText {
    param([string]$Text)
    # 中英文标签都试；取不到就是 $null（不猜 0）。
    $out = @{ target_ip = $null; sent = $null; received = $null; lost = $null; loss_percent = $null; min_ms = $null; avg_ms = $null; max_ms = $null; mdev_ms = $null; samples_ms = @() }
    if ($null -eq $Text) { $Text = '' }
    $mt = $script:BracketedIpRe.Match($Text)
    if ($mt.Success) { $out.target_ip = $mt.Groups[1].Value }
    $out.samples_ms = @([regex]::Matches($Text, '(?i)(?:时间|time)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms') | ForEach-Object { Parse-Num $_.Groups[1].Value } | Where-Object { $null -ne $_ })
    # Linux(iputils) 写 `2 packets transmitted, 0 received`，macOS/BSD 写 `0 packets received`：
    # packets 这个量词在一行里可能出现也可能不出现，所以两侧都做成可选。
    $ms = [regex]::Match($Text, '(?i)(?:已发送|发送|Sent)\s*[=:]\s*(\d+)|(\d+)\s+packets?\s+transmitted')
    if ($ms.Success) { $out.sent = [int](($(if ($ms.Groups[1].Success) { $ms.Groups[1].Value } else { $ms.Groups[2].Value }))) }
    $mr = [regex]::Match($Text, '(?i)(?:已接收|接收|Received)\s*[=:]\s*(\d+)|(\d+)\s+(?:packets\s+)?received')
    if ($mr.Success) { $out.received = [int](($(if ($mr.Groups[1].Success) { $mr.Groups[1].Value } else { $mr.Groups[2].Value }))) }
    $ml = [regex]::Match($Text, '(?i)(?:丢失|Lost)\s*[=:]\s*(\d+)|(\d+)\s+(?:packets\s+)?lost')
    if ($ml.Success) { $out.lost = [int](($(if ($ml.Groups[1].Success) { $ml.Groups[1].Value } else { $ml.Groups[2].Value }))) }
    # 丢包率写法差别最大：`50% 丢失` / `0% loss` / `0% packet loss` —— % 与关键词之间允许几个词。
    $mp = [regex]::Match($Text, '(?i)(\d+(?:[.,]\d+)?)\s*%[^\r\n]{0,14}?(?:丢失|loss)')
    if ($mp.Success) { $out.loss_percent = Parse-Num $mp.Groups[1].Value }
    $trip = [regex]::Match($Text, '(?is)(?:最短|Minimum)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms.*?(?:最长|Maximum)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms.*?(?:平均|Average)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms')
    if ($trip.Success) {
        $out.min_ms = Parse-Num $trip.Groups[1].Value
        $out.max_ms = Parse-Num $trip.Groups[2].Value
        $out.avg_ms = Parse-Num $trip.Groups[3].Value
    }
    $rtt = [regex]::Match($Text, '(?i)(?:rtt|round-trip)[^=\r\n]*=\s*([\d.]+)/([\d.]+)/([\d.]+)(?:/([\d.]+))?')
    if ($rtt.Success) {
        $out.min_ms = Parse-Num $rtt.Groups[1].Value
        $out.avg_ms = Parse-Num $rtt.Groups[2].Value
        $out.max_ms = Parse-Num $rtt.Groups[3].Value
        if ($rtt.Groups[4].Success) { $out.mdev_ms = Parse-Num $rtt.Groups[4].Value }
    }
    # 样本兜底：统计段缺失时用单条回复算（这是真实测得值，不是推测值）
    if ($null -eq $out.avg_ms -and $out.samples_ms.Count -gt 0) {
        $v = @($out.samples_ms)
        $out.min_ms = ($v | Measure-Object -Minimum).Minimum
        $out.max_ms = ($v | Measure-Object -Maximum).Maximum
        $out.avg_ms = [math]::Round((($v | Measure-Object -Sum).Sum) / $v.Count, 3)
    }
    return $out
}

# ---------------------------------------------------------------- 6. DNS / 网卡
function Resolve-HostName {
    param([string]$HostName2, [int]$TimeoutMs = 5000)
    # .NET Framework 没有带超时的同步解析，所以用 Begin/End + 等待句柄；
    # 超时后不追杀后台解析（它自己会结束），如实报 dns_timeout。
    $res = @{ ok = $false; host = $HostName2; addresses = @(); family = $null; error = $null; error_kind = $null }
    try {
        $iar = [System.Net.Dns]::BeginGetHostAddresses($HostName2, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $addrs = [System.Net.Dns]::EndGetHostAddresses($iar)
            $list = @($addrs | ForEach-Object { $_.ToString() })
            $res.addresses = $list
            $res.ok = ($list.Count -gt 0)
            if ($list.Count -gt 0) { $res.family = $(if ($list[0].Contains(':')) { 'ipv6' } else { 'ipv4' }) }
            if (-not $res.ok) { $res.error = '解析成功但一个地址也没有返回'; $res.error_kind = 'dns_error' }
        } else {
            $res.error = ('名字解析超过 ' + [math]::Round($TimeoutMs / 1000.0, 1) + ' 秒（该调用不可中断，已放弃等待）')
            $res.error_kind = 'dns_error'
        }
    } catch {
        $res.error = ('名字解析失败：' + $_.Exception.Message)
        $res.error_kind = 'dns_error'
    }
    return $res
}

function Get-IfaceSummary {
    # 与 server.py iface_summary() 同形，而且必须继续保持「脱敏」：
    # /api/* 对来源白名单（file://、回环、官方托管页）开放（包括用户从 file:// 打开的那份 HTML），
    # 网卡名、内网地址、主机名凑在一起就够做设备指纹和内网测绘了。
    # 第一版这里把名字和地址全列出来了，属于把隐私红线写反——现在只回两件事：
    # 接口数量，以及「绑定是不是只在回环上」。
    $out = @{
        ok = $true
        bind_address = $script:BindHost; port = $script:Port
        bind_is_loopback = $false; bind_check_reason = $null
        interface_count = 0; ipv4_loopback_present = $false
        redacted_fields = @('hostname', 'mac', 'interface_names', 'lan_addresses')
        note = '本端点刻意不返回主机名/MAC/内网地址：/api/* 对来源白名单（file://、回环、官方托管页）开放，' +
               '这些信息足以做设备指纹。需要排查本机网络请用系统命令。'
    }
    $bind = Test-LoopbackBind $script:BindHost
    $out.bind_is_loopback = [bool]$bind.ok
    # 检查通过时给 null（与 server.py 一致），失败时给原因：页面只在失败时才需要这句话。
    $out.bind_check_reason = $(if ($bind.ok) { $null } else { $bind.reason })
    try {
        $nis = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces())
        $out.interface_count = $nis.Count
        foreach ($ni in $nis) {
            if ([string]$ni.NetworkInterfaceType -eq 'Loopback') {
                try {
                    foreach ($ua in $ni.GetIPProperties().UnicastAddresses) {
                        if ($ua.Address.ToString().StartsWith('127.')) { $out.ipv4_loopback_present = $true; break }
                    }
                } catch { }
            }
            if ($out.ipv4_loopback_present) { break }
        }
    } catch {
        $out.ok = $false; $out.error = ('枚举网卡失败：' + $_.Exception.Message); $out.error_kind = 'os_error'
    }
    return $out
}

# ---------------------------------------------------------------- 7. GeoIP 上游
function Test-SafeUpstreamUrl {
    param([string]$Url, [bool]$RequirePlaceholder = $true)
    # 如果允许调用方任意指定上游，这些地址就成了内网探测的入口——所以先判协议、再判主机段。
    $r = @{ ok = $false; reason = $null }
    if ([string]::IsNullOrWhiteSpace($Url)) { $r.reason = 'URL 为空'; return $r }
    if ($RequirePlaceholder -and -not $Url.Contains('{ip}')) { $r.reason = '自定义上游 URL 必须包含 {ip} 占位符（否则会把固定 IP 变成任意代理）'; return $r }
    $u = $null
    if (-not [System.Uri]::TryCreate(($Url -replace '\{ip\}', '198.51.100.1'), [System.UriKind]::Absolute, [ref]$u)) { $r.reason = 'URL 无法解析'; return $r }
    if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { $r.reason = ('只允许 http/https，收到 ' + $u.Scheme); return $r }
    $h = $u.Host
    if ([string]::IsNullOrWhiteSpace($h)) { $r.reason = 'URL 没有主机名'; return $r }
    $p = Test-PrivateTarget $h
    if ($p.private) { $r.reason = ('上游主机是回环/内网/保留地址：' + $p.reason); return $r }
    if ($h -match '^[0-9]+$' -or $h.Contains('%')) { $r.reason = '上游主机名形式异常'; return $r }
    return @{ ok = $true; reason = $null }
}

function New-GeoIpUrl {
    param([string]$Source, [string]$Ip, [string]$Custom)
    # 上游 URL 只来自内置源表 —— 这条限制让桥接不能被当成 SSRF 中继。
    $r = @{ url = $null; reason = $null; source = $Source }
    $src = $script:GeoIpSources[$Source]
    if ($null -eq $src) { $r.reason = ('未知来源 ' + (Cut $Source 40) + '（可用：' + (($script:GeoIpSources.Keys | Sort-Object) -join ', ') + '）'); return $r }
    $ip = ("" + $Ip).Trim()
    if ($Custom) {
        $t = Test-SafeUpstreamUrl -Url $Custom -RequirePlaceholder $true
        if (-not $t.ok) { $r.reason = ('自定义上游被拒绝：' + $t.reason); return $r }
        $u = $Custom
    } elseif ($ip.Length -gt 0) {
        $vh = Test-LegalHost $ip
        if (-not $vh.ok -or $vh.kind -eq 'domain') { $r.reason = ('ip 参数必须是 IP 字面量：' + $(if ($vh.reason) { $vh.reason } else { '这不是 IP，是域名'})); return $r }
        $u = $src.query
    } else {
        $u = $src.self
    }
    if ($ip.Length -gt 0) { $u = $u.Replace('{ip}', $ip) } else { $u = $u.Replace('{ip}', '') }
    $t2 = Test-SafeUpstreamUrl -Url $u -RequirePlaceholder $false
    if (-not $t2.ok) { $r.reason = ('最终 URL 未通过安全检查：' + $t2.reason); return $r }
    return @{ url = $u; reason = $null; source = $Source }
}

function Invoke-JsonFetch {
    param([string]$Url, [int]$TimeoutMs = 8000)
    # .NET 4.x 默认不启用 TLS 1.2，ipinfo/ipapi 只给 https —— 这里显式打开（不动系统设置）。
    $out = @{ ok = $false; status = $null; data = $null; text = $null; elapsed_ms = $null; error = $null; error_kind = $null }
    $started = Get-Date
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = `
            ([System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls11 -bor [System.Net.SecurityProtocolType]::Tls)
    } catch { }
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.UserAgent = ($script:ServerName + '/' + $script:Version + ' (local bridge; PowerShell)')
        $req.AllowAutoRedirect = $false     # 跟随重定向就等于把「上游 URL 白名单」让给了上游自己
        $resp = $req.GetResponse()
        try {
            $out.status = [int]$resp.StatusCode
            $ms = New-Object System.IO.MemoryStream
            $resp.GetResponseStream().CopyTo($ms, 65536)
            $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
            $out.text = Cut $text 262144
        } finally { try { $resp.Close() } catch { } }
        if ($out.status -lt 200 -or $out.status -ge 300) {
            $out.error = ('上游返回 HTTP ' + $out.status)
            $out.error_kind = 'http_error'
            return $out
        }
        try { $out.data = ConvertFrom-Json -InputObject $out.text } catch {
            $out.error = ('上游响应不是合法 JSON（' + (Cut $_.Exception.Message 120) + '）')
            $out.error_kind = 'json_error'
            return $out
        }
        $out.ok = $true
    } catch [System.Net.WebException] {
        $m = $_.Exception.Message
        if ($m -match 'timeout|超时') { $out.error_kind = 'timeout' } else { $out.error_kind = 'network' }
        $out.error = ('上游请求失败：' + (Cut $m 160))
        try {
            $wr = $_.Exception.Response
            if ($wr) { $out.status = [int]$wr.StatusCode; $out.error_kind = 'http_error' }
        } catch { }
    } catch {
        $out.error = ('上游请求异常（已捕获）：' + $_.Exception.Message)
        $out.error_kind = 'network'
    }
    $out.elapsed_ms = [math]::Round(((Get-Date) - $started).TotalMilliseconds, 1)
    return $out
}

# ---------------------------------------------------------------- 7b. 跨站来源判定
function Test-LoopbackDottedQuad {
    param($Text)
    # 点分四段、每段 0..255、第一段是 127，才算回环。
    # 为什么不用 [System.Net.IPAddress]::Parse：.NET 认「127.1」这种简写（悄悄补成 127.0.0.1），
    # 而 Origin 里出现简写本身就是一种伪装尝试——拒绝只是让本机页面换个写法，
    # 放过则等于给「看起来像回环」的外部站点开门。
    $m = [regex]::Match(('' + $Text), '^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$')
    if (-not $m.Success) { return $false }
    foreach ($g in @(1, 2, 3, 4)) { if ([int]$m.Groups[$g].Value -gt 255) { return $false } }
    return ([int]$m.Groups[1].Value -eq 127)
}

function Split-OriginAuthority {
    param($Authority)
    # origin 只有「协议 + 主机 + 端口」。这里把主机与端口拆开：方括号里的 IPv6 整体算主机，
    # 端口必须是纯数字。拆不出来（多个冒号、方括号不成对、端口写了别的）返回 $null → 拒绝。
    $a = ('' + $Authority).Trim().ToLowerInvariant()
    if ($a.Length -eq 0) { return $null }
    if ($a.StartsWith('[')) {
        $end = $a.IndexOf(']')
        if ($end -lt 0) { return $null }
        $headText = $a.Substring(0, $end + 1)
        $tail = $a.Substring($end + 1)
        if ($tail.Length -eq 0) { return @{ host = $headText; port = '' } }
        if (-not $tail.StartsWith(':')) { return $null }
        if ($tail.Substring(1) -notmatch '^[0-9]{1,5}$') { return $null }
        return @{ host = $headText; port = $tail.Substring(1) }
    }
    if ($a.IndexOf(']') -ge 0) { return $null }      # 方括号只能出现在最前面
    $colon = $a.LastIndexOf(':')
    if ($colon -ge 0) {
        $headText = $a.Substring(0, $colon)
        $portText = $a.Substring($colon + 1)
        if ($portText -notmatch '^[0-9]{1,5}$') { return $null }
        if ($headText.Length -eq 0) { return $null }
        return @{ host = $headText; port = $portText }
    }
    return @{ host = $a; port = '' }
}

function Test-LoopbackOriginHost {
    param($HostText)
    # 主机名 → 是不是回环。域名只有 localhost 算（浏览器给它的 Origin 就是 http://localhost:端口）；
    # 其余必须是 IP 字面量，且真是回环段。[::ffff:a.b.c.d] 这种「IPv6 写法包着 IPv4」要看内层，
    # 所以 [::ffff:8.8.8.8] 会在这里被拒（8.8.8.8 不是回环）。
    $t = ('' + $HostText).Trim().ToLowerInvariant()
    if ($t -eq 'localhost') { return $true }
    if ($t.StartsWith('[')) {
        $inner = $t.Substring(1, $t.Length - 2)
        $v4 = [regex]::Match($inner, '^::ffff:([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$')
        if ($v4.Success) { return (Test-LoopbackDottedQuad $v4.Groups[1].Value) }
        if ($inner -match '^[0-9a-f:.]+$') {
            try { return [bool][System.Net.IPAddress]::IsLoopback([System.Net.IPAddress]::Parse($inner)) } catch { return $false }
        }
        return $false
    }
    if ($t -match '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$') { return (Test-LoopbackDottedQuad $t) }
    return $false
}

function Test-OriginAllowed {
    param($Origin, $Extra)
    # 放行 = 把这个 Origin 原样回显成 Access-Control-Allow-Origin。
    # 判定顺序与 server.py 的 origin_allowed() 逐条对应：空 → 内置名单 → 回环 → 追加名单。
    $o = ('' + $Origin).Trim().ToLowerInvariant()
    if ($o.Length -eq 0) { return $true }
    if ($script:CorsBuiltInOrigins -contains $o) { return $true }
    $m = [regex]::Match($o, '^(https?)://([^/?#@]+)$')
    if ($m.Success) {
        $parts = Split-OriginAuthority $m.Groups[2].Value
        if ($null -ne $parts -and (Test-LoopbackOriginHost $parts.host)) { return $true }
    }
    $list = @($script:CorsExtraOrigins)
    if ($null -ne $Extra) { $list = @($Extra) + $list }
    foreach ($x in $list) { if ($o -eq ('' + $x).Trim().ToLowerInvariant()) { return $true } }
    return $false
}

function Add-AllowedOrigin {
    param($Origin)
    # -AllowOrigin 的落点：只接受完整 origin（协议+主机[:端口]），别的写法当场报错、拒绝启动。
    # 名单只能变长：这里没有任何「运行时由响应加宽名单」的入口，网页自己更无权改它。
    $o = ('' + $Origin).Trim().ToLowerInvariant().TrimEnd('/')
    if ($o -notmatch '^https?://[a-z0-9.\-:\[\]]+$') {
        return @{ ok = $false; error = ('来源写法不对（要 https://域名 或 http://127.0.0.1:端口）：' + (One-Line $Origin 60)) }
    }
    $script:CorsExtraOrigins = @($script:CorsExtraOrigins) + @($o)
    return @{ ok = $true; added = $o }
}

function Get-RequestOrigin {
    param($Ctx)
    # 取不到就返回空串：空串等于「非浏览器客户端」，照常服务而不是拒绝（启动器探测走这条）。
    try {
        $h = $Ctx.Request.Headers['Origin']
        if ($null -eq $h) { return '' }
        return ('' + $h).Trim()
    } catch { return '' }
}

# ---------------------------------------------------------------- 8. 响应输出
function Send-BridgeResponse {
    param($Ctx, [int]$Code, $BodyBytes, [string]$ContentType, [bool]$IsApi, [bool]$HeadOnly, $Extra)
    # 静态资源不给 CORS：跨站页面不该能把本项目文件当免费 CDN 读取。
    # /api/* 只给名单里的来源，并且**原样回显**而不是 `*`：`*` 等于让浏览器里开着的任意网页
    # 都能读走本机响应，回显加名单才把这条边收紧到本项目自己的页面（见 Test-OriginAllowed）。
    $resp = $Ctx.Response
    $resp.StatusCode = $Code
    $resp.ContentType = $ContentType
    if ($BodyBytes) { $resp.ContentLength64 = $BodyBytes.Length } else { $resp.ContentLength64 = 0 }
    if ($IsApi) {
        $origin = Get-RequestOrigin $Ctx
        if ($origin -and (Test-OriginAllowed $origin)) {
            $resp.AddHeader('Access-Control-Allow-Origin', $origin)
            $resp.AddHeader('Vary', 'Origin')
        }
        $resp.AddHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
        $resp.AddHeader('Access-Control-Allow-Headers', 'content-type')
        $resp.AddHeader('Access-Control-Max-Age', '600')
    } else {
        $resp.AddHeader('X-Content-Type-Options', 'nosniff')
    }
    $resp.AddHeader('Cache-Control', 'no-store')
    foreach ($k in $Extra.Keys) { $resp.AddHeader([string]$k, [string]$Extra[$k]) }
    if (-not $HeadOnly -and $BodyBytes -and $BodyBytes.Length -gt 0) {
        try { $resp.OutputStream.Write($BodyBytes, 0, $BodyBytes.Length) } catch { }
    }
}

function Write-BridgeJson {
    param($Ctx, [int]$Code, $Object, [bool]$HeadOnly = $false)
    $text = To-Json $Object
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    Send-BridgeResponse -Ctx $Ctx -Code $Code -BodyBytes $bytes -ContentType 'application/json; charset=utf-8' -IsApi $true -HeadOnly $HeadOnly -Extra @{}
}

function Write-BridgeFail {
    param($Ctx, [int]$Code, [string]$Error, [string]$Kind, [bool]$IsApi = $true, [bool]$HeadOnly = $false, $Extra = @{})
    $obj = @{ ok = $false; error = $Error; error_kind = $Kind }
    foreach ($k in $Extra.Keys) { $obj[$k] = $Extra[$k] }
    if ($IsApi) {
        Write-BridgeJson -Ctx $Ctx -Code $Code -Object $obj -HeadOnly $HeadOnly
    } else {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes((To-Json $obj))
        Send-BridgeResponse -Ctx $Ctx -Code $Code -BodyBytes $bytes -ContentType 'application/json; charset=utf-8' -IsApi $false -HeadOnly $HeadOnly -Extra @{}
    }
}

# ---------------------------------------------------------------- 9. /api/* 端点
function Get-HealthPayload {
    $tools = @{
        traceroute = (Get-ToolPath 'traceroute')
        ping = (Get-ToolPath 'ping')
    }
    $caps = @()
    if ($tools.traceroute) { $caps += 'traceroute' }
    if ($tools.ping) { $caps += 'ping' }
    $caps += @('dns', 'iface', 'geoip', 'static')
    $banned = @($script:PositionParams); [Array]::Sort($banned)
    return @{
        ok = $true; status = 'ok'
        server = $script:ServerName; version = $script:Version
        python = $null; runtime = $script:RuntimeName
        platform = $script:PlatformName
        capabilities = $caps
        tools = @{
            traceroute = $(if ($tools.traceroute) { $tools.traceroute } else { '未找到（该功能会降级）' })
            ping = $(if ($tools.ping) { $tools.ping } else { '未找到（该功能会降级）' })
        }
        endpoints = @('/api/health', '/api/traceroute?host=&max_hops=', '/api/ping?host=&count=', '/api/dns?host=', '/api/iface', '/api/geoip?ip=&source=')
        bind = @{
            address = $script:BindHost; port = $script:Port; loopback_only = $true
            note = '非回环绑定在启动阶段就被拒绝；且每个请求再校验来源地址（http.sys 会在所有网卡上按 Host 头分派，光靠前缀字符串守不住）'
        }
        limits = @{
            max_hops = $script:MaxHopsLimit; max_ping_count = $script:MaxPingCount
            wall_clock_cap_s = $script:WallClockCapS; shell = $false
            max_concurrent_children = $script:Workers
        }
        privacy = @{
            position_params_accepted = $false
            banned_params = $banned
            lan_targets_allowed = $true
            note = '所有坐标类参数一律 400；GeoIP 代理只接受 IP 字面量或留空（查出口 IP）。traceroute/ping 可以打内网（追踪自家路由器是它的本职），响应里的 target_scope 会标明目标是内网还是公网'
        }
        cors_policy = @{
            wildcard = $false
            built_in = @($script:CorsBuiltInOrigins)
            extra = @($script:CorsExtraOrigins)
            loopback_origins_allowed = $true
            no_origin_clients_allowed = $true
            note = '名单外的浏览器来源一律 403 origin_not_allowed；回显具体来源而不是 *，所以任意网页读不到本机响应'
        }
        geoip_sources = @($script:GeoIpSources.Keys | Sort-Object)
        active_children = $(if ($script:Busy) { $script:Busy.Count } else { 0 })
        note = '系统命令以参数串 + UseShellExecute=false 执行（命令解释器从不参与）；只监听回环地址。这份实现没有 Python 依赖'
    }
}

function Invoke-ApiHealth { param($Ctx, $Q, [bool]$Head) Write-BridgeJson -Ctx $Ctx -Code 200 -Object (Get-HealthPayload) -HeadOnly $Head; return 200 }

function Get-Budget {
    param($Q, [double]$DefaultS, [double]$Low, [double]$High)
    $v = $DefaultS
    $raw = Get-QueryFirst $Q 'timeout'
    if ($raw) { $d = Parse-Num $raw; if ($null -ne $d) { $v = $d } }
    if ($v -lt $Low) { $v = $Low }
    if ($v -gt $High) { $v = $High }
    if ($v -gt $script:WallClockCapS) { $v = $script:WallClockCapS }
    return $v
}

function Invoke-ApiTraceroute {
    param($Ctx, $Q, [bool]$Head)
    $vh = Test-LegalHost (Get-QueryFirst $Q 'host' '')
    if (-not $vh.ok) {
        Write-BridgeFail -Ctx $Ctx -Code 400 -Error ('host 参数非法：' + $vh.reason) -Kind 'bad_input' -HeadOnly $Head -Extra @{ host = $null }
        return 400
    }
    $maxHops = Convert-SafeInt (Get-QueryFirst $Q 'max_hops' '') 20 1 $script:MaxHopsLimit
    $wallS = Get-Budget $Q 30.0 5.0 120.0
    # 每跳等待按总预算摊：hops 多时单跳等待自动变短，保证整条命令不突破墙钟。
    $perHop = [int][math]::Max(1, [math]::Min(5, [int]($wallS / [math]::Max(1, $maxHops))))
    $exe = Get-ToolPath 'traceroute'
    if (-not $exe) {
        Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
            ok = $false; error = '本机找不到 tracert 命令（未安装或不在 PATH）'; error_kind = 'command_missing'
            host = $vh.host; hops = @(); hop_count = 0; fabricated_hops = $false
            note = '命令缺失属于降级，不是失败：前端会改用浏览器 DoH 兜底解析'
        } -HeadOnly $Head
        return 200
    }
    $args2 = Build-TracerouteArgs $vh.host $maxHops $perHop
    $dns = Resolve-HostName $vh.host ([int]([math]::Min(5.0, $wallS) * 1000))
    # 内网/公网只做标注，不做拦截：追踪自家路由器是 ⑧ 的本职，
    # 但页面应当知道这次包有没有跑出局域网（所以域名还要看解析结果）。
    $scope = Get-TargetScope $vh.host $dns.addresses
    $run = Enter-BusyRegion { Start-CapturedProcess $exe $args2 ([int]($wallS * 1000)) }
    if (-not $run.ok -and ([string]::IsNullOrWhiteSpace($run.stdout))) {
        Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
            ok = $false; error = $(if ($run.error) { $run.error } else { '命令执行失败' }); error_kind = $run.error_kind
            host = $vh.host; hops = @(); hop_count = 0; fabricated_hops = $false
            exit_code = $run.code; timed_out = $run.timed_out; elapsed_ms = $run.elapsed_ms
            note = '未取得任何输出，绝不编造跳数'
        } -HeadOnly $Head
        return 200
    }
    $parsed = Convert-TracerouteText $run.stdout
    $hops = @($parsed.hops)
    $target = $parsed.target_ip
    if (-not $target -and $dns.addresses.Count -gt 0) { $target = $dns.addresses[0] }
    $reached = ($hops.Count -gt 0 -and $target -and $hops[$hops.Count - 1].ip -eq $target)
    $obj = @{
        ok = ($hops.Count -gt 0)
        host = $vh.host; host_kind = $vh.kind; target_ip = $target
        target_scope = $scope.scope; target_scope_note = $scope.note
        max_hops = $maxHops; per_hop_timeout_s = $perHop; wall_clock_s = $wallS
        hops = $hops; hop_count = $hops.Count; reached = [bool]$reached
        fabricated_hops = $false
        command = $exe; argv = (Build-TracerouteArgv $exe $vh.host $maxHops $perHop); shell = $false
        exit_code = $run.code; timed_out = $run.timed_out; elapsed_ms = $run.elapsed_ms
        stderr = (One-Line $run.stderr 240)
        unparsed_lines = @($parsed.unparsed)
        error = $(if ($hops.Count -gt 0) { $null } else { '命令执行完成但没有解析出任何跳（目标不可达/被防火墙静默丢弃），未伪造跳数' })
        error_kind = $(if ($hops.Count -gt 0) { $null } else { 'no_hops' })
        note = '跳数完全来自系统 tracert 的文本输出解析；解析不出来的行保留在 unparsed_lines'
    }
    Write-BridgeJson -Ctx $Ctx -Code 200 -Object $obj -HeadOnly $Head
    return 200
}

function Invoke-ApiPing {
    param($Ctx, $Q, [bool]$Head)
    $vh = Test-LegalHost (Get-QueryFirst $Q 'host' '')
    if (-not $vh.ok) { Write-BridgeFail -Ctx $Ctx -Code 400 -Error ('host 参数非法：' + $vh.reason) -Kind 'bad_input' -HeadOnly $Head; return 400 }
    $count = Convert-SafeInt (Get-QueryFirst $Q 'count' '') 4 1 $script:MaxPingCount
    $wallS = Get-Budget $Q 15.0 3.0 60.0
    $exe = Get-ToolPath 'ping'
    if (-not $exe) {
        Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{ ok = $false; error = '本机找不到 ping 命令'; error_kind = 'command_missing'; host = $vh.host } -HeadOnly $Head
        return 200
    }
    $perCount = [int][math]::Max(1, ($wallS / [math]::Max(1, $count)))
    $args2 = Build-PingArgs $vh.host $count $perCount
    $dns = Resolve-HostName $vh.host ([int]([math]::Min(2.0, $wallS) * 1000))
    $scope = Get-TargetScope $vh.host $dns.addresses
    $run = Enter-BusyRegion { Start-CapturedProcess $exe $args2 ([int]($wallS * 1000)) }
    $stats = Convert-PingText $run.stdout
    # ping 的退出码在非零丢包时也是非零（Windows 全丢包返回 1），
    # 所以用「解析到统计段」判成功，而不是用退出码——否则会把 100% 丢包误报成命令失败。
    $gotStats = ($null -ne $stats.received) -or ($stats.samples_ms.Count -gt 0)
    Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
        ok = ($run.ok -or $gotStats)
        host = $vh.host; command = $exe; argv = (Build-PingArgv $exe $vh.host $count $perCount); shell = $false
        target_ip = $(if ($dns.addresses.Count -gt 0) { $dns.addresses[0] } else { $null })
        target_scope = $scope.scope; target_scope_note = $scope.note
        count = $count; stats = $stats
        exit_code = $run.code; timed_out = $run.timed_out; elapsed_ms = $run.elapsed_ms
        stderr = (One-Line $run.stderr 240)
        error = $run.error; error_kind = $run.error_kind
        fabricated_stats = $false
        note = '统计段完全来自系统 ping 的文本输出；解析不到就是 null，不填 0'
    } -HeadOnly $Head
    return 200
}

function Invoke-ApiDns {
    param($Ctx, $Q, [bool]$Head)
    $vh = Test-LegalHost (Get-QueryFirst $Q 'host' '')
    if (-not $vh.ok) { Write-BridgeFail -Ctx $Ctx -Code 400 -Error ('host 参数非法：' + $vh.reason) -Kind 'bad_input' -HeadOnly $Head; return 400 }
    $wallS = Get-Budget $Q 5.0 1.0 20.0
    $res = Resolve-HostName $vh.host ([int]($wallS * 1000))
    # 额外给一份 DoH 形状（Status/Answer[].data）：前端 dohResolve 的 URL 模板可覆盖，
    # 把 {host}/{type} 指到这里就能在内网/无外部 DNS 的环境里复用同一套调用代码。
    $answers = @()
    foreach ($addr in @($res.addresses)) {
        $answers += @{ name = $vh.host; type = $(if ($addr.Contains(':')) { 28 } else { 1 }); data = $addr; TTL = $null }
    }
    Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
        ok = $res.ok; host = $vh.host; kind = $vh.kind
        addresses = @($res.addresses); family = $res.family
        Status = $(if ($res.ok) { 0 } else { 2 })
        Answer = $answers
        error = $res.error; error_kind = $res.error_kind
        note = '只做名字解析（.NET Dns.GetHostAddresses），不经过 shell；带超时是因为该调用不可中断。Status/Answer 是为前端 DoH 模板兼容而提供的形状，字段号按 RFC1035/DNS 记录类型，未逐字段核对'
    } -HeadOnly $Head
    return 200
}

function Invoke-ApiIface {
    param($Ctx, $Q, [bool]$Head)
    Write-BridgeJson -Ctx $Ctx -Code 200 -Object (Get-IfaceSummary) -HeadOnly $Head
    return 200
}

function Test-JsonHasField {
    param($Data, [string]$Name)
    # ConvertFrom-Json 给的是 PSCustomObject，内部构造/自检给的是哈希表——两种都认，
    # 这样同一个归一函数既能对着真实上游跑，也能在离线闸门里喂固定 JSON。
    if ($null -eq $Data -or [string]::IsNullOrEmpty($Name)) { return $false }
    if ($Data -is [System.Collections.IDictionary]) { return $Data.Contains($Name) }
    return ($null -ne $Data.PSObject.Properties[$Name])
}

function Get-JsonValue {
    param($Data, [string]$Name)
    if (-not (Test-JsonHasField $Data $Name)) { return $null }
    if ($Data -is [System.Collections.IDictionary]) { return $Data[$Name] }
    return $Data.$Name
}

function Pick-JsonField {
    param($Data, $Names)
    # 与 server.py 的 pick_field 同规则：第一个「键存在且值不是 null」就返回，空串也照样返回
    # （空串是上游真的给了空串，不是缺失；把它当缺失去翻下一个候选，两份桥就会给出不同的城市名）。
    foreach ($n in @($Names)) {
        if ($null -eq $n) { continue }
        if (Test-JsonHasField $Data ('' + $n)) {
            $v = Get-JsonValue $Data ('' + $n)
            if ($null -ne $v) { return $v }
        }
    }
    return $null
}

function Get-FiniteNumber {
    param($Value)
    # 只认不变文化写法下的有限实数：'39.03' 收，'NaN'/'abc'/布尔 一律 null（宁缺毋假）。
    if ($null -eq $Value) { return $null }
    if ($Value -is [bool]) { return $null }
    $d = [double]0
    $ok = [double]::TryParse(('' + $Value).Trim(), [System.Globalization.NumberStyles]::Float,
                             [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)
    if (-not $ok) { return $null }
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
    return $d
}

function Get-NormalizedGeoIp {
    param($Data, [string]$SourceId)
    # 与 server.py 的 parse_geoip_json 同形同义：取不到的字段一律 null；精度取不到就留给前端按
    # 兜底量级处理并标 accuracy_fallback；只解析出一个坐标轴时报 field_invalid，而不是当成「没有坐标」。
    $src = $script:GeoIpSources[$SourceId]
    if ($null -eq $src) { $src = @{} }
    $res = [ordered]@{ ip = $null; lat = $null; lon = $null; accuracy_km = $null; city = $null;
                       country = $null; source = $SourceId; ok = $false; error = $null;
                       error_kind = $null; accuracy_fallback = $true }
    # Python 那边是 `not isinstance(data, dict)`：数组、字符串、数字都算「不是 JSON 对象」。
    # 这里不能用 [pscustomobject] 这个别名——5.1 上它解析成 PSObject，于是 Object[] 也 -is 为真，
    # 数组会被当成对象继续往下解析（闸门就是这么抓到上一个版本把数组放行的）。写全名才准。
    $isObject = ($Data -is [System.Collections.IDictionary]) -or
                ($Data -is [System.Management.Automation.PSCustomObject])
    if ($null -eq $Data -or -not $isObject) {
        $res['error'] = '上游返回不是 JSON 对象'; $res['error_kind'] = 'json_error'; return $res
    }
    if (Test-JsonHasField $src 'status_key') {
        $got = Get-JsonValue $Data ('' + $src['status_key'])
        # 与 Python 的 `got != status_ok` 对齐：Python 的字符串比较区分大小写、不Trim，而 PowerShell 的
        # -eq 两样都不满足（上游写 'Success' 或 'success ' 会被这里当成成功，Python 却判失败）。
        $same = ($null -ne $got) -and
                [string]::Equals('' + $got, '' + $src['status_ok'], [System.StringComparison]::Ordinal)
        if (-not $same) {
            $msg = Pick-JsonField $Data @('message', 'error', 'reason')
            # Python 写的是 `pick_field(...) or got`：空串也会退到 got，所以这里同样把空串当没给。
            if ($null -eq $msg -or ('' + $msg).Length -eq 0) { $msg = ('' + $got) }
            $res['error'] = ('上游按自身 status 字段判定失败：' + $msg)
            $res['error_kind'] = 'field_missing'
            return $res
        }
    }
    $res['ip'] = Pick-JsonField $Data $src['ip_keys']
    $latKeys = @($src['lat_keys'])
    if ($src['split_loc']) {
        $loc = Pick-JsonField $Data $latKeys
        if ($loc -is [string] -and $loc.IndexOf(',') -ge 0) {
            # 不写 $loc.Split(@(','), 2)：PowerShell 会把 2 绑到 StringSplitOptions 上（重载解析挑错），
            # 而 Python 的 split(",", 1) 是「只切一刀，剩下的都归第二段」。这里手动按第一个逗号切。
            $cut = $loc.IndexOf(',')
            $la = Get-FiniteNumber $loc.Substring(0, $cut)
            $lo = Get-FiniteNumber $loc.Substring($cut + 1)
            if ($null -eq $la -or $null -eq $lo) {
                $res['error'] = ('loc 字段无法拆成两个有限实数（' + $loc + '）')
                $res['error_kind'] = 'field_invalid'
                return $res
            }
            $res['lat'] = $la; $res['lon'] = $lo
        }
    } else {
        $lat = Get-FiniteNumber (Pick-JsonField $Data $latKeys)
        $lon = Get-FiniteNumber (Pick-JsonField $Data @($src['lon_keys']))
        if (($null -eq $lat) -ne ($null -eq $lon)) {
            $res['error'] = ('经纬度只解析出一个（lat=' + $lat + ' lon=' + $lon + '），字段名按公开文档，未逐字段核对')
            $res['error_kind'] = 'field_invalid'
            return $res
        }
        $res['lat'] = $lat; $res['lon'] = $lon
    }
    $res['accuracy_km'] = Get-FiniteNumber (Pick-JsonField $Data $src['acc_keys'])
    $res['accuracy_fallback'] = ($null -eq $res['accuracy_km'])
    $res['city'] = Pick-JsonField $Data $src['city_keys']
    $res['country'] = Pick-JsonField $Data $src['country_keys']
    if ($null -eq $res['lat'] -or $null -eq $res['lon']) {
        $res['error'] = ('缺少经纬度字段（按公开文档找过 ' + ($latKeys -join '/') + '，未逐字段核对）')
        $res['error_kind'] = 'field_missing'
        return $res
    }
    if ([math]::Abs([double]$res['lat']) -gt 90 -or [math]::Abs([double]$res['lon']) -gt 180) {
        $res['error'] = ('经纬度越界（lat=' + $res['lat'] + ' lon=' + $res['lon'] + '）')
        $res['error_kind'] = 'field_invalid'
        return $res
    }
    $res['ok'] = $true
    return $res
}

function Invoke-ApiGeoIp {
    param($Ctx, $Q, [bool]$Head)
    $source = (Get-QueryFirst $Q 'source' 'ipapi_com').Trim()
    $ip = Get-QueryFirst $Q 'ip' ''
    $custom = Get-QueryFirst $Q 'upstream_url' ''
    $built = New-GeoIpUrl $source $ip $custom
    if (-not $built.url) { Write-BridgeFail -Ctx $Ctx -Code 400 -Error $built.reason -Kind 'bad_input' -HeadOnly $Head; return 400 }
    $wallS = Get-Budget $Q 8.0 2.0 30.0
    $got = Invoke-JsonFetch $built.url ([int]($wallS * 1000))
    if (-not $got.ok) {
        Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
            ok = $false; source = $source; url = $built.url; upstream = $null; normalized = $null
            error = $got.error; error_kind = $got.error_kind
            http_status = $got.status; elapsed_ms = $got.elapsed_ms
            note = '上游失败的分类彼此不同（超时/HTTP错误/非JSON/输入非法），便于分别提示'
        } -HeadOnly $Head
        return 200
    }
    $src = $script:GeoIpSources[$source]
    $noteText = $(if ($src -and $src.note) { $src.note } else { '字段名未逐字段核对' })
    $norm = Get-NormalizedGeoIp $got.data $source
    Write-BridgeJson -Ctx $Ctx -Code 200 -Object @{
        ok = $true; source = $source; url = $built.url
        http_status = $got.status; elapsed_ms = $got.elapsed_ms
        upstream = $got.data
        # normalized 与 server.py 同名字段：上游 HTTP 成功但归一失败时，ok 仍是 true（代理确实取到了东西），
        # 失败信息在 normalized.error / 这一行的 error 里，页面据此区分「取到了但没坐标」。
        normalized = $norm
        fields_note = $noteText
        error = $norm['error']; error_kind = $norm['error_kind']
        note = '本端点只按 IP 查询，请求里不含任何坐标；留空 ip 表示查本服务出口 IP'
    } -HeadOnly $Head
    return 200
}

# ---------------------------------------------------------------- 10. 静态文件
function Convert-StaticPath {
    param([string]$RawPath, [string]$RootDir)
    # 三层防线：先解百分号编码再判 ..；逐段拒绝；最后用解析后的绝对路径复核。
    # 另外拒绝点开头文件（.env/.git/.ssh）与常见私钥/数据库扩展名。
    $r = @{ ok = $false; path = $null; reason = $null }
    if ($null -eq $RawPath) { $RawPath = '/' }
    $decoded = $RawPath
    try { $decoded = [System.Uri]::UnescapeDataString($RawPath) } catch { }
    if ($decoded -match '[\x00-\x1f\x7f]') { $r.reason = '路径含控制字符'; return $r }
    if ($decoded.IndexOf([char]0) -ge 0) { $r.reason = '路径含 NUL'; return $r }
    if ($decoded -match '^[a-zA-Z]:[\\/]') { $r.reason = '路径含 Windows 绝对盘符，拒绝'; return $r }
    if ($decoded.StartsWith('\') -or $decoded.StartsWith('//')) { $r.reason = '路径是 UNC/双斜杠的绝对写法，拒绝'; return $r }
    if ($decoded.Contains('\')) { $r.reason = '路径含反斜杠（Windows 分隔符），拒绝'; return $r }
    # URL 路径天生以 / 开头，这里剥掉的只是根锚点：剥完之后一律相对 root 解释。
    if ($decoded.StartsWith('/')) { $decoded = $decoded.Substring(1) }
    $clean = @()
    foreach ($seg in $decoded.Split('/')) {
        if ($seg -eq '' -or $seg -eq '.') { continue }
        if ($seg -eq '..') { $r.reason = '路径含 ..（目录穿越），拒绝'; return $r }
        if ($seg.StartsWith('.')) { $r.reason = ('路径含点文件/点目录（' + $seg + '），拒绝'); return $r }
        $clean += $seg
    }
    $rootFull = [System.IO.Path]::GetFullPath($RootDir).TrimEnd('\')
    $rel = ($clean -join '\')
    $candidate = if ($rel.Length -gt 0) { [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel)) } else { $rootFull }
    if ($candidate.Length -le $rootFull.Length) {
        if ($candidate.TrimEnd('\') -ne $rootFull) { $r.reason = '路径解析后逃出静态根目录，拒绝'; return $r }
    } elseif ($candidate.Substring(0, $rootFull.Length).TrimEnd('\') -ne $rootFull) {
        $r.reason = '路径解析后逃出静态根目录，拒绝'; return $r
    }
    $base = [System.IO.Path]::GetFileName($candidate)
    if ($base -and $base.StartsWith('.')) { $r.reason = ('拒绝提供点文件（' + $base + '）'); return $r }
    $ext = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
    if ($script:SecretExts -contains $ext) { $r.reason = ('拒绝提供敏感类型文件（' + $ext + '）'); return $r }
    return @{ ok = $true; path = $candidate; reason = $null }
}

function Invoke-StaticRequest {
    param($Ctx, [string]$RawPath, [bool]$Head)
    $j = Convert-StaticPath $RawPath $script:Root
    if (-not $j.ok) {
        Write-BridgeFail -Ctx $Ctx -Code 403 -Error ('路径被拒绝：' + $j.reason) -Kind 'path_rejected' -IsApi $false -HeadOnly $Head
        return 403
    }
    $target = $j.path
    # 先判存在，再取属性：[IO.File]::GetAttributes() 对不存在的路径是**抛异常**而不是返回 0，
    # 早先把顺序写反了，于是 404（没有这个文件）全变成 500（内部异常）。
    if (-not (Test-Path -LiteralPath $target)) {
        Write-BridgeFail -Ctx $Ctx -Code 404 -Error ('文件不存在：' + (One-Line $RawPath 120)) -Kind 'not_found' -IsApi $false -HeadOnly $Head
        return 404
    }
    $attrs = [System.IO.File]::GetAttributes($target)
    if ($attrs -band [System.IO.FileAttributes]::Directory) {
        $index = Join-Path $target 'index.html'
        if (Test-Path -LiteralPath $index -PathType Leaf) { $target = $index }
        else {
            Write-BridgeFail -Ctx $Ctx -Code 403 -Error '目录列表在本实现里不提供（只服务 index.html 与显式文件）' -Kind 'path_rejected' -IsApi $false -HeadOnly $Head
            return 403
        }
    }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        Write-BridgeFail -Ctx $Ctx -Code 404 -Error ('文件不存在：' + (One-Line $RawPath 120)) -Kind 'not_found' -IsApi $false -HeadOnly $Head
        return 404
    }
    $fi = New-Object System.IO.FileInfo($target)
    # 联接/重解析点：看着在根目录里，实际指向别处，一律不给。
    if ($fi.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-BridgeFail -Ctx $Ctx -Code 403 -Error '目标是符号链接/联接点（拒绝跟随）' -Kind 'path_rejected' -IsApi $false -HeadOnly $Head
        return 403
    }
    if ($fi.Length -gt $script:StaticMaxBytes) {
        Write-BridgeFail -Ctx $Ctx -Code 413 -Error ('文件过大（' + $fi.Length + ' 字节 > ' + $script:StaticMaxBytes + '），本服务不做流式传输') -Kind 'too_large' -IsApi $false -HeadOnly $Head
        return 413
    }
    try { $bytes = [System.IO.File]::ReadAllBytes($target) } catch {
        Write-BridgeFail -Ctx $Ctx -Code 500 -Error ('读取文件失败：' + $_.Exception.Message) -Kind 'io_error' -IsApi $false -HeadOnly $Head
        return 500
    }
    $ext = $fi.Extension.ToLowerInvariant()
    # 表里的值就是最终响应头，不再运行时拼 charset（拼法一旦和 server.py 不同，同一张 svg
    # 在两份桥下的头就不一致，而页面看不出任何异常）。没列进来的扩展名一律按二进制给。
    $ctype = $script:TextTypes[$ext]
    if (-not $ctype) { $ctype = 'application/octet-stream' }
    Send-BridgeResponse -Ctx $Ctx -Code 200 -BodyBytes $bytes -ContentType $ctype -IsApi $false -HeadOnly $Head -Extra @{}
    return 200
}

# ---------------------------------------------------------------- 11. 请求分发
function Get-QueryFirst {
    param($Q, [string]$Key, [string]$Default = '')
    $v = $Q[$Key]
    if ($v -and ($v -is [array])) { $v = $v[0] }
    if ($null -eq $v) { return $Default }
    return [string]$v
}

function Enter-BusyRegion {
    param([scriptblock]$Body)
    # 并发上限：和 server.py 一样，超过 Workers 个追踪同时跑就先挡回来，
    # 免得有人连点十次把机器变成 tracert 发射台。
    if ($script:Busy) {
        if ($script:Busy.Count -ge $script:Workers) {
            return @{ ok = $false; stdout = ''; error = ('本机已有 ' + $script:Busy.Count + ' 个追踪在跑，请等一会儿再试'); error_kind = 'busy'; code = $null; timed_out = $false; elapsed_ms = $null; stderr = ''; busy = $true }
        }
        $token = New-Object psobject
        $script:Busy.Enqueue($token)
        try { return & $Body } finally { $dummy = $null; [void]$script:Busy.TryDequeue([ref]$dummy) }
    }
    return & $Body
}

function Test-LoopbackIpText {
    param($Text)
    # 「这个来源地址是不是回环」按文本判，最后才交给框架。
    # 为什么不走属性链：IPAddress 的实例属性 IsLoopback 是 .NET Core 才有的，PowerShell 5.1 跑在
    # CLR 4 上——那里 IPAddress 只有静态的 [IPAddress]::IsLoopback($ip)。第一版按实例属性取，
    # 在 5.1 上拿到的是「空」，于是 127.0.0.1 与 ::1 全被判成非回环，服务把自己锁死成 403。
    $s = ('' + $Text).Trim().Trim('[', ']').Split('%')[0]
    if ($s.Length -eq 0) { return $false }
    if ($s -eq '::1' -or $s -eq '0:0:0:0:0:0:0:1' -or $s -eq 'localhost') { return $true }
    # 127.0.0.0/8 整段都是回环，不是只有 127.0.0.1
    if ($s -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $true }
    if ($s -match '^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $true }
    # 兜底交给框架（显式静态调用，两个版本都有）；解析不了就判非回环：宁可拒绝，不可放行。
    try {
        $ip2 = [System.Net.IPAddress]::Parse($s)
        return [bool][System.Net.IPAddress]::IsLoopback($ip2)
    } catch { return $false }
}

function Test-LoopbackPeer {
    param($Ctx)
    # 为什么要单独守这一条：HttpListener 的前缀是**按 Host 头**分派的，而 http.sys 会在本机
    # 所有网卡上监听这个端口。我们为了让 http://localhost:8765/ 能用而加的 localhost 前缀，
    # 局域网里任何机器只要把 Host 写成 localhost 就能命中——实测过：
    # curl http://192.168.2.140:8797/api/health -H 'Host: localhost' 返回 200。
    # 所以「只服务回环」这句话不能只写在前缀字符串里，必须逐请求校验来源地址。
    # 来源取 RemoteEndPoint.Address：实测 UserHostAddress 给的是「本地地址:端口」（127.0.0.1:8796），
    # 不是文档说的客户端 IP，拿它判回环等于永远判对，所以不用它。
    $ip = $null
    try { $ip = $Ctx.Request.RemoteEndPoint.Address } catch { $ip = $null }
    if ($null -eq $ip) { return @{ ok = $false; peer = '' } }
    $s = '' + $ip
    return @{ ok = (Test-LoopbackIpText $s); peer = $s }
}

function Invoke-BridgeRequest {
    param($Ctx)
    $req = $Ctx.Request
    $headOnly = ($req.HttpMethod -eq 'HEAD')
    $url = $req.Url
    $path = [System.Uri]::UnescapeDataString($url.AbsolutePath)
    $isApi = ($path -eq '/api') -or $path.StartsWith('/api/')
    $code = 500
    $started = Get-Date
    try {
        $peer = Test-LoopbackPeer $Ctx
        if (-not $peer.ok) {
            Write-BridgeFail -Ctx $Ctx -Code 403 -Error ('来源地址 ' + $peer.peer + ' 不是回环：本服务只在 127.0.0.1/::1 上服务（http.sys 会在所有网卡上收 Host: localhost 的请求，所以逐条校验来源）') -Kind 'not_loopback' -IsApi $isApi -HeadOnly $headOnly
            $code = 403; return
        }
        if ($req.HttpMethod -eq 'OPTIONS') {
            if (-not $isApi) {
                Write-BridgeFail -Ctx $Ctx -Code 405 -Error '静态资源不接受预检（本服务只支持 GET/HEAD/OPTIONS-on-/api）' -Kind 'method_not_allowed' -IsApi $false -HeadOnly $headOnly
                $code = 405; return
            }
            $resp = $Ctx.Response
            $preOrigin = Get-RequestOrigin $Ctx
            if ($preOrigin -and -not (Test-OriginAllowed $preOrigin)) {
                # 不在名单里的站点连预检都不给它过：状态码 403 + 中文原因，界面会原样显示。
                Write-BridgeFail -Ctx $Ctx -Code 403 -Error ('跨站来源 ' + (One-Line $preOrigin 80) + ' 不在白名单里，本桥只服务本机自己的页面（file://、回环地址与官方托管页；要加别的域名请用 -AllowOrigin）') -Kind 'origin_not_allowed' -IsApi $true -HeadOnly $headOnly
                $code = 403; return
            }
            $resp.StatusCode = 204
            $resp.ContentLength64 = 0
            if ($preOrigin) {
                $resp.AddHeader('Access-Control-Allow-Origin', $preOrigin)
                $resp.AddHeader('Vary', 'Origin')
            }
            $resp.AddHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
            $resp.AddHeader('Access-Control-Allow-Headers', 'content-type')
            # 托管页（https）访问本机回环属于「私有网络访问」，Chrome 会先发带
            # Access-Control-Request-Private-Network 的预检并要求回显。按调用方是否提出来决定回显。
            if (("" + $req.Headers['Access-Control-Request-Private-Network']).ToLowerInvariant() -eq 'true') {
                $resp.AddHeader('Access-Control-Allow-Private-Network', 'true')
            }
            $resp.AddHeader('Access-Control-Max-Age', '600')
            $code = 204; return
        }
        if ($req.HttpMethod -eq 'POST' -or $req.HttpMethod -eq 'PUT' -or $req.HttpMethod -eq 'DELETE') {
            Write-BridgeFail -Ctx $Ctx -Code 405 -Error '本服务只读：所有端点都是 GET（POST 没有可写状态，避免被当作内网探针）' -Kind 'method_not_allowed' -HeadOnly $headOnly
            $code = 405; return
        }
        if ($req.HttpMethod -ne 'GET' -and -not $headOnly) {
            Write-BridgeFail -Ctx $Ctx -Code 405 -Error ('不支持的方法 ' + $req.HttpMethod) -Kind 'method_not_allowed' -HeadOnly $headOnly
            $code = 405; return
        }
        $q = $req.QueryString
        $keys = @()
        if ($q) { $keys = @($q.AllKeys | Where-Object { $null -ne $_ }) }
        # 隐私红线的第一道闸：任何位置类参数直接拒，不进入任何业务逻辑。
        $bad = Get-PositionParamHits $keys
        if ($bad.Count -gt 0) {
            Write-BridgeFail -Ctx $Ctx -Code 400 -Error ('拒绝接收位置类参数 ' + ($bad -join ', ') + '：本服务默认不接收、不转发任何用户坐标（隐私红线）') -Kind 'privacy_rejected' -IsApi $isApi -HeadOnly $headOnly
            $code = 400; return
        }
        if ($isApi) {
            # 第二道闸：跨站来源。名单外的网页既读不到响应，也借不到这台机器发包。
            $reqOrigin = Get-RequestOrigin $Ctx
            if ($reqOrigin -and -not (Test-OriginAllowed $reqOrigin)) {
                Write-BridgeFail -Ctx $Ctx -Code 403 -Error ('跨站来源 ' + (One-Line $reqOrigin 80) + ' 不在白名单里，本桥只服务本机自己的页面（file://、回环地址与官方托管页；要加别的域名请用 -AllowOrigin）') -Kind 'origin_not_allowed' -IsApi $true -HeadOnly $headOnly
                $code = 403; return
            }
            $name = $path.TrimEnd('/')
            switch ($name) {
                '/api/health' { $code = Invoke-ApiHealth $Ctx $q $headOnly; return }
                '/api/traceroute' { $code = Invoke-ApiTraceroute $Ctx $q $headOnly; return }
                '/api/ping' { $code = Invoke-ApiPing $Ctx $q $headOnly; return }
                '/api/dns' { $code = Invoke-ApiDns $Ctx $q $headOnly; return }
                '/api/iface' { $code = Invoke-ApiIface $Ctx $q $headOnly; return }
                '/api/geoip' { $code = Invoke-ApiGeoIp $Ctx $q $headOnly; return }
                default {
                    Write-BridgeFail -Ctx $Ctx -Code 404 -Error ('未知端点 ' + $path + '（可用：/api/health, /api/traceroute, /api/ping, /api/dns, /api/iface, /api/geoip）') -Kind 'not_found' -HeadOnly $headOnly
                    $code = 404; return
                }
            }
        }
        $code = Invoke-StaticRequest $Ctx $path $headOnly
    } catch {
        try {
            Write-BridgeFail -Ctx $Ctx -Code 500 -Error ('服务内部异常（已捕获，进程继续运行）：' + $_.Exception.Message) -Kind 'internal_error' -IsApi $isApi -HeadOnly $headOnly
            $code = 500
        } catch { }
    } finally {
        try { $Ctx.Response.Close() } catch { }
        Write-BridgeLog ($req.HttpMethod + ' ' + (One-Line $url.PathAndQuery 200) + ' -> ' + $code + ' ' + [math]::Round(((Get-Date) - $started).TotalMilliseconds, 1) + 'ms')
    }
}

# ---------------------------------------------------------------- 12. 工作线程
function Start-BridgeWorkerLoop {
    param($Queue2, $Busy2)
    $script:Busy = $Busy2
    while ($true) {
        $ctx = $null
        try { $ctx = $Queue2.Take() } catch { Write-BridgeLog '工作线程退出（取队列异常/队列已关闭）'; break }
        if ($null -eq $ctx) { Write-BridgeLog '工作线程退出（取到空上下文）'; break }
        try { Invoke-BridgeRequest $ctx } catch { }
    }
}

# ---------------------------------------------------------------- 13. 运行期配置
function Initialize-BridgeRuntime {
    # 主线程与每个工作线程各自 dot-source 本文件、各自跑一遍这份配置：
    # 两边只有在「参数一致」时行为才一致，所以配置项一律从参数取，不靠全局残留。
    $script:Port = $Port
    $script:BindHost = ("" + $BindHost).Trim()
    $script:Quiet = [bool]$Quiet
    $script:Workers = $Workers
    if ($script:Workers -lt 1) { $script:Workers = 1 }
    if ($script:Workers -gt 16) { $script:Workers = 16 }
    $r = ("" + $Root).Trim()
    $script:Root = if ($r.Length -gt 0) { [System.IO.Path]::GetFullPath($r) } else { ("" + $PSScriptRoot) }
    if ($script:Root.Length -eq 0) { $script:Root = (Get-Location -Provider FileSystem).Path }
    $lf = ("" + $LogFile).Trim()
    if ($script:Quiet) { $script:LogFile = $null }
    elseif ($lf.Length -gt 0) { $script:LogFile = [System.IO.Path]::GetFullPath($lf) }
    else { $script:LogFile = Join-Path $script:Root 'bridge-powershell.log' }
    # 来源白名单在这里落地，且只在启动时落地：主线程与工作线程拿到的是同一份参数，
    # 名单因此不可能被某个请求自己加宽（运行期没有任何入口能改它）。
    $script:CorsExtraOrigins = @()
    $script:CorsOriginErrors = @()
    foreach ($ao in @($AllowOrigin)) {
        if ($null -eq $ao) { continue }
        if (('' + $ao).Trim().Length -eq 0) { continue }
        $add = Add-AllowedOrigin $ao
        if (-not $add.ok) { $script:CorsOriginErrors = @($script:CorsOriginErrors) + @($add.error) }
    }
    # 工作线程的 runspace 没有人接收信息流，控制台只由主线程写。
    $script:ToConsole = [bool](-not $WorkerMode)
}
Initialize-BridgeRuntime

# ---------------------------------------------------------------- 14. 离线闸门（-SelfTest）
function Invoke-BridgeSelfTest {
    # 纪律与 server.py --selftest 一样：**不联网、不起子进程、不绑端口**。
    # 这里测的是「校验/解析/标注/契约」这些纯逻辑；PNA 预检回显那类必须由真实浏览器
    # 才能证明的行为，写在 MANUAL.md 的实测记录里，不混进闸门。
    $s = @{ total = 0; bad = 0; fails = New-Object System.Collections.ArrayList }
    function CHK {
        param([string]$Name, $Cond, [string]$Detail = '')
        $s.total = $s.total + 1
        if (-not $Cond) {
            $s.bad = $s.bad + 1
            [void]$s.fails.Add($Name + $(if ($Detail) { ' · ' + $Detail } else { '' }))
        }
    }
    $raw = [System.IO.File]::ReadAllText($PSCommandPath, [System.Text.Encoding]::UTF8)

    # ---------- A. 主机名白名单 ----------
    $a1 = Test-LegalHost 'github.com'
    CHK '域名 github.com 通过' ($a1.ok -and $a1.kind -eq 'domain') ("" + $a1.reason)
    $a2 = Test-LegalHost '192.168.2.1'
    CHK 'IPv4 字面量通过' ($a2.ok -and $a2.kind -eq 'ipv4') ("" + $a2.reason)
    $a3 = Test-LegalHost '2001:db8::1'
    CHK 'IPv6 压缩写法通过' ($a3.ok -and $a3.kind -eq 'ipv6') ("" + $a3.reason)
    $a4 = Test-LegalHost 'a-b.example.co'
    CHK '带连字符的标签通过' ($a4.ok) ("" + $a4.reason)
    $a5 = Test-LegalHost ('x' + ('a' * 300))
    CHK '超长主机名（>253）被拒' (-not $a5.ok) ("" + $a5.reason + ' 长度=' + ('x' + ('a' * 300)).Length)
    $a6 = Test-LegalHost (('a' * 64) + '.example.com')
    CHK '超长域名标签（>63）被拒' (-not $a6.ok) ("" + $a6.reason)
    # 这两条不是凑数：PowerShell 的 if 括号里 `>` 是文件重定向，写成 `$lab.Length > 63`
    # 会「永远不成立」而且悄悄在当前目录写出名为 63 的文件——只有正向断言能发现它。
    $gtTrap = @([regex]::Matches($raw, '(?m)(?:^|[\s\}\)])\b(?:if|elseif|while)\s*\((.+?)\)\s*\{') |
        ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -match '\s>\s' -or $_ -match '\s<\s' })
    CHK 'if/while 条件里没有把重定向符当比较用' ($gtTrap.Count -eq 0) (($gtTrap | Select-Object -First 3) -join ' ;; ')
    $evil = @(
        'a;rm -rf /', 'a b', 'a`id`', '$(id)', 'a|b', 'a&&b', 'a>b', "a'b", 'a"h', 'a\b',
        '-h', '..com', '.example.com', 'example.com.', '1.2.3.4.5', '01.2.3.4', '300.1.1.1',
        '2001:db8:::1', ':::1', ('a' + [string][char]0 + 'b'), ("line1" + [string][char]10 + "line2"), 'a..b', 'foo-'
    )
    foreach ($e in $evil) {
        $r = Test-LegalHost $e
        CHK ('拒绝 ' + (One-Line $e 26)) (-not $r.ok) ("" + $r.reason)
    }
    $empty = Test-LegalHost ''
    CHK '空主机名被拒（不是「什么都不做」）' (-not $empty.ok)
    $nul = Test-LegalHost $null
    CHK 'null 主机名被拒' (-not $nul.ok)

    # ---------- B. 坐标类参数一律拒 ----------
    $hits = Get-PositionParamHits @('lat', 'LON', 'Accuracy', 'ip', 'host', 'max_hops', 'source')
    CHK '坐标类参数被点名，大小写不算躲过去' (($hits -join ',') -eq 'accuracy,lat,lon') (($hits -join ','))
    $clean = Get-PositionParamHits @('ip', 'host', 'count', 'timeout', 'upstream_url', 'key', 'max_hops', 'source')
    CHK '桥接真正需要的参数一个都不误伤' ($clean.Count -eq 0) (($clean -join ','))
    foreach ($p in $script:PositionParams) {
        $one = Get-PositionParamHits @($p)
        CHK ('拒收坐标类参数 ' + $p) ($one.Count -eq 1)
    }

    # ---------- C. 目标归属：允许并标注 ----------
    $scopeCases = @{
        '127.0.0.1' = 'lan'; '192.168.2.1' = 'lan'; '10.1.2.3' = 'lan'; '172.20.0.1' = 'lan'
        '169.254.1.1' = 'lan'; '100.64.0.1' = 'lan'; '198.18.0.1' = 'lan'; '0.0.0.0' = 'lan'
        '224.0.0.5' = 'lan'; '240.0.0.1' = 'lan'; '::1' = 'lan'; 'fe80::1' = 'lan'
        'fd12::3' = 'lan'; 'ff02::1' = 'lan'; '8.8.8.8' = 'public'; '140.82.113.4' = 'public'
        '93.184.216.34' = 'public'
    }
    foreach ($k in ($scopeCases.Keys | Sort-Object)) {
        $sc = Get-TargetScope $k @()
        CHK ('归属标注 ' + $k + ' = ' + $scopeCases[$k]) ($sc.scope -eq $scopeCases[$k]) ("" + $sc.note)
    }
    $d1 = Get-TargetScope 'router.internal' @('192.168.1.1')
    CHK '域名解析到内网也算内网（内网 DNS / rebinding 看得见）' ($d1.scope -eq 'lan' -and $d1.note -like '*解析到内网*') ("" + $d1.note)
    $d2 = Get-TargetScope 'example.com' @('93.184.216.34')
    CHK '域名解析到公网算公网' ($d2.scope -eq 'public')
    $d3 = Get-TargetScope 'example.com' @()
    CHK '解析失败不判内网：宁可标错归属，也不给正常追踪添堵' ($d3.scope -eq 'public')
    $d4 = Get-TargetScope '192.168.2.1' @()
    CHK '内网地址给出原因文字（界面要能显示为什么）' ($d4.note.Length -gt 4) ("" + $d4.note)
    CHK '没有「默认拒绝内网」的残留：既没有开关也没有拒绝函数' (-not $raw.Contains(('-' + '-allow-lan' + '-targets')) -and -not $raw.Contains('target' + '_guard'))

    # ---------- D. traceroute / ping 解析器 ----------
    $zh = (@(
        '正在跟踪到 github.com [140.82.113.4] 的网络链接',
        '通过最多 30 个跃点跟踪',
        '',
        '  1     1 ms     1 ms     1 ms  192.168.2.1',
        '  2    12 ms    11 ms    12 ms  10.0.0.1',
        '  3     *        *        *     请求超时。',
        '  4    <1 毫秒   <1 毫秒   <1 毫秒 140.82.113.4',
        '',
        '跟踪完成。'
    )) -join "`r`n"
    $p = Convert-TracerouteText $zh
    CHK '中文 tracert：4 跳（含一跳无响应）' ($p.hops.Count -eq 4) ('实际 ' + $p.hops.Count)
    CHK '中文 tracert：目标 IP 从头部行取出' ($p.target_ip -eq '140.82.113.4') ("" + $p.target_ip)
    CHK '第 3 跳如实标 timeout：没有 RTT、三个星号' ($p.hops[2].timed_out -and $p.hops[2].rtts_ms.Count -eq 0 -and $p.hops[2].star_count -eq 3)
    CHK '第 4 跳的「<1 毫秒」保留为上界而不是测量值' ($p.hops[3].rtt_bounds.Count -eq 3 -and $p.hops[3].rtts_ms.Count -eq 0) ("" + ($p.hops[3].rtt_bounds -join ','))
    CHK '最后一跳的地址就是目标 IP（reached 判定有依据）' ($p.hops[3].ip -eq '140.82.113.4') ("" + $p.hops[3].ip)
    CHK '第 1 跳三个样本都收到' ($p.hops[0].rtts_ms.Count -eq 3)
    CHK '跳号按数值排序（不是字符串序）' ($p.hops[0].hop -eq 1 -and $p.hops[3].hop -eq 4)
    $en = (@(
        'Tracing route to example.com [93.184.216.34] over a maximum of 30 hops:',
        '  1    14 ms    13 ms    14 ms  93.184.216.34',
        '  2     *     request timed out.',
        'Trace complete.'
    )) -join "`r`n"
    $pe = Convert-TracerouteText $en
    CHK '英文 tracert：2 跳，第二跳 timed_out' ($pe.hops.Count -eq 2 -and $pe.hops[1].timed_out) ('跳数 ' + $pe.hops.Count)
    $bsd = (@(
        'traceroute to test (192.0.2.1), 5 hops max, 60 byte packets',
        ' 1  192.0.2.1  0.981 ms  0.842 ms  0.799 ms',
        ' 2  * * *'
    )) -join "`r`n"
    $pb = Convert-TracerouteText $bsd
    CHK 'BSD 风格：* * * 判为无响应，亚毫秒样本照常进 rtts' ($pb.hops.Count -eq 2 -and $pb.hops[1].timed_out -and $pb.hops[0].rtts_ms.Count -eq 3)
    CHK 'BSD 风格：头部圆括号里的 IP 也算目标地址' ($pb.target_ip -eq '192.0.2.1') ("" + $pb.target_ip)
    $named = (@(
        '  2     5 ms     5 ms     5 ms  a-b.example.com [203.0.113.9]'
    )) -join "`r`n"
    $pn = Convert-TracerouteText $named
    CHK '带主机名的行能把主机名抠出来（IP 与 ms 都剔掉）' ($pn.hops[0].hostname -eq 'a-b.example.com' -and $pn.hops[0].ip -eq '203.0.113.9') ("" + $pn.hops[0].hostname + ' / ' + $pn.hops[0].ip)
    $dead = (@(
        '无法访问目标主机。'
    )) -join "`r`n"
    $pd = Convert-TracerouteText $dead
    CHK '解析不出跳就是 0 跳，原文错误行留在 unparsed 里供核对' ($pd.hops.Count -eq 0 -and $pd.unparsed.Count -eq 1) ('unparsed ' + $pd.unparsed.Count)
    CHK '没有 IP 也没有 RTT 的行不会被当成一跳' ($pd.hops.Count -eq 0)
    $pz = (@(
        '正在 Ping github.com [140.82.113.4] 具有 32 字节的数据:',
        '来自 140.82.113.4 的回复: 字节=32 时间=1ms TTL=52',
        '来自 140.82.113.4 的回复: 字节=32 时间=2ms TTL=52',
        '',
        '140.82.113.4 的 Ping 统计信息:',
        '    数据包: 已发送 = 2，已接收 = 2，丢失 = 0 (0% 丢失)，',
        '往返行程的估计时间(以毫秒为单位):',
        '    最短 = 1ms，最长 = 2ms，平均 = 1ms'
    )) -join "`r`n"
    $st = Convert-PingText $pz
    CHK '中文 ping：发送/接收/丢失' ($st.sent -eq 2 -and $st.received -eq 2 -and $st.lost -eq 0) ("" + $st.sent + '/' + $st.received + '/' + $st.lost)
    CHK '中文 ping：丢包率' ($st.loss_percent -eq 0) ("" + $st.loss_percent)
    CHK '中文 ping：最短/最长/平均三项' ($st.min_ms -eq 1 -and $st.max_ms -eq 2 -and $st.avg_ms -eq 1)
    CHK '中文 ping：逐条样本两条' ($st.samples_ms.Count -eq 2)
    CHK '中文 ping：目标 IP' ($st.target_ip -eq '140.82.113.4')
    $pe2 = (@(
        'PING 192.0.2.2 (192.0.2.2): 56 data bytes',
        '--- 192.0.2.2 ping statistics ---',
        '2 packets transmitted, 0 packets received, 100% packet loss'
    )) -join "`r`n"
    $se = Convert-PingText $pe2
    CHK '英文 ping：全丢包也解析到统计，不误报成命令失败' ($se.sent -eq 2 -and $se.received -eq 0 -and $se.loss_percent -eq 100) ("" + $se.sent + '/' + $se.received)
    $pb2 = (@(
        'PING example.com (93.184.216.34): 56 data bytes',
        '64 bytes from 93.184.216.34: icmp_seq=0 ttl=44 time=13.456 ms',
        '--- example.com ping statistics ---',
        '1 packets transmitted, 1 packets received, 0% packet loss',
        'round-trip min/avg/max/stddev = 13.456/13.456/13.456/0.000 ms'
    )) -join "`r`n"
    $sb = Convert-PingText $pb2
    CHK 'BSD ping：round-trip 四件套（含 mdev）' ($sb.min_ms -eq 13.456 -and $sb.avg_ms -eq 13.456 -and $sb.mdev_ms -eq 0) ("" + $sb.min_ms + '/' + $sb.mdev_ms)
    $nostat = Convert-PingText 'nothing useful here'
    CHK 'ping 什么也没解析到就是一串 null，不填 0' ($null -eq $nostat.sent -and $null -eq $nostat.avg_ms -and $nostat.samples_ms.Count -eq 0)

    # ---------- E. 参数夹取与命令参数串 ----------
    CHK 'max_hops 越界夹到 30' ((Convert-SafeInt '999' 20 1 30) -eq 30)
    CHK 'max_hops 非数字回默认值（不抛异常）' ((Convert-SafeInt 'abc' 20 1 30) -eq 20)
    CHK 'max_hops 负数夹到下界' ((Convert-SafeInt '-5' 20 1 30) -eq 1)
    CHK '空值回默认值' ((Convert-SafeInt '' 20 1 30) -eq 20)
    $t1 = Build-TracerouteArgs 'github.com' 20 3
    CHK 'tracert 参数串：禁反解 + 跳数 + 每跳毫秒 + 主机在最后' ($t1 -eq '-d -h 20 -w 3000 "github.com"') $t1
    $t2 = Build-TracerouteArgs 'github.com' 999 99
    CHK '跳数与每跳等待都被夹住' ($t2 -eq '-d -h 30 -w 30000 "github.com"') $t2
    $t3 = Build-PingArgs '192.168.2.1' 99 9
    CHK 'ping 次数上限 10' ($t3 -eq '-n 10 -w 9000 -l 32 "192.168.2.1"') $t3
    CHK '参数串里主机名永远在最后一段' ($t1.EndsWith('"github.com"') -and $t3.EndsWith('"192.168.2.1"'))
    # 响应里的 argv（数组）与执行的参数串必须出自同一套夹取规则，否则页面看到的是「另一套参数」。
    $a1 = Build-TracerouteArgv 'C:\WINDOWS\System32\TRACERT.EXE' 'github.com' 20 3
    CHK 'argv 数组：可执行文件在第一位、主机名在最后一位、没有 shell 元素' `
        ($a1[0] -eq 'C:\WINDOWS\System32\TRACERT.EXE' -and $a1[$a1.Count - 1] -eq 'github.com' -and $a1.Count -eq 7) `
        (($a1 -join ' | '))
    CHK 'argv 数组与参数串给同一组夹取值（-d/-h/-w 一字不差）' `
        ((($a1[1..6]) -join ' ') -eq '-d -h 20 -w 3000 github.com') (($a1[1..6] -join ' '))
    $a2 = Build-TracerouteArgv 'x' 'github.com' 999 99
    CHK 'argv 数组也走同一处夹取（999→30、99s→30000ms）' ($a2[3] -eq '30' -and $a2[5] -eq '30000') (($a2 -join ' '))
    $a3 = Build-PingArgv 'C:\WINDOWS\System32\PING.EXE' '192.168.2.1' 99 9
    CHK 'ping 的 argv 数组：次数上限 10、包长 32、主机名在最后一位' `
        (($a3 -join ' ') -eq 'C:\WINDOWS\System32\PING.EXE -n 10 -w 9000 -l 32 192.168.2.1') (($a3 -join ' '))

    # ---------- F. GeoIP 上游 ----------
    $g1 = New-GeoIpUrl 'ipapi_com' '' ''
    CHK '留空 ip 时用 self URL 查出口 IP' ($g1.url -like 'http://ip-api.com/json/?fields=*') ("" + $g1.url)
    $g2 = New-GeoIpUrl 'ipinfo_io' '8.8.8.8' ''
    CHK '指定 IP 走 {ip} 模板' ($g2.url -eq 'https://ipinfo.io/8.8.8.8/json') ("" + $g2.url)
    $g3 = New-GeoIpUrl 'nonsense' '' ''
    CHK '未知来源被拒：上游 URL 只来自内置表' (-not $g3.url -and $g3.reason.Length -gt 4) ("" + $g3.reason)
    $g4 = New-GeoIpUrl 'ipapi_com' 'github.com' ''
    CHK 'ip 参数不接受域名' (-not $g4.url) ("" + $g4.reason)
    $g5 = New-GeoIpUrl 'ipapi_com' '999.1.1.1' ''
    CHK 'ip 参数必须是合法 IP 字面量' (-not $g5.url) ("" + $g5.reason)
    $g6 = New-GeoIpUrl 'ipapi_com' '' 'https://my.example/proxy?addr=1.2.3.4'
    CHK '自建上游必须含 {ip} 占位符' (-not $g6.url) ("" + $g6.reason)
    $g7 = New-GeoIpUrl 'ipapi_com' '' 'http://127.0.0.1:8765/x/{ip}'
    CHK '自建上游不得指向回环/内网（不能当 SSRF 中继）' (-not $g7.url) ("" + $g7.reason)
    $g8 = New-GeoIpUrl 'ipapi_com' '' 'file:///C:/Windows/win.ini?x={ip}'
    CHK '自建上游只允许 http/https' (-not $g8.url) ("" + $g8.reason)
    $g9 = New-GeoIpUrl 'ipapi_com' '203.0.113.7' 'https://geo.example/{ip}'
    CHK '合法的自建上游放行' ($g9.url -eq 'https://geo.example/203.0.113.7') ("" + $g9.url)
    CHK '来源表 5 家，与 server.py 的 GEOIP_SOURCES 同集（需要 API key 的那家不在这里）' ($script:GeoIpSources.Keys.Count -eq 5)

    # ---------- F2. GeoIP 归一化（喂固定 JSON，不出网） ----------
    # 这一组是「两份桥对同一份上游 JSON 给出同一个形状」的离线证据：
    # 每个用例都写成 JSON 字面量，ConvertFrom-Json 之后走的就是真上游那条路径。
    $n1 = Get-NormalizedGeoIp (ConvertFrom-Json ('{"status":"success","query":"1.2.3.4","lat":39.9289,' +
        '"lon":116.3883,"city":"Beijing","country":"China"}')) 'ipapi_com'
    CHK 'ip-api 正常载荷：坐标/城市/国家都归一到位' `
        ($n1.ok -and $n1.lat -eq 39.9289 -and $n1.lon -eq 116.3883 -and $n1.city -eq 'Beijing' -and $n1.ip -eq '1.2.3.4') ("" + $n1.error)
    CHK '没有精度字段时 accuracy_km 留 null 并标 accuracy_fallback（不编一个圆的）' `
        ($null -eq $n1.accuracy_km -and $n1.accuracy_fallback -eq $true) ("" + $n1.accuracy_km)
    $n2 = Get-NormalizedGeoIp (ConvertFrom-Json '{"status":"fail","message":"invalid query"}') 'ipapi_com'
    CHK '上游自报 fail：ok=false 且把 message 带进 error' `
        (-not $n2.ok -and $n2.error_kind -eq 'field_missing' -and ($n2.error -like '*invalid query*')) ("" + $n2.error)
    $n2b = Get-NormalizedGeoIp (ConvertFrom-Json ('{"status":"Success","lat":1.0,"lon":2.0}')) 'ipapi_com'
    CHK 'status 比较区分大小写（Success 判失败，和 Python 的 != 一样）' (-not $n2b.ok -and $n2b.error_kind -eq 'field_missing') ("" + $n2b.error)
    $n3 = Get-NormalizedGeoIp (ConvertFrom-Json '{"ip":"8.8.8.8","loc":"37.751,-97.822","city":"Dogpatch","country":"US"}') 'ipinfo_io'
    CHK 'ipinfo 的 loc 拆成两个轴（纬度在前）' ($n3.ok -and $n3.lat -eq 37.751 -and $n3.lon -eq -97.822 -and $n3.country -eq 'US') ("" + $n3.error)
    $n4 = Get-NormalizedGeoIp (ConvertFrom-Json '{"ip":"8.8.8.8","loc":"37.751"}') 'ipinfo_io'
    CHK 'loc 没有逗号＝拿不到坐标，报 field_missing 而不是硬凑一个 0' `
        (-not $n4.ok -and $n4.error_kind -eq 'field_missing' -and $null -eq $n4.lat) ("" + $n4.error_kind)
    $n5 = Get-NormalizedGeoIp (ConvertFrom-Json '{"loc":"abc,def"}') 'ipinfo_io'
    CHK 'loc 有逗号但不是实数：field_invalid' (-not $n5.ok -and $n5.error_kind -eq 'field_invalid') ("" + $n5.error)
    $n6 = Get-NormalizedGeoIp (ConvertFrom-Json '{"status":"success","lat":10.5}') 'ipapi_com'
    CHK '只给一个坐标轴：field_invalid（另一个轴字段名不对要说出来，不能当没坐标）' `
        (-not $n6.ok -and $n6.error_kind -eq 'field_invalid') ("" + $n6.error_kind)
    $n7 = Get-NormalizedGeoIp (ConvertFrom-Json '{"status":"success","lat":200.0,"lon":10.0}') 'ipapi_com'
    CHK '纬度越界直接判非法，不把它塞进地图' (-not $n7.ok -and $n7.error_kind -eq 'field_invalid') ("" + $n7.error)
    $n8 = Get-NormalizedGeoIp (ConvertFrom-Json '{"latitude":true,"longitude":1.0}') 'freeipapi'
    CHK '布尔值不当坐标（Python 的 float(True)=1.0 已在 _finite 里一起拒了）' `
        (-not $n8.ok -and $n8.error_kind -eq 'field_invalid') ("" + $n8.error_kind)
    $n9 = Get-NormalizedGeoIp (ConvertFrom-Json '[1,2,3]') 'ipapi_com'
    CHK '上游给数组：json_error（与 Python 的 not isinstance(data, dict) 同义）' `
        (-not $n9.ok -and $n9.error_kind -eq 'json_error') ("" + $n9.error_kind)
    $n10 = Get-NormalizedGeoIp $null 'ipapi_com'
    CHK '上游给 null：json_error 且不抛异常' (-not $n10.ok -and $n10.error_kind -eq 'json_error')
    $n11 = Get-NormalizedGeoIp (ConvertFrom-Json ('{"ip":"1.1.1.1","latitude":1.0,"longitude":2.0,' +
        '"accuracy_radius":20,"city":"X"}')) 'ipapi_co'
    CHK '有精度字段时如实带上并取消 fallback 标记' `
        ($n11.ok -and $n11.accuracy_km -eq 20 -and $n11.accuracy_fallback -eq $false) ("" + $n11.accuracy_km)
    $n12 = Get-NormalizedGeoIp (ConvertFrom-Json ('{"status":"success","lat":1.0,"lon":2.0,"city":""}')) 'ipapi_com'
    CHK '上游真给了空串就返回空串（不翻下一个候选，两份桥才会给同一个值）' `
        ($n12.ok -and $null -ne $n12.city -and ('' + $n12.city).Length -eq 0) ("" + $n12.city)
    $n13 = Get-NormalizedGeoIp (ConvertFrom-Json '{"success":false,"message":"quota"}') 'ipwho_is'
    CHK '布尔 status 源：success=false 判失败' (-not $n13.ok -and $n13.error_kind -eq 'field_missing') ("" + $n13.error)
    $nKeys = @((Get-NormalizedGeoIp (ConvertFrom-Json ('{"status":"success","lat":1.0,"lon":2.0}')) 'ipapi_com').Keys)
    CHK '归一结果固定 11 个键，与 server.py parse_geoip_json 同集' ($nKeys.Count -eq 11) (($nKeys -join ','))
    $nKeysWant = @('accuracy_fallback', 'accuracy_km', 'city', 'country', 'error', 'error_kind',
                   'ip', 'lat', 'lon', 'ok', 'source')
    CHK '归一结果的键名与 server.py 一字不差（顺序不同不算差）' `
        (@($nKeys | Where-Object { $nKeysWant -notcontains $_ }).Count -eq 0 -and
         @($nKeysWant | Where-Object { $nKeys -notcontains $_ }).Count -eq 0) (($nKeys -join ','))

    # ---------- G. 静态路径 ----------
    $root = $script:Root
    $s1 = Convert-StaticPath '/index.html' $root
    CHK '/index.html 映射到项目文件' ($s1.ok -and (Test-Path -LiteralPath $s1.path)) ("" + $s1.reason)
    $s2 = Convert-StaticPath '/../server.py' $root
    CHK '../ 目录穿越被拒' (-not $s2.ok) ("" + $s2.reason)
    $s3 = Convert-StaticPath '/%2e%2e/app' $root
    CHK '先解百分号编码再判 ..（%2e%2e 也拦得住）' (-not $s3.ok) ("" + $s3.reason)
    $s4 = Convert-StaticPath '/.git/config' $root
    CHK '点目录（.git）拒绝' (-not $s4.ok) ("" + $s4.reason)
    $s5 = Convert-StaticPath '/secret.key' $root
    CHK '私钥类扩展名拒绝' (-not $s5.ok) ("" + $s5.reason)
    $s6 = Convert-StaticPath 'C:/Windows/win.ini' $root
    CHK '绝对盘符拒绝' (-not $s6.ok) ("" + $s6.reason)
    $s7 = Convert-StaticPath '//192.168.1.1/x' $root
    CHK 'UNC/双斜杠写法拒绝' (-not $s7.ok) ("" + $s7.reason)
    $s8 = Convert-StaticPath '/app/data/data-cities.js' $root
    CHK '多级子路径正常' ($s8.ok -and (Test-Path -LiteralPath $s8.path)) ("" + $s8.reason)
    $s9 = Convert-StaticPath '/app/../server.py' $root
    CHK '中段 .. 也拒绝（不做「删掉再继续」的静默规范化）' (-not $s9.ok) ("" + $s9.reason)
    $s10 = Convert-StaticPath '/a\b' $root
    CHK '反斜杠分隔符拒绝' (-not $s10.ok)
    $s11 = Convert-StaticPath '/' $root
    CHK '根路径映射到静态根目录' ($s11.ok -and ($s11.path.TrimEnd('\') -eq $root.TrimEnd('\'))) ("" + $s11.path)
    $s12 = Convert-StaticPath '/bridge-powershell.log' $root
    CHK '桥接自己的访问日志不当静态资源发出去（里面是原样请求行）' (-not $s12.ok) ("" + $s12.reason)
    # 存在性检查必须在取属性之前：GetAttributes 对不存在的路径抛异常，会把 404 变成 500。
    $iExist = $raw.IndexOf('-LiteralPath $target)')
    $iAttr = $raw.IndexOf("`$attrs = [System.IO.File]::GetAttributes")
    CHK '静态请求先判存在再取属性（否则 404 会变成 500）' ($iExist -ge 0 -and $iAttr -ge 0 -and $iExist -lt $iAttr) ('' + $iExist + '/' + $iAttr)

    # ---------- H. /api 契约（页面不区分两份实现） ----------
    $h = Get-HealthPayload
    CHK 'server/version 与 server.py 同名同义' ($h.server -eq 'geonet-bridge' -and $h.version -eq '1.0.0')
    CHK 'health 里没有 python 版本号：PowerShell 实现不冒充 Python' ($null -eq $h.python -and ($h.runtime -like 'PowerShell*')) ("" + $h.python)
    CHK 'platform 由本机算出来，不写死（这份桥在装了 pwsh 的 mac/Linux 上也要说实话）' `
        ($h.platform -eq $script:PlatformName -and @('win32', 'posix') -contains $h.platform) ("" + $h.platform)
    $extraCaps = @($h.capabilities | Where-Object { @('traceroute', 'ping', 'dns', 'iface', 'geoip', 'static') -notcontains $_ })
    CHK '能力清单里没有没实现的东西' ($extraCaps.Count -eq 0) (($extraCaps -join ','))
    foreach ($need in @('dns', 'iface', 'geoip', 'static')) {
        CHK ('能力清单声明 ' + $need) ($h.capabilities -contains $need)
    }
    CHK 'bind.loopback_only 为真' ($h.bind.loopback_only -eq $true)
    CHK 'limits.shell 恒为 false' ($h.limits.shell -eq $false)
    CHK 'privacy.position_params_accepted 恒为 false' ($h.privacy.position_params_accepted -eq $false)
    CHK 'privacy.lan_targets_allowed 如实声明 true（允许并标注）' ($h.privacy.lan_targets_allowed -eq $true)
    CHK 'banned_params 13 项' ($h.privacy.banned_params.Count -eq 13) ("" + $h.privacy.banned_params.Count)
    CHK '端点清单 6 条，与 server.py 同集' ($h.endpoints.Count -eq 6)
    $hr = ConvertFrom-Json (To-Json $h)
    CHK 'health 经 JSON 往返后字段仍在（前端按名字取）' ($hr.privacy.banned_params.Count -eq 13 -and $hr.bind.loopback_only -eq $true)
    # 契约核对：页面拿到的是「哪个桥」不该影响它读到什么字段，所以键集合必须一字不差。
    $hWant = @($script:BridgeContract['/api/health'])
    $hOff = @(@($h.Keys | Where-Object { $hWant -notcontains $_ }) +
              @($hWant | Where-Object { -not $h.ContainsKey($_) }))
    CHK 'health 的键集合与 $BridgeContract 完全相同（不多不少）' ($hOff.Count -eq 0) (($hOff -join ','))
    # 清单里带查询串示例（'/api/ping?host=&count='），取 ? 之前的路径再比。
    $hPaths = @($h.endpoints | ForEach-Object { ('' + $_).Split(@('?'))[0] })
    $cOff = @(@($hPaths | Where-Object { -not $script:BridgeContract.ContainsKey($_) }) +
              @($script:BridgeContract.Keys | Where-Object { $hPaths -notcontains $_ }))
    CHK '契约覆盖的端点与 health.endpoints 同集（6 条，一条不多一条不少）' `
        ($script:BridgeContract.Keys.Count -eq 6 -and $cOff.Count -eq 0) (($cOff -join ','))
    $tr = ConvertFrom-Json (To-Json @{ hops = $p.hops; hop_count = $p.hops.Count })
    CHK '跳对象经 JSON 往返后 rtts_ms 仍是数组' ($tr.hops[0].rtts_ms -is [array] -and $tr.hops[0].rtts_ms.Count -eq 3)
    CHK 'ConvertTo-Json 深度够用（第三层数组不塌成字符串）' ($tr.hops[3].rtt_bounds.Count -eq 3)
    $er = ConvertFrom-Json (To-Json @{ hops = @(); error_kind = $null })
    CHK '0 跳也如实给空数组、null 字段不乱码' ($er.hops.Count -eq 0 -and $null -eq $er.error_kind)
    # /api/iface 的脱敏是隐私红线的一部分（白名单里的 file:// 与托管页照样读得到）：
    # 允许出现的键是白名单，主机名/网卡名/内网地址一个都不许出现在序列化结果里。
    $if1 = Get-IfaceSummary
    $ifJson = To-Json $if1
    $allowKeys = @($script:BridgeContract['/api/iface'])
    $leaky = @($if1.Keys | Where-Object { $allowKeys -notcontains $_ })
    CHK 'iface 只回白名单里的键（没有 names/addresses/hostname）' ($leaky.Count -eq 0) (($leaky -join ','))
    $hostName = '' + [System.Net.Dns]::GetHostName()
    $hostLeak = if ($hostName.Length -ge 2) { $ifJson.IndexOf($hostName) -ge 0 } else { $false }
    CHK 'iface 回的 JSON 里不含本机主机名' (-not $hostLeak) ('主机名=' + (Cut $hostName 30) + ' · ' + (Cut $ifJson 100))
    CHK 'iface 声明了 4 类被脱敏字段' (@($if1.redacted_fields).Count -eq 4 -and $if1.interface_count -gt 0) ("" + $if1.interface_count)
    # 契约里的 error/error_kind 只在枚举失败时出现，所以成功响应核对的是「其余键一个不缺」。
    $ifWant = @($script:BridgeContract['/api/iface'] | Where-Object { $_ -notin @('error', 'error_kind') })
    $ifMissing = @($ifWant | Where-Object { -not $if1.ContainsKey($_) })
    CHK 'iface 的成功响应键与契约的必有部分一字不差（缺一个页面就少一项事实）' `
        (@($ifMissing).Count -eq 0 -and $if1.Keys.Count -eq $ifWant.Count) (($ifMissing -join ','))

    # ---------- I. 只读与安全红线 ----------
    CHK '不做字符串求值' (-not $raw.Contains('Invoke-' + 'Expression'))
    CHK '不启动命令解释器' (-not $raw.Contains('cmd.' + 'exe'))
    CHK '不用会走 shell 的启动方式' (-not $raw.Contains('Start-' + 'Process '))
    # needle 全部用拼接：把「等号右边写真值」那条字串原样写进这一行，
    # 就会让「文件里不存在这条字串」的断言被自己的检查文本误伤（第一版就栽在这里）。
    $nFalse = 'UseShellExecute = $' + 'false'
    $nTrue = 'UseShellExecute = $' + 'true'
    CHK ('子进程一律 UseShellExecute = $' + 'false') ($raw.Contains($nFalse) -and -not $raw.Contains($nTrue))
    $idxPrivacy = $raw.IndexOf('Get-PositionParamHits $keys')
    $idxRoute = $raw.IndexOf('switch ($name)')
    CHK '隐私闸在路由分发之前（先拒坐标，再谈端点）' ($idxPrivacy -ge 0 -and $idxRoute -gt $idxPrivacy)
    CHK '非回环绑定被拒：0.0.0.0 / :: / 局域网段都不给' (-not (Test-LoopbackBind '0.0.0.0').ok -and -not (Test-LoopbackBind '::').ok -and -not (Test-LoopbackBind '192.168.2.7').ok)
    CHK '回环写法被允许：127.x / localhost / ::1' ((Test-LoopbackBind '127.0.0.1').ok -and (Test-LoopbackBind '127.5.6.7').ok -and (Test-LoopbackBind 'localhost').ok -and (Test-LoopbackBind '::1').ok)
    # 来源地址守卫。绑定参数只接受回环 ≠ 只有回环能连上：HttpListener 的前缀是按 **Host 头**
    # 分派的，而 http.sys 把这个端口开在所有网卡上。我们为了让 http://localhost:8765/ 能用而加的
    # localhost 前缀，实测被局域网请求命中过（curl http://192.168.2.140:8797/api/health
    # -H 'Host: localhost' 返回 200）。所以这句话只能由 RemoteEndPoint 来守。
    $ctxLan = @{ Request = @{ RemoteEndPoint = @{ Address = [System.Net.IPAddress]::Parse('192.168.2.140') } } }
    $ctxLo = @{ Request = @{ RemoteEndPoint = @{ Address = [System.Net.IPAddress]::Parse('127.0.0.1') } } }
    $ctxLo6 = @{ Request = @{ RemoteEndPoint = @{ Address = [System.Net.IPAddress]::Parse('::1') } } }
    $ctx127x = @{ Request = @{ RemoteEndPoint = @{ Address = [System.Net.IPAddress]::Parse('127.5.6.7') } } }
    $ctxNone = @{ Request = @{ } }
    CHK '回环来源放行：127.0.0.1 / ::1 / 127 整段' ((Test-LoopbackPeer $ctxLo).ok -and (Test-LoopbackPeer $ctxLo6).ok -and (Test-LoopbackPeer $ctx127x).ok) (
        'lo=' + (Test-LoopbackPeer $ctxLo).ok + ' lo6=' + (Test-LoopbackPeer $ctxLo6).ok + ' 127x=' + (Test-LoopbackPeer $ctx127x).ok)
    CHK '局域网来源被拒（哪怕 Host 头写成 localhost）' (-not (Test-LoopbackPeer $ctxLan).ok) ('' + (Test-LoopbackPeer $ctxLan).peer)
    CHK '拿不到来源地址也按拒绝处理（fail-closed，不是放行）' (-not (Test-LoopbackPeer $ctxNone).ok) ('peer=[' + (Test-LoopbackPeer $ctxNone).peer + ']')
    # 文本判定单独测一遍：这条链上最容易出的错是「5.1 上实例属性取不到 → 全判非回环 → 自己锁死」，
    # 上面三条虽然能抓到，但真机上 403 一片时没人想到是这里，所以再钉一次具体的对/错集合。
    $okText = @('127.0.0.1', '127.5.6.7', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::1]')
    $badText = @('192.168.2.140', '100.66.176.1', '10.0.0.5', '169.254.169.254', 'fe80::1%eth0', '', 'not-an-ip', '0.0.0.0')
    CHK '回环文本判定覆盖 127 段/::1/映射写法' (@($okText | Where-Object { -not (Test-LoopbackIpText $_) }).Count -eq 0) (
        (@($okText | Where-Object { -not (Test-LoopbackIpText $_) }) -join ','))
    CHK '公网/链路本地/空串/垃圾全部判非回环' (@($badText | Where-Object { Test-LoopbackIpText $_ }).Count -eq 0) (
        (@($badText | Where-Object { Test-LoopbackIpText $_ }) -join ','))
    # 实例属性写法在 5.1 上取到空值（这行用拼接写，免得 needle 自己命中自己）
    $needleProp = ('$ip' + '.IsLoopback')
    CHK '不依赖 .NET Core 才有的实例属性 IsLoopback（5.1 上它是空）' (-not $raw.Contains($needleProp))
    $iGuard = $raw.IndexOf('$peer = Test-LoopbackPeer $Ctx')
    $iMethod = $raw.IndexOf("HttpMethod -eq 'OPTIONS'")
    $iPrivacy = $raw.IndexOf('Get-PositionParamHits $keys')
    CHK '来源守卫排在方法判断与坐标校验之前（不是挂在某个端点上）' (
        $iGuard -ge 0 -and $iMethod -gt $iGuard -and $iPrivacy -gt $iGuard) ('' + $iGuard + '/' + $iMethod + '/' + $iPrivacy)
    CHK '非回环给的是 403 + not_loopback（不是 500，也不是静默断开）' ($raw.Contains("-Kind 'not_loopback'") -and $raw.Contains('-Code 403'))
    # ---------- I2. 跨站来源白名单（与 server.py 的 G 段逐条同集） ----------
    CHK '白名单：file:// 的 null 与官方托管页放行（大小写不敏感）' `
        ((Test-OriginAllowed 'null') -and (Test-OriginAllowed 'https://iammezsh.github.io') -and (Test-OriginAllowed 'HTTPS://IAMMEZSH.GitHub.IO'))
    $originOk = @('http://127.0.0.1:8765', 'http://127.0.0.1', 'https://127.0.0.1:8443',
                  'http://localhost:9000', 'http://LOCALHOST:1', 'http://[::1]:8765',
                  'http://[::ffff:127.0.0.1]:8765')
    $originBad = @('https://evil.example', 'http://127.0.0.1.evil.com', 'https://iammezsh.github.io.evil.com',
                   'https://not-iammezsh.github.io', 'http://10.0.0.5:8765', 'http://192.168.2.1:8765',
                   'http://[::ffff:8.8.8.8]:8765', 'http://[2001:db8::1]', 'http://127.1:8765',
                   'null.com', '//iammezsh.github.io', 'https://iammezsh.github.io:443.evil.cn',
                   'http://localhost.evil.cn', 'http://evil@127.0.0.1:8765', 'http://127.0.0.1:8765/api/health',
                   'http://127.0.0.1:8765?u=https://evil.example')
    $leaked = @($originOk | Where-Object { -not (Test-OriginAllowed $_) })
    CHK ('白名单：回环来源（含任意端口与 IPv6 方括号写法）全部放行（' + $originOk.Count + ' 例）') `
        ($leaked.Count -eq 0) (($leaked -join ','))
    $wrongly = @($originBad | Where-Object { Test-OriginAllowed $_ })
    CHK ('白名单：任意网页与内网非回环来源一律拒绝（' + $originBad.Count + ' 例，含前缀伪装）') `
        ($wrongly.Count -eq 0) ('误放：' + (($wrongly -join ',')))
    CHK '没有 Origin 头时照常服务（启动器探测与 curl 不受 CORS 影响）' `
        ((Test-OriginAllowed '') -and (Test-OriginAllowed $null) -and (Test-OriginAllowed '   '))
    CHK '-AllowOrigin 只收完整 origin，写法不对就报错' `
        ((Add-AllowedOrigin 'https://maps.example.com').ok -and (Test-OriginAllowed 'https://maps.example.com') `
         -and -not (Add-AllowedOrigin 'maps.example.com').ok -and -not (Add-AllowedOrigin 'https://example.com/a?b=1').ok `
         -and -not (Add-AllowedOrigin '').ok)
    $script:CorsExtraOrigins = @()      # 别把这条临时项留给后面的判定
    CHK '追加名单清空后不再放行（-AllowOrigin 只在启动时生效，运行期不会被网页自己加宽）' `
        (-not (Test-OriginAllowed 'https://maps.example.com'))
    CHK '回环 origin 的主机判定不被简写与伪装域名骗过' (
        (-not (Test-LoopbackOriginHost '127.1')) -and (-not (Test-LoopbackOriginHost '127.0.0.1.evil.com')) -and
        (Test-LoopbackOriginHost '127.5.6.7') -and (Test-LoopbackOriginHost 'localhost') -and
        (Test-LoopbackOriginHost '[::1]') -and (-not (Test-LoopbackOriginHost '[::ffff:8.8.8.8]')) -and
        (-not (Test-LoopbackOriginHost '[2001:db8::1]')) -and (-not (Test-LoopbackOriginHost 'localhost.evil.cn')))
    CHK 'authority 拆分挡住伪装（端口必须纯数字、方括号必须成对）' (
        ($null -eq (Split-OriginAuthority 'iammezsh.github.io:443.evil.cn')) -and
        ($null -eq (Split-OriginAuthority 'a]b')) -and ($null -eq (Split-OriginAuthority '')) -and
        ((Split-OriginAuthority '[::1]:8765').port -eq '8765') -and
        ((Split-OriginAuthority '[::1]').host -eq '[::1]') -and ((Split-OriginAuthority 'x:80').port -eq '80'))
    # needle 用拼接构造：把要禁的那行原样写进检查里，$raw 就会命中自己的检查文本（老坑）。
    $dollar = [string][char]36
    $wcBare = "AddHeader('Access-Control-Allow-" + 'Origin' + "', '*')"
    $echoVar = "Allow-" + 'Origin' + "', " + $dollar + 'origin)'
    $echoPre = "Allow-" + 'Origin' + "', " + $dollar + 'preOrigin)'
    CHK '响应里不再出现通配 `Access-Control-Allow-Origin: *`（改成回显名单内的来源）' `
        (-not $raw.Contains($wcBare))
    CHK '两条 API 响应路径都把名单内的来源原样回显（实请求与预检各一处）' `
        ($raw.IndexOf($echoVar) -ge 0 -and $raw.IndexOf($echoPre) -ge 0)
    CHK '回显来源时一起给 Vary: Origin（否则共享缓存会把别人的响应喂给你）' (
        (@([regex]::Matches($raw, [regex]::Escape("AddHeader('Vary', 'Origin" + "')"))).Count -ge 2)) (
        '' + @([regex]::Matches($raw, [regex]::Escape("AddHeader('Vary', 'Origin" + "')"))).Count)
    $kindNeedle = "-Kind 'origin_not_" + "allowed'"
    CHK '预检与实请求走同一张名单（两处都有 403 分支）' (
        (@([regex]::Matches($raw, [regex]::Escape($kindNeedle))).Count -ge 2)) (
        '' + @([regex]::Matches($raw, [regex]::Escape($kindNeedle))).Count)
    CHK '来源闸在坐标闸之后、端点路由之前（预检与实请求同一顺序）' `
        ($raw.IndexOf('Get-PositionParamHits $keys') -lt $raw.IndexOf('$reqOrigin = Get-RequestOrigin $Ctx') -and
         $raw.IndexOf('$reqOrigin = Get-RequestOrigin $Ctx') -lt $raw.IndexOf('switch ($name)'))
    CHK '工作线程拿到同一份名单（dot-source 带上 -AllowOrigin，否则主线程放行、线程 403）' `
        ($raw.Contains('$originTail') -and $raw.Contains("' -AllowOrigin '"))
    $hCors = $h.cors_policy
    CHK 'health 如实声明 CORS 策略（wildcard=false、内置名单两条、附加名单为空）' `
        ($hCors.wildcard -eq $false -and @($hCors.built_in).Count -eq 2 -and ($hCors.built_in -contains 'null') `
         -and ($hCors.built_in -contains 'https://iammezsh.github.io') -and @($hCors.extra).Count -eq 0 `
         -and $hCors.loopback_origins_allowed -eq $true -and $hCors.no_origin_clients_allowed -eq $true) (
        (To-Json $hCors))
    $stStart = $raw.IndexOf('function Invoke-BridgeSelfTest')
    # 取到文件末尾而不是固定 9000 字：截一段等于给后面的漏网之鱼留了位置。
    $stSlice = if ($stStart -ge 0) { $raw.Substring($stStart) } else { '' }
    CHK '自检不启动子进程、不联网（没有外部命令与上游调用）' (-not $stSlice.Contains('Start-' + 'CapturedProcess') -and -not $stSlice.Contains('Invoke-Json' + 'Fetch'))
    # 类型名拼错在 PowerShell 里是「非终止错误」：属性赋值失败照样往下跑，服务照常监听，
    # 但一个工作线程也没有——每个请求都在队列里等到超时，看起来像「桥接没反应」而不是「启动失败」。
    $typeNames = @([regex]::Matches($raw, '\[(System\.[A-Za-z0-9_.]+(?:\[object\])?)\]') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    $unresolved = @($typeNames | Where-Object { $null -eq ($_ -as [type]) })
    CHK ('文件里写到的 .NET 类型名全部能解析（扫到 ' + $typeNames.Count + ' 个）') ($typeNames.Count -ge 8 -and $unresolved.Count -eq 0) ($unresolved -join ', ')
    $tailStart = $raw.LastIndexOf('$worker' + 'Handles = @()')
    $tailSlice = if ($tailStart -ge 0) { $raw.Substring($tailStart) } else { '' }
    # 实测比读文本可靠：这里真的建一个（不 Open、不起线程的）runspace，按启动段用的同样的
    # 名字赋值，让本机告诉我们 5.1 / 7 哪一边认这个名字。
    $rsProbe = $null
    $probeErr = ''
    $probeThread = ''
    $probeApt = ''
    try {
        $ErrorActionPreference = 'Stop'
        $rsProbe = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $rsProbe.ThreadOptions = 'ReuseThread'
        $rsProbe.ApartmentState = 'STA'
        $probeThread = '' + $rsProbe.ThreadOptions
        $probeApt = '' + $rsProbe.ApartmentState
    } catch { $probeErr = $_.Exception.Message } finally { $ErrorActionPreference = 'Continue' }
    try { if ($rsProbe) { $rsProbe.Dispose() } } catch { }
    CHK '工作线程枚举名在本机可赋值（5.1 与 7 的类型名不同，所以按名字赋）' (
        $probeThread -eq 'ReuseThread' -and $probeApt -eq 'STA' -and
        $tailSlice.Length -gt 200 -and $tailSlice.Contains(".ThreadOptions = '" + "ReuseThread'")) (($probeThread + '/' + $probeApt + ' ') + $probeErr)
    CHK '启动段建线程失败会拒绝启动，而不是留下一个没人处理请求的空壳' (
        $tailSlice.Contains('exit 5') -and $tailSlice.Contains('$worker' + 'Handles.Count -lt 1'))

    # ---------- J. 并发上限 ----------
    $saveWorkers = $script:Workers
    $saveBusy = $script:Busy
    $script:Workers = 2
    $busy = [System.Collections.Concurrent.ConcurrentQueue[object]]::new()
    $script:Busy = $busy
    $busy.Enqueue([pscustomobject]@{ t = 1 })
    $busy.Enqueue([pscustomobject]@{ t = 2 })
    $blocked = Enter-BusyRegion { @{ ok = $true; stdout = '不该跑到这里' } }
    CHK '并发到上限先挡回来，而不是把机器变成 tracert 发射台' ($blocked.error_kind -eq 'busy' -and $blocked.busy -and -not $blocked.ok) ("" + $blocked.error)
    $dropped = $null
    [void]$busy.TryDequeue([ref]$dropped)
    $passed = Enter-BusyRegion { @{ ok = $true; stdout = '放行' } }
    CHK '腾出一个位置后立刻放行' ($passed.ok -eq $true)
    [void]$busy.TryDequeue([ref]$dropped)
    $script:Workers = $saveWorkers
    $script:Busy = $saveBusy

    Write-Host ''
    Write-Host ('桥接（PowerShell）自检：' + $s.total + ' 项 / ' + $s.bad + ' 失败')
    foreach ($f in @($s.fails | Select-Object -First 10)) { Write-Host ('  FAIL · ' + $f) }
    return $s
}

# 工作线程只要函数定义；到这里就返回，由调用方进入取队列的循环。
if ($WorkerMode) { return }

if ($SelfTest) {
    # 闸门名是中文：把控制台输出编码切到 UTF-8，Node/CI 才能按 UTF-8 读，不至于满屏乱码。
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    $r = Invoke-BridgeSelfTest
    if ($r.bad -gt 0) { exit 1 } else { exit 0 }
}

# ---------------------------------------------------------------- 15. 启动
$bind = Test-LoopbackBind $script:BindHost
if (-not $bind.ok) {
    Write-Host ('[拒绝启动] ' + $bind.reason)
    exit 2
}
if (@($script:CorsOriginErrors).Count -gt 0) {
    # 名单写歪了不许「忽略掉这一条继续跑」：那样用户以为自己加了内网镜像，实际每个请求都 403。
    foreach ($e in @($script:CorsOriginErrors)) { Write-Host ('[拒绝启动] ' + $e) }
    Write-Host '           正确写法：-AllowOrigin https://内网镜像域名 或 -AllowOrigin http://127.0.0.1:8765'
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'index.html'))) {
    Write-Host ('[拒绝启动] 静态根目录里没有 index.html：' + $script:Root)
    exit 2
}

# 端口已有监听者就拒绝再起一个：Windows 的 SO_REUSEADDR 允许重复绑定，
# 两个服务并存时请求被随机分走，你会以为「改了代码没生效」。
$probe = New-Object System.Net.Sockets.TcpClient
try {
    $iar = $probe.BeginConnect('127.0.0.1', $script:Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(1200) -and $probe.Connected) {
        Write-Host ('[拒绝启动] 端口 ' + $script:Port + ' 已经有服务在听（多半是 server.py 或另一个桥接）。')
        Write-Host '           用同一个端口就好，或者换一个：-Port 9000'
        exit 3
    }
} catch { } finally { try { $probe.Close() } catch { } }

$listener = New-Object System.Net.HttpListener
$prefixes = @('http://' + $script:BindHost + ':' + $script:Port + '/')
if ($script:BindHost -eq '127.0.0.1') { $prefixes += 'http://localhost:' + $script:Port + '/' }
foreach ($p in $prefixes) { $listener.Prefixes.Add($p) }
try { $listener.Start() } catch {
    Write-Host ('[拒绝启动] HttpListener 起不来：' + $_.Exception.Message)
    Write-Host '           回环前缀普通用户即可绑定；若这里报「拒绝访问」，多半是端口被系统保留（netsh interface ipv4 show excludedportrange protocol=tcp）'
    exit 4
}

# 泛型集合用 ::new()：New-Object 带类型参数的构造重载在 5.1 上不稳定（「找不到构造函数」）。
$RequestQueue = [System.Collections.Concurrent.BlockingCollection[object]]::new(16)
$BusyQueue = [System.Collections.Concurrent.ConcurrentQueue[object]]::new()

$workerHandles = @()
$dotPath = $PSCommandPath
try {
    # 建线程这一段用 Stop：属性名写错时 PowerShell 默认只报「非终止错误」，
    # 于是监听器照常起来、一个工作线程都没有，每个请求都在队列里等到超时——
    # 现象看起来完全不像启动失败，只会让人以为「桥接没反应」。
    $ErrorActionPreference = 'Stop'
    for ($i = 1; $i -le $script:Workers; $i++) {
        $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        # 这两个枚举按「成员名字符串」赋值，不写类型强转：Windows PowerShell 5.1 的
        # ThreadOptions 属性类型是 System.Management.Automation.Runspaces.PSThreadOptions，
        # PowerShell 7 改成了 System.Threading.ThreadOptions —— 强转会在一边上 TypeNotFound，
        # 而属性 setter 收字符串时 PowerShell 自己按名字转，两边都成立。
        $rs.ThreadOptions = 'ReuseThread'
        $rs.ApartmentState = 'STA'
        $rs.Open()
        $psb = [System.Management.Automation.PowerShell]::Create()
        $psb.Runspace = $rs
        # dot-source 自己（-WorkerMode 让它只定义函数就返回），然后进入取队列的循环。
        # 配置项按值传进去，$Queue/$Busy 按引用传进 $args——同一进程内的 runspace 共享对象引用。
        # -LogFile 必须一起传：工作线程才是真正写日志的人（请求在它们手里处理完）。
        $qRoot = ('' + $script:Root).Replace("'", "''")
        $qBind = ('' + $script:BindHost).Replace("'", "''")
        $qLog = ('' + $script:LogFile).Replace("'", "''")
        # -AllowOrigin 必须一起传：真正处理请求的是工作线程，漏了它主线程放行、工作线程 403，
        # 现象是「同一个端点有时能用有时不能用」，取决于请求落到哪一边。
        $originTail = ''
        foreach ($ao in @($script:CorsExtraOrigins)) {
            $originTail += $(if ($originTail.Length -gt 0) { ',' } else { ' -AllowOrigin ' }) + "'" + ('' + $ao).Replace("'", "''") + "'"
        }
        $text = ". '$dotPath' -WorkerMode -Port $script:Port -BindHost '$qBind' -Root '$qRoot' -Workers $script:Workers -LogFile '$qLog'" + $originTail +
                $(if ($script:Quiet) { ' -Quiet' } else { '' }) + '; Start-BridgeWorkerLoop $args[0] $args[1]'
        [void]$psb.AddScript($text)
        [void]$psb.AddArgument($RequestQueue)
        [void]$psb.AddArgument($BusyQueue)
        $workerHandles += [pscustomobject]@{ Runspace = $rs; PowerShell = $psb; Handle = $psb.BeginInvoke() }
    }
} catch {
    Write-Host ('[拒绝启动] 工作线程创建失败：' + $_.Exception.Message)
    Write-Host '           宁可不监听，也不要开一个「谁都不处理请求」的空壳服务。'
    try { $listener.Stop(); $listener.Close() } catch { }
    exit 5
} finally {
    $ErrorActionPreference = 'Continue'
}
if ($workerHandles.Count -lt 1) {
    Write-Host '[拒绝启动] 一个工作线程都没有（Workers 被夹到 0？），不进入接受循环。'
    try { $listener.Stop(); $listener.Close() } catch { }
    exit 5
}

Write-Host ('[就绪] 经纬度定位工作站 · PowerShell 桥接 ' + $script:Version + '（' + $script:RuntimeName + '）')
foreach ($p in $prefixes) { Write-Host ('       监听 ' + $p) }
Write-Host ('       静态根 ' + $script:Root + ' · 工作线程 ' + $script:Workers + ' 个 · 只读 GET · 不经 shell · 不接收坐标')
Write-Host ('       页面地址： http://127.0.0.1:' + $script:Port + '/index.html') -ForegroundColor Green
Write-Host '       关掉这个窗口就是停止桥接。'
if ($script:LogFile) { Write-Host ('       日志： ' + $script:LogFile) }

try {
    # 一次只挂一个 BeginGetContext，并且超时后继续等同一个 IAsyncResult。
    # 早期写法每轮（1 秒）都重新 BeginGetContext 一次：上一轮的挂起请求被弃在不认识的
    # 句柄上，EndGetContext 再也没机会拿到它——现象是 TCP 连得上、永远不返回，
    # 而且日志里一个字都没有（请求根本没进工作线程）。
    $iar = $null
    while ($listener.IsListening) {
        if ($null -eq $iar) { $iar = $listener.BeginGetContext($null, $null) }
        if (-not $iar.AsyncWaitHandle.WaitOne(1000)) { continue }
        $ctx = $null
        try { $ctx = $listener.EndGetContext($iar) } catch { $iar = $null; continue }   # Stop()/关闭时的正常异常
        $iar = $null
        if ($null -eq $ctx) { continue }
        $added = $false
        try { $added = $RequestQueue.TryAdd($ctx, 500) } catch { $added = $false }
        if (-not $added) {
            try {
                Write-BridgeFail -Ctx $ctx -Code 429 -Error ('等待队列已满（' + $script:Workers + ' 个工作线程都在跑，队列 16 条也满了），请稍后重试') -Kind 'busy'
                $ctx.Response.Close()
            } catch { }
        }
    }
} finally {
    try { $RequestQueue.CompleteAdding() } catch { }
    # 不再额外投 STOP：CompleteAdding 之后阻塞中的 Take() 自己抛 InvalidOperationException，
    # 工作循环的 catch 就是退出条件（投 STOP 反而会被拒绝并吞掉异常，白写一行）。
    foreach ($w in $workerHandles) {
        try { [void]$w.PowerShell.EndInvoke($w.Handle) } catch { }
        try { $w.PowerShell.Dispose() } catch { }
        try { $w.Runspace.Dispose() } catch { }
    }
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
}
