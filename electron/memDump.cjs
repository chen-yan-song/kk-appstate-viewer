'use strict';
/**
 * Windows：导出 KakaoTalk 进程已提交内存（PowerShell P/Invoke）
 * 结构体布局对齐 kakao-chat-viewer 已验证脚本（RegionSize 用 IntPtr，避免 UIntPtr 强转失败）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeDumpScript(dir) {
  const ps1 = path.join(dir, 'kk-asv-memdump.ps1');
  // 注意：无中文注释；必须带 UTF-8 BOM，避免 PS5.1 按 ANSI 误解析
  const script = String.raw`
param([int]$TargetPid, [string]$OutFile, [switch]$PrivateOnly)
$sig = @"
using System;
using System.Runtime.InteropServices;
public class KkvMemAsv {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION info, int len);
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public IntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }
}
"@
Add-Type -TypeDefinition $sig
$h = [KkvMemAsv]::OpenProcess(0x0410, $false, $TargetPid)
if ($h -eq [IntPtr]::Zero) { Write-Error ("OpenProcess failed pid=" + $TargetPid); exit 1 }
$buf = New-Object byte[] 16777216
$read = 0
$addr = [IntPtr]::Zero
$commitCount = 0
$matchedCount = 0
$totalBytes = [long]0
$fs = [System.IO.File]::Create($OutFile)
try {
  while ($true) {
    $mbi = New-Object KkvMemAsv+MEMORY_BASIC_INFORMATION
    $ret = [KkvMemAsv]::VirtualQueryEx($h, $addr, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi))
    if ($ret -eq [IntPtr]::Zero) { break }
    $region = [int64]$mbi.RegionSize
    if ($region -le 0) { break }
    if ($mbi.State -eq 0x1000 -and $region -le 268435456) {
      $commitCount++
      $prot = [int]$mbi.Protect
      $readable = (($prot -band 0xEE) -ne 0) -and (($prot -band 0x100) -eq 0) -and ($prot -ne 1)
      $privateOk = (-not $PrivateOnly) -or ($mbi.Type -eq 0x20000) -or ($mbi.Type -eq 0)
      if ($readable -and $privateOk) {
        $matchedCount++
        $remain = $region
        $cur = [int64]$mbi.BaseAddress
        while ($remain -gt 0) {
          $take = [int][Math]::Min($remain, $buf.Length)
          $ok = [KkvMemAsv]::ReadProcessMemory($h, [IntPtr]$cur, $buf, $take, [ref]$read)
          if ($ok -and $read -gt 0) { $fs.Write($buf, 0, $read); $totalBytes += $read }
          $cur += $take
          $remain -= $take
        }
      }
    }
    $next = [int64]$mbi.BaseAddress + $region
    if ($next -le [int64]$addr) { break }
    $addr = [IntPtr]$next
  }
} finally {
  $fs.Close()
  [void][KkvMemAsv]::CloseHandle($h)
}
Write-Output ("DUMPSTATS commit=$commitCount matched=$matchedCount bytes=$totalBytes")
`;
  fs.writeFileSync(ps1, '\ufeff' + script, 'utf8');
  return ps1;
}

function dumpProcessMemory(pid, timeoutMs = 300000, { privateOnly = true } = {}) {
  return new Promise((resolve) => {
    const dumpPath = path.join(os.tmpdir(), `kk-asv-mem-${pid}${privateOnly ? '-p' : ''}.dmp`);
    try { if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath); } catch { /* ignore */ }
    const ps1 = writeDumpScript(os.tmpdir());
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-TargetPid', String(pid), '-OutFile', dumpPath,
    ];
    if (privateOnly) args.push('-PrivateOnly');
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let stdout = Buffer.concat(out).toString('utf8');
      let stderr = Buffer.concat(err).toString('utf8');
      try {
        stdout = new TextDecoder('gbk').decode(Buffer.concat(out));
        stderr = new TextDecoder('gbk').decode(Buffer.concat(err));
      } catch { /* keep utf8 */ }
      const m = stdout.match(/DUMPSTATS commit=(\d+) matched=(\d+) bytes=(\d+)/);
      const dumpStats = m
        ? { commit: Number(m[1]), matched: Number(m[2]), bytes: Number(m[3]) }
        : null;
      let size = 0;
      try { size = fs.statSync(dumpPath).size; } catch { /* ignore */ }
      if (code !== 0 || size < 1024) {
        return resolve({
          ok: false,
          reason: `内存导出失败：${(stderr || stdout || `exit ${code}`).trim()}`,
          dumpStats,
          size,
          dumpPath,
        });
      }
      resolve({ ok: true, dumpPath, dumpStats, size });
    });
  });
}

module.exports = { dumpProcessMemory };
