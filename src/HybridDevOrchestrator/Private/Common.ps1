if (-not ('HybridDevOrchestrator.Internal.BoundedProcessCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HybridDevOrchestrator.Internal
{
    public static class FinalPathResolver
    {
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint OpenExisting = 3;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            Microsoft.Win32.SafeHandles.SafeFileHandle handle,
            StringBuilder path,
            uint pathLength,
            uint flags);

        public static string Resolve(string path)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return Path.GetFullPath(path);
            using (Microsoft.Win32.SafeHandles.SafeFileHandle handle = CreateFileW(
                path, 0, 7, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                StringBuilder buffer = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                string result = buffer.ToString();
                if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + result.Substring(8);
                if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
                return result;
            }
        }
    }

    public sealed class StreamCaptureResult
    {
        public long TotalBytes { get; set; }
        public bool LimitExceeded { get; set; }
        public bool Cancelled { get; set; }
        public string Error { get; set; } = "";
        public string Text { get; set; } = "";
    }

    public sealed class ProcessCaptureResult
    {
        public int ExitCode { get; set; }
        public bool TimedOut { get; set; }
        public bool OutputLimitExceeded { get; set; }
        public bool OutputDrainTimedOut { get; set; }
        public string LimitStream { get; set; } = "";
        public string InputError { get; set; } = "";
        public string CaptureError { get; set; } = "";
        public StreamCaptureResult Stdout { get; set; } = new StreamCaptureResult();
        public StreamCaptureResult Stderr { get; set; } = new StreamCaptureResult();
    }

    public static class BoundedProcessCapture
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private sealed class KillOnCloseJob : IDisposable
        {
            private IntPtr handle;
            public string Error { get; private set; } = "";
            public bool Attached { get { return handle != IntPtr.Zero; } }

            public static KillOnCloseJob TryAttach(Process process)
            {
                KillOnCloseJob result = new KillOnCloseJob();
                if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return result;

                IntPtr job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    result.Error = "CreateJobObject failed with Win32 error " + Marshal.GetLastWin32Error() + ".";
                    return result;
                }

                IntPtr information = IntPtr.Zero;
                try
                {
                    JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
                    limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
                    information = Marshal.AllocHGlobal(size);
                    Marshal.StructureToPtr(limits, information, false);
                    if (!SetInformationJobObject(job, 9, information, (uint)size))
                    {
                        result.Error = "SetInformationJobObject failed with Win32 error " + Marshal.GetLastWin32Error() + ".";
                        CloseHandle(job);
                        return result;
                    }
                    if (!AssignProcessToJobObject(job, process.Handle))
                    {
                        result.Error = "AssignProcessToJobObject failed with Win32 error " + Marshal.GetLastWin32Error() + ".";
                        CloseHandle(job);
                        return result;
                    }
                    result.handle = job;
                    return result;
                }
                finally
                {
                    if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
                }
            }

            public void Dispose()
            {
                IntPtr current = Interlocked.Exchange(ref handle, IntPtr.Zero);
                if (current != IntPtr.Zero) CloseHandle(current);
            }
        }

        private static async Task<StreamCaptureResult> PumpAsync(Stream source, string outputPath, long maximumBytes, int tailBytes, CancellationToken cancellationToken)
        {
            FileStream file = null;
            bool writeToFile = !string.IsNullOrEmpty(outputPath);
            MemoryStream memory = null;

            byte[] tail = new byte[Math.Max(1, tailBytes)];
            int tailStart = 0;
            int tailCount = 0;
            long totalBytes = 0;
            bool exceeded = false;
            bool cancelled = false;
            string error = "";
            byte[] buffer = new byte[8192];
            try
            {
                if (writeToFile)
                {
                    string directory = Path.GetDirectoryName(outputPath);
                    if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                    file = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read, 8192, true);
                }
                else
                {
                    memory = new MemoryStream();
                }
                while (true)
                {
                    int read = await source.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
                    if (read == 0) break;
                    long remaining = maximumBytes - totalBytes;
                    int accepted = remaining <= 0 ? 0 : (int)Math.Min((long)read, remaining);
                    if (accepted > 0)
                    {
                        if (file != null) await file.WriteAsync(buffer, 0, accepted, cancellationToken).ConfigureAwait(false);
                        else await memory.WriteAsync(buffer, 0, accepted, cancellationToken).ConfigureAwait(false);
                        for (int index = 0; index < accepted; index++)
                        {
                            if (tailCount < tail.Length)
                            {
                                tail[(tailStart + tailCount) % tail.Length] = buffer[index];
                                tailCount++;
                            }
                            else
                            {
                                tail[tailStart] = buffer[index];
                                tailStart = (tailStart + 1) % tail.Length;
                            }
                        }
                    }
                    totalBytes += read;
                    if (read > accepted) { exceeded = true; break; }
                }
                if (file != null) await file.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { cancelled = true; }
            catch (Exception exception) { error = exception.GetBaseException().Message; }
            finally
            {
                if (file != null) file.Dispose();
            }

            byte[] captured;
            if (memory != null)
            {
                captured = memory.ToArray();
                memory.Dispose();
            }
            else
            {
                captured = new byte[tailCount];
                for (int index = 0; index < tailCount; index++) captured[index] = tail[(tailStart + index) % tail.Length];
            }
            return new StreamCaptureResult { TotalBytes = totalBytes, LimitExceeded = exceeded, Cancelled = cancelled, Error = error, Text = Utf8.GetString(captured) };
        }

        private static async Task WriteInputAsync(Process process, string inputText, CancellationToken cancellationToken)
        {
            try
            {
                if (inputText != null)
                {
                    byte[] bytes = Utf8.GetBytes(inputText);
                    await process.StandardInput.BaseStream.WriteAsync(bytes, 0, bytes.Length, cancellationToken).ConfigureAwait(false);
                    await process.StandardInput.BaseStream.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
            }
            finally { try { process.StandardInput.BaseStream.Dispose(); } catch { } }
        }

        private static async Task<string> WaitForLimitAsync(Task<StreamCaptureResult> stdoutTask, Task<StreamCaptureResult> stderrTask, CancellationToken cancellationToken)
        {
            Task<StreamCaptureResult> first = await Task.WhenAny(stdoutTask, stderrTask).ConfigureAwait(false);
            StreamCaptureResult firstResult = await first.ConfigureAwait(false);
            string firstName = ReferenceEquals(first, stdoutTask) ? "stdout" : "stderr";
            if (!string.IsNullOrEmpty(firstResult.Error)) return "error:" + firstName;
            if (firstResult.LimitExceeded) return "limit:" + firstName;
            Task<StreamCaptureResult> second = ReferenceEquals(first, stdoutTask) ? stderrTask : stdoutTask;
            StreamCaptureResult secondResult = await second.ConfigureAwait(false);
            string secondName = ReferenceEquals(second, stdoutTask) ? "stdout" : "stderr";
            if (!string.IsNullOrEmpty(secondResult.Error)) return "error:" + secondName;
            if (secondResult.LimitExceeded) return "limit:" + secondName;
            try { await Task.Delay(-1, cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            return "";
        }

        private static async Task<string> WaitForInputErrorAsync(Task inputTask, CancellationToken cancellationToken)
        {
            try
            {
                await inputTask.ConfigureAwait(false);
                try { await Task.Delay(-1, cancellationToken).ConfigureAwait(false); }
                catch (OperationCanceledException) { }
                return "";
            }
            catch (Exception exception) { return exception.GetBaseException().Message; }
        }

        private static void KillTree(Process process)
        {
            try { if (!process.HasExited) process.Kill(true); } catch { }
        }

        private static async Task<bool> WaitWithinAsync(Task task, TimeSpan timeout)
        {
            return ReferenceEquals(await Task.WhenAny(task, Task.Delay(timeout)).ConfigureAwait(false), task);
        }

        private static void CloseRedirectedStreams(Process process)
        {
            try { process.StandardInput.BaseStream.Dispose(); } catch { }
            try { process.StandardOutput.BaseStream.Dispose(); } catch { }
            try { process.StandardError.BaseStream.Dispose(); } catch { }
        }

        public static async Task<ProcessCaptureResult> CaptureAsync(Process process, string inputText, string stdoutPath, string stderrPath, long maximumBytes, int tailBytes, int timeoutSeconds, int drainTimeoutSeconds)
        {
            using (KillOnCloseJob processJob = KillOnCloseJob.TryAttach(process))
            using (CancellationTokenSource pumpCancellation = new CancellationTokenSource())
            using (CancellationTokenSource inputCancellation = new CancellationTokenSource())
            using (CancellationTokenSource monitorCancellation = new CancellationTokenSource())
            {
            Task<StreamCaptureResult> stdoutTask = PumpAsync(process.StandardOutput.BaseStream, stdoutPath, maximumBytes, tailBytes, pumpCancellation.Token);
            Task<StreamCaptureResult> stderrTask = PumpAsync(process.StandardError.BaseStream, stderrPath, maximumBytes, tailBytes, pumpCancellation.Token);
            Task inputTask = WriteInputAsync(process, inputText, inputCancellation.Token);
            Task exitTask = process.WaitForExitAsync();
            Task<string> limitTask = WaitForLimitAsync(stdoutTask, stderrTask, monitorCancellation.Token);
            Task<string> inputErrorTask = WaitForInputErrorAsync(inputTask, monitorCancellation.Token);
            Task timeoutTask = Task.Delay(TimeSpan.FromSeconds(timeoutSeconds), monitorCancellation.Token);

            Task winner = await Task.WhenAny(exitTask, limitTask, inputErrorTask, timeoutTask).ConfigureAwait(false);
            bool timedOut = ReferenceEquals(winner, timeoutTask);
            string monitorReason = ReferenceEquals(winner, limitTask) ? await limitTask.ConfigureAwait(false) : "";
            string inputError = ReferenceEquals(winner, inputErrorTask) ? await inputErrorTask.ConfigureAwait(false) : "";
            if (timedOut || !string.IsNullOrEmpty(monitorReason) || !string.IsNullOrEmpty(inputError)) KillTree(process);

            bool processExitTimedOut = false;
            try
            {
                if (!await WaitWithinAsync(exitTask, TimeSpan.FromSeconds(5)).ConfigureAwait(false))
                {
                    processExitTimedOut = true;
                    KillTree(process);
                    await WaitWithinAsync(exitTask, TimeSpan.FromSeconds(2)).ConfigureAwait(false);
                }
                if (exitTask.IsCompleted) await exitTask.ConfigureAwait(false);
            }
            catch { KillTree(process); }

            // A child may inherit redirected handles and outlive the parent. Closing the
            // Windows job here terminates every remaining descendant before stream drain.
            processJob.Dispose();

            inputCancellation.Cancel();
            try { process.StandardInput.BaseStream.Dispose(); } catch { }

            Task pumpsTask = Task.WhenAll(stdoutTask, stderrTask);
            bool outputDrainTimedOut = !await WaitWithinAsync(pumpsTask, TimeSpan.FromSeconds(drainTimeoutSeconds)).ConfigureAwait(false);
            if (outputDrainTimedOut)
            {
                pumpCancellation.Cancel();
                CloseRedirectedStreams(process);
            }
            bool pumpsStopped = await WaitWithinAsync(pumpsTask, TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            StreamCaptureResult stdout = stdoutTask.IsCompletedSuccessfully
                ? stdoutTask.Result
                : new StreamCaptureResult { Error = "stdout pump did not stop after cancellation." };
            StreamCaptureResult stderr = stderrTask.IsCompletedSuccessfully
                ? stderrTask.Result
                : new StreamCaptureResult { Error = "stderr pump did not stop after cancellation." };
            string limitStream = stdout.LimitExceeded ? "stdout" : (stderr.LimitExceeded ? "stderr" : "");
            string captureError = !string.IsNullOrEmpty(stdout.Error) ? "stdout: " + stdout.Error : (!string.IsNullOrEmpty(stderr.Error) ? "stderr: " + stderr.Error : "");
            if (processExitTimedOut) captureError = "process did not exit after termination was requested.";
            else if (outputDrainTimedOut) captureError = "stdout/stderr remained open after the process exited; output capture was cancelled after the drain timeout." + (string.IsNullOrEmpty(processJob.Error) ? "" : " Process-tree containment was unavailable: " + processJob.Error);
            else if (!pumpsStopped) captureError = "stdout/stderr pumps did not stop after cancellation.";
            if (string.IsNullOrEmpty(inputError) && inputTask.IsFaulted) inputError = inputTask.Exception.GetBaseException().Message;
            monitorCancellation.Cancel();
            try { await limitTask.ConfigureAwait(false); } catch (OperationCanceledException) { }
            try { await inputErrorTask.ConfigureAwait(false); } catch (OperationCanceledException) { }

            return new ProcessCaptureResult
            {
                ExitCode = process.HasExited ? process.ExitCode : -1,
                TimedOut = timedOut,
                OutputLimitExceeded = !string.IsNullOrEmpty(limitStream),
                OutputDrainTimedOut = outputDrainTimedOut,
                LimitStream = limitStream,
                InputError = inputError,
                CaptureError = captureError,
                Stdout = stdout,
                Stderr = stderr
            };
            }
        }
    }
}
'@
}

function ConvertTo-HdoHashtable {
    param([Parameter(Mandatory)][AllowNull()]$InputObject)

    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $InputObject.Keys) {
            $result[[string]$key] = ConvertTo-HdoHashtable $InputObject[$key]
        }
        return $result
    }
    # `-is [pscustomobject]` is true for some Extended Type System wrappers,
    # including arrays and scalar values emitted by a pipeline. Only convert a
    # real PSCustomObject; otherwise JSON arrays can become dictionaries such as
    # { Length = 0 } on a second merge.
    if ($InputObject.GetType() -eq [System.Management.Automation.PSCustomObject]) {
        $result = [ordered]@{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-HdoHashtable $property.Value
        }
        return $result
    }
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $items = [object[]]@($InputObject | ForEach-Object { ConvertTo-HdoHashtable $_ })
        Write-Output -NoEnumerate $items
        return
    }
    return $InputObject
}

