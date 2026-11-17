'use strict';
/**
 * Windows：导出 KakaoTalk 进程已提交可读私有内存（PowerShell P/Invoke）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeDumpScript(dir) {
  const ps1 = path.join(dir, 'kk-asv-memdump.ps1');
  const script = `
param([Parameter(Mandatory)]$TargetPid,[Parameter(Mandatory)]$OutFile,[switch]$PrivateOnly)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KkvMem2 {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a,bool b,int p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern int VirtualQueryEx(IntPtr h,IntPtr a,out MEMORY_BASIC_INFORMATION m,uint s);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int n,ref int r);
  [StructLayout(LayoutKind.Sequential)] public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
    public UIntPtr RegionSize; public uint State; public uint Protect; public uint Type;
  }
}
"@
$h = [KkvMem2]::OpenProcess(0x0410, $false, [int]$TargetPid) # QUERY_INFORMATION|VM_READ
if ($h -eq [IntPtr]::Zero) { throw "OpenProcess failed pid=$TargetPid err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$fs = [IO.File]::Create($OutFile)
$buf = New-Object byte[] 1048576
$addr = [IntPtr]::Zero
$commit=0; $matched=0; $totalBytes=0
try {
  while ($true) {
    $mbi = New-Object KkvMem2+MEMORY_BASIC_INFORMATION
    $ret = [KkvMem2]::VirtualQueryEx($h, $addr, [ref]$mbi, [uint32][Runtime.InteropServices.Marshal]::SizeOf($mbi))
    if ($ret -eq 0) { break }
    $region = [int64]$mbi.RegionSize
    if ($region -le 0) { break }
    if ($mbi.State -eq 0x1000 -and $region -le 268435456) {
      $commit++
      $prot = [int]$mbi.Protect
      $readable = (($prot -band 0xEE) -ne 0) -and (($prot -band 0x100) -eq 0) -and ($prot -ne 1)
      $privateOk = (-not $PrivateOnly) -or ($mbi.Type -eq 0x20000)
      if ($readable -and $privateOk) {
        $matched++
        $remain = $region
        $cur = [int64]$mbi.BaseAddress
        while ($remain -gt 0) {
          $take = [int][Math]::Min($remain, $buf.Length)
          $read = 0
          $ok = [KkvMem2]::ReadProcessMemory($h, [IntPtr]$cur, $buf, $take, [ref]$read)
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
  [void][KkvMem2]::CloseHandle($h)
}
Write-Output ("DUMPSTATS commit=$commit matched=$matched bytes=$totalBytes")
`;
  fs.writeFileSync(ps1, '\ufeff' + script, 'utf8');
  return ps1;
}

function dumpProcessMemory(pid, timeoutMs = 300000, { privateOnly = true } = {}) {
  return new Promise((resolve) => {
    const dumpPath = path.join(os.tmpdir(), `kk-asv-mem-${pid}${privateOnly ? '-p' : ''}.dmp`);
    try { if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath); } catch { /* ignore */ }
    const ps1 = writeDumpScript(os.tmpdir());
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-TargetPid', String(pid), '-OutFile', dumpPath];
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
