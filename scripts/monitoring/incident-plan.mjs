// Keep the failure reporter independent of npm installation.
export function incidentPlan(results, existing) {
  // Skipped checks are unknown; they must never resolve an existing incident.
  return results.filter(result => result.status !== 'skip').map(result => {
    const title = `[monitoring] ${result.key}`;
    const issues = existing.filter(issue => issue.title === title);
    return { title, result, issues, action: result.status === 'fail' ? (issues.length ? 'update' : 'open') : 'close' };
  });
}