function Merge-HdoHashtable {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Base,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Override
    )

    $result = ConvertTo-HdoHashtable $Base
    foreach ($key in $Override.Keys) {
        $overrideValue = $Override[$key]
        if ($result.Contains($key) -and
            $result[$key] -is [System.Collections.IDictionary] -and
            $overrideValue -is [System.Collections.IDictionary]) {
            $result[$key] = Merge-HdoHashtable $result[$key] $overrideValue
        }
        else {
            $result[$key] = ConvertTo-HdoHashtable $overrideValue
        }
    }
    return $result
}

$script:HdoConvertFromJsonSupportsDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')

function ConvertFrom-HdoJson {
    # ConvertFrom-Json converts every ISO-8601-shaped string value to [DateTime],
    # regardless of field name or schema. Values carrying a numeric offset (the
    # shape Get-HdoUtcTimestamp produces) come back with Kind=Local, and a
    # subsequent ConvertTo-Json then silently rewrites them into the local time
    # zone and drops fractional-second precision on every read-modify-write round
    # trip (issue #62). `-DateKind String` (pwsh 7.5+) disables that conversion;
    # this wrapper applies it when available and is a no-op fallback otherwise.
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Json,
        [int]$Depth = 100,
        [switch]$AsHashtable,
        [switch]$NoEnumerate
    )

    $parameters = @{ InputObject = $Json; Depth = $Depth; AsHashtable = $AsHashtable; NoEnumerate = $NoEnumerate }
    if ($script:HdoConvertFromJsonSupportsDateKind) { $parameters['DateKind'] = 'String' }
    $converted = ConvertFrom-Json @parameters
    # The output shape must depend on the CALLER's -NoEnumerate switch, not on the
    # runtime type of $converted, so this helper is a true drop-in for
    # ConvertFrom-Json in both modes:
    #   - Without -NoEnumerate, $converted is already the enumerated shape
    #     ConvertFrom-Json produces ([] -> AutomationNull/$null, [x] -> scalar,
    #     [x,y] -> Object[]); a plain `return` re-enumerates it through the
    #     function's own output stream exactly like the cmdlet does, so a
    #     multi-element top-level array unrolls into multiple pipeline objects
    #     instead of being re-wrapped as one (issue #50/#62 stay fixed via
    #     -DateKind String above; this branch does not touch the -NoEnumerate case).
    #   - With -NoEnumerate, $converted is the bare, un-enumerated value (the raw
    #     array, or a single object/scalar/$null). `return ,$converted` wraps it in a
    #     one-element array that `return` unrolls exactly once, so the caller receives
    #     the bare array (not its elements) AND a non-array value stays bare.
    #     `Write-Output -NoEnumerate $converted` would instead wrap every non-array
    #     result in a 1-element List (verified on pwsh 7.6.5) - not a drop-in.
    if ($NoEnumerate) {
        return ,$converted
    }
    return $converted
}

