/*
 * Small radix-2 FFT for the SERVICE MODE spectrum view (UI thread only).
 */

/**
 * Hann-windowed magnitude spectrum of the first 2^k samples of `data`
 * (k chosen as the largest power of two that fits). Returns N/2 magnitudes,
 * normalized so a full-scale sine peaks near 1.
 */
export function fftMag(data: Float32Array): Float32Array {
  let n = 1
  while (n * 2 <= data.length) n *= 2
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) // Hann
    re[i] = data[i] * w
  }

  // Bit-reversal permutation.
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

  // Iterative butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1
      let cwi = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j
        const b = i + j + len / 2
        const br = re[b] * cwr - im[b] * cwi
        const bi = re[b] * cwi + im[b] * cwr
        re[b] = re[a] - br
        im[b] = im[a] - bi
        re[a] += br
        im[a] += bi
        const nwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = nwr
      }
    }
  }

  const out = new Float32Array(n / 2)
  const norm = 4 / n // Hann coherent gain (0.5) x 2 for one-sided spectrum
  for (let i = 0; i < n / 2; i++) {
    out[i] = Math.hypot(re[i], im[i]) * norm
  }
  return out
}
