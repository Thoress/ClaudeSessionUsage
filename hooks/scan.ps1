# Prints one line per model response in the listed transcripts, tab-separated:
# file, timestamp, message id, model, input, cache read, cache write,
# 5-minute write, 1-hour write, output tokens. Lets the plugin read a week of
# transcripts (hundreds of MB, mostly tool output) as a few MB.
param([string]$ListFile)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$files = Get-Content -LiteralPath $ListFile -Encoding UTF8
$keys = 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens', 'output_tokens'
$num = @{}
foreach ($k in $keys) { $num[$k] = [regex]('"' + $k + '":(\d+)') }
$ts = [regex]'"timestamp":"([^"]+)"'
$id = [regex]'"id":"(msg_[^"]+)"'
$model = [regex]'"model":"([^"]+)"'
foreach ($m in (Select-String -LiteralPath $files -SimpleMatch '"output_tokens"')) {
  $l = $m.Line
  if ($l.IndexOf('"type":"assistant"') -lt 0) { continue }
  $at = $l.IndexOf('"usage":')
  if ($at -lt 0) { continue }
  $u = $l.Substring($at, [Math]::Min(4000, $l.Length - $at))
  $vals = foreach ($k in $keys) { $x = $num[$k].Match($u); if ($x.Success) { $x.Groups[1].Value } else { '' } }
  $m.Path + "`t" + $ts.Match($l).Groups[1].Value + "`t" + $id.Match($l).Groups[1].Value + "`t" + $model.Match($l).Groups[1].Value + "`t" + ($vals -join "`t")
}