function Read-HdoJsonFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "JSON file was not found: $Path"
    }
    try {
        return ConvertTo-HdoHashtable (ConvertFrom-HdoJson -Json (Get-Content -LiteralPath $Path -Raw) -Depth 100)
    }
    catch {
        throw "Invalid JSON in '$Path': $($_.Exception.Message)"
    }
}

function Test-HdoJsonSchema {
    param(
        [Parameter(Mandatory)][string]$Json,
        [Parameter(Mandatory)][string]$SchemaPath
    )

    try {
        $null = $Json | ConvertFrom-Json -Depth 100
    }
    catch {
        return [ordered]@{ valid = $false; error = "Invalid JSON: $($_.Exception.Message)" }
    }
    if (-not (Get-Command Test-Json -ErrorAction SilentlyContinue)) {
        return [ordered]@{ valid = $false; error = 'PowerShell Test-Json is required for JSON Schema validation.' }
    }
    try {
        $valid = $Json | Test-Json -SchemaFile $SchemaPath -ErrorAction Stop
        if (-not $valid) { return [ordered]@{ valid = $false; error = "Value does not conform to $SchemaPath" } }
    }
    catch {
        return [ordered]@{ valid = $false; error = "Schema validation failed: $($_.Exception.Message)" }
    }
    return [ordered]@{ valid = $true; error = $null }
}

