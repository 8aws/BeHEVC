// logic.js — funciones puras sin DOM (testeables con node).
// Se carga antes que main.js (quedan como globales) y se exporta para tests.

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function formatEta(seconds) {
  const s = Math.round(seconds);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60)   return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/// Veredicto de una recompresión a partir del ahorro estimado (%) y el VMAF.
/// Umbrales para "Recomendado" configurables: minVmaf y minSavings.
/// Devuelve: 'bad' (no encoge) | 'loss' | 'recommended' | 'notworth' | 'marginal'.
function verdictKey(savings, vmaf, minVmaf, minSavings) {
  if (savings < 0) return 'bad';
  if (vmaf != null && vmaf < minVmaf - 3) return 'loss';
  if (savings >= minSavings && (vmaf == null || vmaf >= minVmaf)) return 'recommended';
  if (savings < minSavings * 0.6) return 'notworth';
  return 'marginal';
}

// Exponer para tests en node sin afectar al navegador
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatBytes, formatEta, verdictKey };
}
