// Windows process-tree containment via a Win32 Job Object, held by HDO itself and
// reached through `koffi` (FFI) rather than a native addon or inline C#. See
// docs/adr/0002-windows-job-object-via-koffi.md for the full rationale and the
// nested-job experiment this is based on.
//
// `koffi` is imported lazily (`await import("koffi")`) so this module - and anything
// that imports it - never fails to load on a platform where the koffi prebuilt binary
// is unavailable (or on POSIX, where this file is never exercised at all). Every
// Win32 call is wrapped so a failure anywhere in the attach sequence downgrades to
// "containment unavailable" rather than throwing: `NodeProcessRunner` always has a
// working fallback (`platform.killProcessTree`, `taskkill /T /F /PID`).
//
// This module may be imported ONLY from `src/platform/**` (see
// src/core/boundary.test.ts, which forbids `core/**` from reaching into it, and the
// ADR-0001 Migration strategy phase 2 acceptance criteria, which require koffi to
// stay out of `core`).
import type { ProcessContainer } from "./types.ts";

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION information class, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
// PROCESS_TERMINATE | PROCESS_SET_QUOTA - the minimal access mask AssignProcessToJobObject needs.
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101;

interface JobObjectLib {
  createJobObject(): unknown;
  setKillOnCloseLimit(job: unknown): boolean;
  assignProcessToJobObject(job: unknown, processHandle: unknown): boolean;
  terminateJobObject(job: unknown, exitCode: number): boolean;
  openProcess(pid: number): unknown;
  closeHandle(handle: unknown): boolean;
  getLastError(): number;
}

// S-1: caches the LOAD PROMISE itself, not just its resolved outcome. Caching only
// the resolved `cachedLib`/`cachedLoadError` (as an earlier version of this module
// did) leaves a window, on the very first call(s), where two concurrent callers
// both see neither populated yet and both proceed to run the body below - and
// `koffi.struct` throws `Duplicate type name` the second time a struct with the same
// name is declared in the same process (confirmed via `Promise.all` of two
// concurrent `createWindowsProcessContainer` calls). Assigning `cachedLoadPromise`
// synchronously, before the first `await`, means every caller - including ones that
// arrive while the first load is still in flight - gets the SAME in-flight promise
// and the declaration body runs exactly once per process.
let cachedLoadPromise: Promise<{ lib?: JobObjectLib; error?: string }> | undefined;

// S-8: the real `await import("koffi")` failure path (as opposed to a failure
// further inside `performLoad`, e.g. a bad struct declaration) is otherwise only
// reachable on a machine where koffi's platform-specific prebuilt package is
// genuinely missing - not exercisable in CI. Test-only injection point: swapping
// this out (and resetting the cache) lets a test simulate that import rejecting
// without needing an actually-broken koffi install.
let koffiImporter: () => Promise<typeof import("koffi")> = () => import("koffi");

/**
 * Test-only. Overrides the `import("koffi")` call `performLoad` makes and clears the
 * memoized load promise so the very next `createWindowsProcessContainer` call
 * re-runs it against the override. Returns a restore function that puts back BOTH
 * the previous importer AND the previous memoized load promise (not just `undefined`
 * - koffi.struct throws "Duplicate type name" if a real, already-succeeded load's
 * declarations are asked to run again, so restoring must reuse that same resolved
 * promise rather than forcing a second real load).
 */
export function __setKoffiImporterForTests(importer: () => Promise<typeof import("koffi")>): () => void {
  const previousImporter = koffiImporter;
  const previousLoadPromise = cachedLoadPromise;
  koffiImporter = importer;
  cachedLoadPromise = undefined;
  return () => {
    koffiImporter = previousImporter;
    cachedLoadPromise = previousLoadPromise;
  };
}

function loadJobObjectLib(): Promise<{ lib?: JobObjectLib; error?: string }> {
  if (!cachedLoadPromise) cachedLoadPromise = performLoad();
  return cachedLoadPromise;
}

/**
 * Builds the koffi declaration set once per process (koffi itself caches
 * `koffi.load` per-path internally, but re-declaring `koffi.struct`/`koffi.func` with
 * the same names repeatedly is wasted work and, for `struct`, would throw on a
 * duplicate name). Struct layouts are declared via `koffi.struct` (not hard-coded byte
 * offsets/sizes) so this also works correctly on arm64. Only ever invoked through
 * `loadJobObjectLib`'s memoized promise above.
 */
