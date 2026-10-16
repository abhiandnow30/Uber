/**
 * Minimal in-process counters exposed in Prometheus text format at /api/metrics.
 * Replace with OpenTelemetry/Azure Monitor exporters in larger deployments.
 */
const counters = new Map<string, number>();
const startedAt = Date.now();

export const metrics = {
  inc(name: string, by = 1) {
    counters.set(name, (counters.get(name) ?? 0) + by);
  },
  render(gauges: Record<string, number> = {}) {
    const lines: string[] = [];
    lines.push('# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
    const mem = process.memoryUsage();
    lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
    for (const [k, v] of counters) lines.push(`# TYPE cab_${k} counter`, `cab_${k} ${v}`);
    for (const [k, v] of Object.entries(gauges)) lines.push(`# TYPE cab_${k} gauge`, `cab_${k} ${v}`);
    return lines.join('\n') + '\n';
  },
};