function Test-HdoObjectSchema {
    param(
        [Parameter(Mandatory)][AllowNull()]$Value,
        [Parameter(Mandatory)][string]$SchemaName
    )

    $schemaPath = Join-Path $script:HdoRepositoryRoot "schemas/$SchemaName.schema.json"
    if (-not (Test-Path -LiteralPath $schemaPath -PathType Leaf)) {
        return [ordered]@{ valid = $false; error = "Schema was not found: $schemaPath" }
    }
    return Test-HdoJsonSchema ($Value | ConvertTo-Json -Depth 100 -Compress) $schemaPath
}

function Write-HdoJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowNull()]$Value
    )

    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $temporaryPath -Encoding utf8NoBOM
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Protect-HdoLogFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1024, 1073741824)][long]$MaximumBytes = 33554432
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).redacted"
    try {
        $redacted = Protect-HdoText (Read-HdoBoundedTextFile $Path $MaximumBytes)
        $encoding = [Text.UTF8Encoding]::new($false)
        if ($encoding.GetByteCount($redacted) -gt $MaximumBytes) {
            $characterCount = [Math]::Min($redacted.Length, [int]$MaximumBytes)
            while ($characterCount -gt 0 -and $encoding.GetByteCount($redacted, 0, $characterCount) -gt $MaximumBytes) {
                $characterCount -= [Math]::Max(1, [int][Math]::Ceiling(($encoding.GetByteCount($redacted, 0, $characterCount) - $MaximumBytes) / 4.0))
            }
            $redacted = $redacted.Substring(0, [Math]::Max(0, $characterCount))
        }
        [IO.File]::WriteAllText($temporaryPath, $redacted, $encoding)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Read-HdoBoundedTextFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1024, 1073741824)][long]$MaximumBytes = 33554432
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "File was not found: $Path" }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -gt $MaximumBytes) { throw "File exceeds the HDO output limit of $MaximumBytes bytes: $Path" }
    return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
}