async function performLoad(): Promise<{ lib?: JobObjectLib; error?: string }> {
  let koffi: typeof import("koffi");
  try {
    koffi = await koffiImporter();
  } catch (error) {
    return { error: `koffi could not be loaded: ${(error as Error).message}` };
  }

  try {
    const k32 = koffi.load("kernel32.dll");

    const BASIC = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "size_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32",
    });
    const IO = koffi.struct("IO_COUNTERS", {
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64",
    });
    const EXT = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: BASIC,
      IoInfo: IO,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    });
    const extSize = koffi.sizeof(EXT);

    // N-7: Win32 `BOOL` (and `HANDLE`'s `bInheritHandle` parameter) is a 4-byte `int`,
    // not C99's 1-byte `_Bool` - koffi's `bool` type is the latter, which is not
    // ABI-exact for an `__stdcall` return value/parameter. `int32` matches Win32
    // `BOOL` exactly; `Boolean(...)` below still correctly treats any non-zero int32
    // as true (Win32's own convention for `BOOL`, which is never guaranteed to be
    // exactly `1`).
    const CreateJobObjectW = k32.func("void* __stdcall CreateJobObjectW(void* attrs, const char16_t* name)");
    const SetInformationJobObject = k32.func(
      "int32 __stdcall SetInformationJobObject(void* job, int cls, JOBOBJECT_EXTENDED_LIMIT_INFORMATION* info, uint32_t len)",
    );
    const AssignProcessToJobObject = k32.func("int32 __stdcall AssignProcessToJobObject(void* job, void* process)");
    const TerminateJobObject = k32.func("int32 __stdcall TerminateJobObject(void* job, uint32_t exitCode)");
    const OpenProcess = k32.func("void* __stdcall OpenProcess(uint32_t access, int32 inherit, uint32_t pid)");
    const CloseHandle = k32.func("int32 __stdcall CloseHandle(void* h)");
    const GetLastError = k32.func("uint32_t __stdcall GetLastError()");

    const zeroLimits = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0n,
        PerJobUserTimeLimit: 0n,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0n,
        WriteOperationCount: 0n,
        OtherOperationCount: 0n,
        ReadTransferCount: 0n,
        WriteTransferCount: 0n,
        OtherTransferCount: 0n,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };

    const lib: JobObjectLib = {
      createJobObject: () => CreateJobObjectW(null, null),
      setKillOnCloseLimit: (job) =>
        Boolean(SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, zeroLimits, extSize)),
      assignProcessToJobObject: (job, processHandle) => Boolean(AssignProcessToJobObject(job, processHandle)),
      terminateJobObject: (job, exitCode) => Boolean(TerminateJobObject(job, exitCode)),
      openProcess: (pid) => OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid),
      closeHandle: (handle) => Boolean(CloseHandle(handle)),
      getLastError: () => Number(GetLastError()),
    };
    return { lib };
  } catch (error) {
    return { error: `koffi could not be loaded: ${(error as Error).message}` };
  }
}

