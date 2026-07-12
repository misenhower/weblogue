/* Small dependency-free radix-2 FFT shared by UI spectra and calibration. */

/** Hann-windowed one-sided magnitude spectrum, normalized so a full-scale
 * sine peaks near 1. Uses the largest power-of-two prefix of `data`. */
export function fftMag(data: Float32Array): Float32Array {
  let n = 1
  while (n * 2 <= data.length) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = n === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    re[i] = (data[i] ?? 0) * w
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cwr = 1
      let cwi = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j
        const b = a + len / 2
        const br = re[b] * cwr - im[b] * cwi
        const bi = re[b] * cwi + im[b] * cwr
        re[b] = re[a] - br
        im[b] = im[a] - bi
        re[a] += br
        im[a] += bi
        const nextWr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = nextWr
      }
    }
  }
  const out = new Float32Array(n / 2)
  const norm = 4 / n
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]) * norm
  return out
}