function Get-HdoValue {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Object,
        [Parameter(Mandatory)][string]$Path,
        $Default = $null
    )

    $current = $Object
    foreach ($segment in $Path.Split('.')) {
        if ($current -isnot [System.Collections.IDictionary] -or -not $current.Contains($segment)) {
            return $Default
        }
        $current = $current[$segment]
    }
    return $current
}

function Get-HdoPlatformDirectory {
    param([Parameter(Mandatory)][ValidateSet('UserConfig', 'UserData')][string]$Kind)

    # Preferring the environment variable keeps existing Windows behaviour unchanged
    # (and lets tests redirect APPDATA/LOCALAPPDATA). The .NET known-folder fallback
    # matches the intent of poc/typescript/src/platform/posix.ts `userConfigDir()` /
    # `defaultDataDir()`: UserConfig resolves to $XDG_CONFIG_HOME/~/.config, UserData
    # resolves to $XDG_DATA_HOME/~/.local/share, without any $IsWindows branching
    # here. Note that the PoC `resolveToken` currently routes %APPDATA% to the data
    # dir instead of the config dir; docs/evaluation/powershell-vs-typescript.md
    # flags that PoC shortcut for correction, and this function follows the intended
    # (config-dir) mapping rather than the PoC's current behaviour.
    if ($Kind -eq 'UserConfig') {
        if ($env:APPDATA) { return $env:APPDATA }
        $folder = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
        if ($folder) { return $folder }
        return $null
    }

    if ($env:LOCALAPPDATA) { return $env:LOCALAPPDATA }
    $folder = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::DoNotVerify)
    if ($folder) { return $folder }
    return $null
}