function isNullHandle(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

class WindowsJobObjectContainer implements ProcessContainer {
  readonly attached: boolean;
  readonly error: string;
  private job: unknown;
  private readonly lib?: JobObjectLib;
  private disposed = false;

  constructor(attached: boolean, error: string, job?: unknown, lib?: JobObjectLib) {
    this.attached = attached;
    this.error = error;
    this.job = job;
    this.lib = lib;
  }

  /** Immediate termination via `TerminateJobObject`, without releasing the handle. Safe to call more than once. */
  terminate(): void {
    if (!this.attached || this.disposed || isNullHandle(this.job) || !this.lib) return;
    try {
      this.lib.terminateJobObject(this.job, 1);
    } catch {
      // Best-effort: this is one of two independent kill mechanisms (the other being
      // `dispose()`'s KILL_ON_JOB_CLOSE close-handle path); a failure here must not
      // throw out of the caller's kill-tree sequence.
    }
  }

  /**
   * Closes the job handle. Because the job was created with
   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, this alone terminates every process still
   * assigned to it (mirrors PowerShell's `KillOnCloseJob.Dispose()`, which relies on
   * exactly this mechanism rather than calling `TerminateJobObject` at all).
   * Idempotent: safe to call more than once, and safe to call without ever having
   * called `terminate()`.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!isNullHandle(this.job) && this.lib) {
      try {
        this.lib.closeHandle(this.job);
      } catch {
        // Best-effort.
      }
    }
    this.job = undefined;
  }
}

const NOOP_UNAVAILABLE_CONTAINER: ProcessContainer = {
  attached: false,
  error: "",
  terminate(): void {
    // No-op: the caller must fall back to platform.killProcessTree.
  },
  dispose(): void {
    // No-op.
  },
};

/**
 * Spawns (attaches) a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 * around the process identified by `pid`, immediately after the process itself was
 * spawned (NOT `detached`, so libuv's own default job - which the child is already a
 * member of - still protects against the process crashing before this call runs).
 * On any failure, returns a container with `attached: false` and a non-empty `error`
 * that mirrors the equivalent PowerShell `KillOnCloseJob.Error` text where an
 * equivalent Win32 call exists.
 *
 * One necessary divergence from `KillOnCloseJob` (documented in
 * docs/adr/0002-windows-job-object-via-koffi.md): PowerShell attaches directly to an
 * already-open `System.Diagnostics.Process.Handle` obtained from `.NET`'s own process
 * object, so it never needs a separate `OpenProcess` call. This runner only has a PID
 * (from Node's `ChildProcess.pid`), so it must call `OpenProcess` itself to obtain a
 * handle with `PROCESS_SET_QUOTA | PROCESS_TERMINATE` access before
 * `AssignProcessToJobObject` - introducing a `"OpenProcess failed with Win32 error N."`
 * error string that has no PowerShell equivalent, plus a residual spawn-to-assign race
 * (the target process could theoretically exit and its PID be reused by an unrelated
 * process before `OpenProcess` runs) that PowerShell shares in spirit (its own
 * attach-after-spawn window is just narrower, not eliminated) but does not phrase this
 * way.
 */
export async function createWindowsProcessContainer(pid: number): Promise<ProcessContainer> {
  const { lib, error: loadError } = await loadJobObjectLib();
  if (!lib) return { ...NOOP_UNAVAILABLE_CONTAINER, error: loadError ?? "koffi could not be loaded." };

  // N-7: every Win32 call below is wrapped in one try/catch so a koffi type/ABI
  // error (e.g. a struct field declared with the wrong type, or any other error
  // thrown synchronously by koffi's marshalling rather than surfaced as a Win32
  // `BOOL` return) downgrades to `attached: false` with an error string - the same
  // contract as every other failure mode here - instead of rejecting `run()`.
  // Whatever handles were already opened before the throw are best-effort closed.
  let job: unknown;
  let processHandle: unknown;
  try {
    job = lib.createJobObject();
    if (isNullHandle(job)) {
      return { ...NOOP_UNAVAILABLE_CONTAINER, error: `CreateJobObject failed with Win32 error ${lib.getLastError()}.` };
    }

    if (!lib.setKillOnCloseLimit(job)) {
      const error = `SetInformationJobObject failed with Win32 error ${lib.getLastError()}.`;
      lib.closeHandle(job);
      return { ...NOOP_UNAVAILABLE_CONTAINER, error };
    }

    processHandle = lib.openProcess(pid);
    if (isNullHandle(processHandle)) {
      const error = `OpenProcess failed with Win32 error ${lib.getLastError()}.`;
      lib.closeHandle(job);
      return { ...NOOP_UNAVAILABLE_CONTAINER, error };
    }

    try {
      if (!lib.assignProcessToJobObject(job, processHandle)) {
        const error = `AssignProcessToJobObject failed with Win32 error ${lib.getLastError()}.`;
        lib.closeHandle(job);
        return { ...NOOP_UNAVAILABLE_CONTAINER, error };
      }
    } finally {
      lib.closeHandle(processHandle);
      processHandle = undefined; // avoid a redundant double-close from the outer catch below
    }
  } catch (error) {
    try {
      if (!isNullHandle(processHandle)) lib.closeHandle(processHandle);
    } catch {
      // Best-effort.
    }
    try {
      if (!isNullHandle(job)) lib.closeHandle(job);
    } catch {
      // Best-effort.
    }
    return { ...NOOP_UNAVAILABLE_CONTAINER, error: `Windows Job Object attach failed: ${(error as Error).message}` };
  }

  return new WindowsJobObjectContainer(true, "", job, lib);
}
