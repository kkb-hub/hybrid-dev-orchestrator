// Reproduces PowerShell's `[int](<expression>)` cast of a non-integral `double`, which the
// lean worker oracle (workers/hdo-ollama-worker.ps1) uses at several budget/threshold
// computations (e.g. `[int]($ContextTokens * $CompactAtPercent / 100)`,
// `[int]($script:MaxBlockTokens / 2)`). That cast is NOT truncation: PowerShell's numeric
// conversion to `[int]` goes through .NET's `System.Convert.ToInt32(double)`, which rounds
// to the nearest integer using round-half-to-even ("banker's rounding") - halves round to
// whichever neighbour is even, not always up or always down. Verified on a real pwsh:
//   [int](669.5)    -> 670   (670 is even)
//   [int](670.5)    -> 670   (670 is even)
//   [int](20643.84) -> 20644 (not a tie: plain nearest-integer rounding)
//   [int](201.5)    -> 202   (202 is even)
//   [int](202.5)    -> 202   (202 is even)
//
// `Math.trunc` (chop toward zero) and `Math.round` (JS rounds every .5 up, and famously
// gets negative zero and negative halves wrong: `Math.round(-0.5) === -0`,
// `Math.round(2.5) === 3`, neither of which matches .NET's `2`) are both wrong substitutes.
// Every site in this port that mirrors an oracle `[int](<non-integral expression>)` must
// call this helper instead.
export function psInt(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exact tie: round to the even neighbour. `floor % 2` is 0 or ±1 in JS (it preserves the
  // dividend's sign), so comparing to 0 correctly identifies "even" for negative floors too
  // (e.g. floor = -1 for value = -0.5, -1 % 2 === -1, not even, so this returns -1 + 1 = 0 -
  // matching .NET's `Convert.ToInt32(-0.5) == 0`).
  return floor % 2 === 0 ? floor : floor + 1;
}