function Expand-HdoPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$RepositoryPath
    )

    $expanded = $Path
    if (-not $env:LOCALAPPDATA -and $expanded -match '(?i)%LOCALAPPDATA%') {
        $directory = Get-HdoPlatformDirectory -Kind UserData
        if (-not $directory) {
            throw "Path '$Path' references %LOCALAPPDATA% but neither the environment variable nor a platform default directory is available."
        }
        # The evaluator returns the already-resolved $directory captured by GetNewClosure();
        # it never re-runs arbitrary logic inside [regex]::Replace, so a failure here throws
        # before Replace is even called instead of surfacing as an opaque
        # "Exception calling Replace with 4 argument(s)" wrapper.
        $expanded = [regex]::Replace($expanded, '%LOCALAPPDATA%', { param($match) $directory }.GetNewClosure(), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    if (-not $env:APPDATA -and $expanded -match '(?i)%APPDATA%') {
        $directory = Get-HdoPlatformDirectory -Kind UserConfig
        if (-not $directory) {
            throw "Path '$Path' references %APPDATA% but neither the environment variable nor a platform default directory is available."
        }
        $expanded = [regex]::Replace($expanded, '%APPDATA%', { param($match) $directory }.GetNewClosure(), [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
    if ($RepositoryPath) { $expanded = $expanded.Replace('{repository}', $RepositoryPath) }
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        $base = if ($RepositoryPath) { $RepositoryPath } else { (Get-Location).Path }
        $expanded = Join-Path $base $expanded
    }
    return [System.IO.Path]::GetFullPath($expanded)
}

function Protect-HdoText {
    param([AllowNull()][AllowEmptyString()][string]$Text)

    if ($null -eq $Text) { return $null }
    $redacted = $Text
    $patterns = @(
        '(?i)(?:ghp_|github_pat_|sk-ant-|sk-proj-|xox[baprs]-)[-A-Za-z0-9_]{12,}',
        '(?i)(authorization\s*:\s*(?:bearer|token)\s+)[^\s"'']+',
        '(?i)("[^"\r\n]*(?:api[_-]?key|token|password|secret|credential)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"',
        '(?i)((?:api[_-]?key|token|password|secret|credential)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|''[^'']*''|[^\s,}]+)'
    )
    foreach ($pattern in $patterns) {
        $redacted = [regex]::Replace($redacted, $pattern, {
            param($match)
            if ($match.Groups.Count -gt 1 -and $match.Groups[1].Success) {
                if ($match.Value.TrimEnd().EndsWith('"')) { return $match.Groups[1].Value + '"[REDACTED]"' }
                return $match.Groups[1].Value + '[REDACTED]'
            }
            return '[REDACTED]'
        })
    }
    return $redacted
}

function Protect-HdoObject {
    param([Parameter(Mandatory)][AllowNull()]$InputObject)

    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $InputObject.Keys) {
            if ([string]$key -match '(?i)(?:token|secret|password|credential|api[_-]?key)') {
                $result[[string]$key] = '[REDACTED]'
            }
            else {
                $result[[string]$key] = Protect-HdoObject $InputObject[$key]
            }
        }
        return $result
    }
    if ($InputObject.GetType() -eq [System.Management.Automation.PSCustomObject]) {
        return Protect-HdoObject (ConvertTo-HdoHashtable $InputObject)
    }
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $items = [object[]]@($InputObject | ForEach-Object { Protect-HdoObject $_ })
        Write-Output -NoEnumerate $items
        return
    }
    if ($InputObject -is [string]) { return Protect-HdoText $InputObject }
    return $InputObject
}

