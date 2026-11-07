// pass^k: the chance that ALL of k independent runs of a scenario pass.
//
// pass^1 is the usual success rate. pass^k asks a harder question: can you rely on it? A
// scenario that passes 4 runs in 5 has pass^1 = 0.8 but pass^5 = 0. With n runs and c
// passes, the unbiased estimate is C(c, k) / C(n, k), averaged over scenarios (the tau-bench
// definition).

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function passHatK(passes: number, runs: number, k: number): number {
  return choose(passes, k) / choose(runs, k);
}

export function meanPassHatK(perScenario: { passes: number; runs: number }[], k: number): number {
  if (perScenario.length === 0) return 0;
  return perScenario.reduce((s, x) => s + passHatK(x.passes, x.runs, k), 0) / perScenario.length;
}