function Get-HdoSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-HdoUtcTimestamp {
    # [DateTime]::UtcNow (Kind=Utc) formats with 'o' as a Z-suffixed string
    # ("2026-09-06T11:35:51.2262005Z"), which ConvertFrom-Json/ConvertTo-HdoJson
    # round-trips byte for byte. [DateTimeOffset]::UtcNow.ToString('o') instead
    # produces a "+00:00" numeric-offset string, which ConvertFrom-Json parses as
    # Kind=Local and then ConvertTo-Json silently rewrites into the local time
    # zone on the next save (issue #62).
    return [DateTime]::UtcNow.ToString('o')
}

function New-HdoRunId {
    param([int]$IssueNumber)

    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
    if ($IssueNumber -gt 0) { return "issue-$IssueNumber-$stamp-$suffix" }
    return "run-$stamp-$suffix"
}

function Get-HdoSafeEnvironment {
    param([string[]]$PassEnvironment = @())

    $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $PassEnvironment) { [void]$allowed.Add($name) }

    $blockedNames = @(
        'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY',
        'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN', 'NPM_TOKEN', 'PYPI_TOKEN'
    )
    $environment = [ordered]@{}
    foreach ($entry in Get-ChildItem Env:) {
        if ($blockedNames -contains $entry.Name -and -not $allowed.Contains($entry.Name)) { continue }
        if ($entry.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)$' -and -not $allowed.Contains($entry.Name)) { continue }
        $environment[$entry.Name] = $entry.Value
    }
    return $environment
}

function Invoke-HdoProgressAction {
    param(
        [AllowNull()][scriptblock]$Action,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Event
    )

    if (-not $Action) { return }
    try { $null = & $Action (Protect-HdoObject $Event) }
    catch {
        # Progress is an observability channel. A closed parent stream must not turn a
        # process that is still producing durable artifacts into a failed HDO run.
    }
}

function Invoke-HdoProcess {
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [AllowNull()][string]$InputText,
        [ValidateRange(1, 86400)][int]$TimeoutSeconds = 900,
        [System.Collections.IDictionary]$Environment,
        [string]$StandardOutputPath,
        [string]$StandardErrorPath,
        [ValidateRange(1024, 1073741824)][long]$MaximumOutputBytes = 33554432,
        [ValidateRange(1024, 1048576)][int]$OutputTailBytes = 65536,
        [ValidateRange(1, 60)][int]$OutputDrainSeconds = 2,
        [ValidateRange(0, 3600)][int]$ProgressIntervalSeconds = 30,
        [scriptblock]$ActivityCallback,
        [switch]$ThrowOnError
    )

    # -CommandType Application excludes ExternalScript (.ps1). PowerShell's provider
    # resolution order returns a .ps1 shim before its sibling .cmd/.exe when both exist on
    # PATH (e.g. an npm-global install lays down <name>, <name>.cmd, and <name>.ps1), and
    # ProcessStartInfo cannot start a .ps1 directly -- it throws "is not a valid
    # application for this OS platform" at spawn time instead of a clear "not found"
    # (issue #35).
    $resolvedCommand = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolvedCommand) { throw "Command was not found: $Command" }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedCommand.Source
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
    if ($null -ne $Environment) {
        $startInfo.Environment.Clear()
        foreach ($key in $Environment.Keys) { $startInfo.Environment[[string]$key] = [string]$Environment[$key] }
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $startedAt = [DateTimeOffset]::UtcNow
    if (-not $process.Start()) { throw "Failed to start command: $Command" }

    try {
        $captureTask = [HybridDevOrchestrator.Internal.BoundedProcessCapture]::CaptureAsync(
            $process,
            $InputText,
            $(if ($StandardOutputPath) { [IO.Path]::GetFullPath($StandardOutputPath) } else { $null }),
            $(if ($StandardErrorPath) { [IO.Path]::GetFullPath($StandardErrorPath) } else { $null }),
            $MaximumOutputBytes,
            $OutputTailBytes,
            $TimeoutSeconds,
            $OutputDrainSeconds
        )
        if ($ActivityCallback -and $ProgressIntervalSeconds -gt 0) {
            while (-not $captureTask.IsCompleted) {
                try { $completed = $captureTask.Wait([TimeSpan]::FromSeconds($ProgressIntervalSeconds)) }
                catch { break }
                if ($completed) { break }
                $now = [DateTimeOffset]::UtcNow
                Invoke-HdoProgressAction $ActivityCallback ([ordered]@{
                    type = 'process.heartbeat'
                    at = $now.ToString('o')
                    startedAt = $startedAt.ToString('o')
                    elapsedSeconds = [int][Math]::Floor(($now - $startedAt).TotalSeconds)
                })
            }
        }
        $capture = $captureTask.GetAwaiter().GetResult()
    }
    finally { $process.Dispose() }

    $exitCode = if ($capture.TimedOut) { 124 } elseif ($capture.OutputLimitExceeded) { 125 } elseif ($capture.InputError) { 126 } elseif ($capture.CaptureError) { 127 } else { $capture.ExitCode }

    $result = [ordered]@{
        command = $Command
        arguments = @($Arguments)
        exitCode = $exitCode
        timedOut = [bool]$capture.TimedOut
        outputLimitExceeded = [bool]$capture.OutputLimitExceeded
        outputLimitStream = [string]$capture.LimitStream
        outputDrainTimedOut = [bool]$capture.OutputDrainTimedOut
        maximumOutputBytes = $MaximumOutputBytes
        stdoutBytes = [long]$capture.Stdout.TotalBytes
        stderrBytes = [long]$capture.Stderr.TotalBytes
        stdoutPath = $StandardOutputPath
        stderrPath = $StandardErrorPath
        startedAt = $startedAt.ToString('o')
        endedAt = Get-HdoUtcTimestamp
        durationMs = [int]([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds
        stdout = Protect-HdoText ([string]$capture.Stdout.Text)
        stderr = Protect-HdoText ([string]$capture.Stderr.Text)
    }
    if ($capture.InputError) { $result.stderr = Protect-HdoText "Failed to write process input: $($capture.InputError)" }
    if ($capture.CaptureError) { $result.stderr = Protect-HdoText "Failed to capture process output: $($capture.CaptureError)" }
    if ($capture.OutputLimitExceeded) {
        $result.stderr = Protect-HdoText "Process $($capture.LimitStream) exceeded the HDO output limit of $MaximumOutputBytes bytes."
    }
    if ($ThrowOnError -and $exitCode -ne 0) {
        $detail = if ($result.stderr) { $result.stderr.Trim() } else { $result.stdout.Trim() }
        throw "Command '$Command' failed with exit code $exitCode. $detail"
    }
    return $result
}
